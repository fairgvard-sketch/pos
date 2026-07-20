-- ============================================================
-- 091 BACKOFFICE WRITE FOUNDATION — фундамент записи из веб-кабинета.
--
-- До 091 управляющие RPC (меню, настройки, сотрудники, склад) принимали
-- только PIN-сессию (require_staff_perm, строгий режим 090). Веб-владелец
-- входит паролем и PIN не имеет — писать не мог.
--
-- Модель как у Square: один человек — один аккаунт с ролью, два входа
-- (Dashboard/пароль и POS/PIN). У нас человек-владелец живёт в двух местах:
-- строка owner в staff (для PIN) и строка в organization_members (для веба).
-- 091 их СВЯЗЫВАЕТ, чтобы действие из веба подписывалось той же staff-строкой,
-- что и с терминала — аудит остаётся однородным.
--
-- Что делает:
--   1) organization_members.staff_id — необязательная ссылка на staff.
--      Заполняется для существующих владельцев автоматически (по org + role);
--      если staff-строки нет, связь остаётся NULL — не блокирующе.
--   2) require_backoffice_or_staff(p_session, p_perm) — единый гейт записи:
--      сперва пускает владельца/менеджера бэкофиса (без PIN), иначе —
--      прежний require_staff_perm. Возвращает UUID «автора» операции:
--      связанный staff_id, а если связи нет — NULL (вызывающий сам решает,
--      как пометить бэкофис-автора; для настроек автор в аудит не пишется).
--   3) assert_backoffice_location(p_location_id) — веб-владелец выбирает
--      точку явно (в токене location_id нет). Проверяет принадлежность точки
--      организации владельца; для не-владельца тихо возвращает управление
--      (проверку сделает require_staff_perm по auth_location_id из токена).
--
-- ⚠️ ТРЕБУЕТ 088 (organization_members, auth_backoffice_role) и 090 (строгий
-- require_staff_perm).
-- ============================================================

ALTER TABLE organization_members
  ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

-- Существующие владельцы: связать с их owner-строкой в staff той же org.
-- Только когда owner-строка ровно одна — иначе связь неоднозначна, оставляем
-- NULL (заполнится явно позже через управление командой).
UPDATE organization_members m
SET staff_id = s.id
FROM staff s
WHERE m.staff_id IS NULL
  AND m.role = 'owner'
  AND s.org_id = m.org_id
  AND s.role = 'owner'
  AND s.is_active
  AND (SELECT COUNT(*) FROM staff s2
       WHERE s2.org_id = m.org_id AND s2.role = 'owner' AND s2.is_active) = 1;

-- ── Единый гейт записи для веб-кабинета и кассы ──────────────
CREATE OR REPLACE FUNCTION require_backoffice_or_staff(p_session UUID, p_perm TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    TEXT := auth_backoffice_role();
  v_member  organization_members%ROWTYPE;
BEGIN
  -- Веб-владелец/менеджер: право даёт членство, PIN не нужен.
  IF v_role IN ('owner', 'manager') THEN
    SELECT * INTO v_member
    FROM organization_members
    WHERE auth_user_id = auth.uid()
      AND org_id = auth_org_id()
      AND is_active
    LIMIT 1;
    -- Автор операции — связанная staff-строка (может быть NULL, если владелец
    -- ещё не заведён как сотрудник; вызывающий решает, как это пометить).
    RETURN v_member.staff_id;
  END IF;

  -- Иначе прежний путь: PIN-сессия сотрудника (строгий режим 090).
  RETURN require_staff_perm(p_session, p_perm);
END $$;

REVOKE EXECUTE ON FUNCTION require_backoffice_or_staff FROM anon, public;
GRANT EXECUTE ON FUNCTION require_backoffice_or_staff(UUID, TEXT) TO authenticated;

-- ── Проверка выбора точки веб-владельцем ─────────────────────
-- Веб-владелец адресует точку параметром (в JWT её нет). Функция валидирует,
-- что точка принадлежит его организации. Для НЕ-бэкофис-вызова (касса) — тихо
-- пропускает: точку там определяет auth_location_id() из токена устройства.
CREATE OR REPLACE FUNCTION assert_backoffice_location(p_location_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth_backoffice_role() IS NULL THEN
    RETURN; -- не веб-контекст: точку проверяет RLS/токен устройства
  END IF;

  IF p_location_id IS NULL THEN
    RAISE EXCEPTION 'location required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM locations
    WHERE id = p_location_id AND org_id = auth_org_id()
  ) THEN
    RAISE EXCEPTION 'location not in organization';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION assert_backoffice_location FROM anon, public;
GRANT EXECUTE ON FUNCTION assert_backoffice_location(UUID) TO authenticated;

COMMENT ON COLUMN organization_members.staff_id IS
  'Связь веб-идентичности с staff-строкой того же человека — автор бэкофис-операций в аудите (модель Square: один аккаунт, два входа).';

-- ── Настройки точки из веб-кабинета ─────────────────────────
-- Веб-версия patch_location_settings: точка приходит параметром (в JWT её нет),
-- право — через единый гейт (владелец бэкофиса ИЛИ manage-сессия кассы).
-- Логика merge идентична кассовой (064): известные разделы-объекты мержатся
-- поключево, прочие верхнеуровневые ключи присваиваются целиком.
CREATE OR REPLACE FUNCTION patch_location_settings_web(
  p_location_id UUID,
  p_patch       JSONB,
  p_staff_session UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cur  JSONB;
  v_next JSONB;
  v_key  TEXT;
  v_allowed TEXT[] := ARRAY['perms','receipt','shift','online_orders','reservations','tips','pay_methods','quick_amounts','interface'];
BEGIN
  PERFORM assert_backoffice_location(p_location_id);
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  IF jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a json object';
  END IF;

  -- Блокируем строку точки на время merge — исключаем гонку read-modify-write
  SELECT COALESCE(settings, '{}'::jsonb) INTO v_cur
  FROM locations WHERE id = p_location_id AND org_id = auth_org_id() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'location not in organization';
  END IF;

  v_next := v_cur;
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key = ANY(v_allowed)
       AND jsonb_typeof(v_next -> v_key) = 'object'
       AND jsonb_typeof(p_patch -> v_key) = 'object' THEN
      v_next := jsonb_set(v_next, ARRAY[v_key], (v_next -> v_key) || (p_patch -> v_key));
    ELSE
      v_next := jsonb_set(v_next, ARRAY[v_key], p_patch -> v_key);
    END IF;
  END LOOP;

  UPDATE locations SET settings = v_next WHERE id = p_location_id;
  RETURN v_next;
END $$;

REVOKE EXECUTE ON FUNCTION patch_location_settings_web FROM anon, public;
GRANT EXECUTE ON FUNCTION patch_location_settings_web(UUID, JSONB, UUID) TO authenticated;
