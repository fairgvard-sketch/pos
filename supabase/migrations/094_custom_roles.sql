-- ============================================================
-- 094 CUSTOM ROLES — именованные наборы прав вместо трёх фиксированных ролей.
--
-- Задача: владелец создаёт свои роли («Старший бариста», «Кассир») и галочками
-- отмечает разрешённые действия. До 094 роль — строка из трёх вариантов, а
-- права настраивались одной осью на точку: 'all' или 'manager'.
--
-- ── Почему НЕ заменяем staff.role внешним ключом ────────────
-- staff.role читают require_staff_perm (090), assert_timesheet_manager (027),
-- клиентские can()/навигационные guard'ы и PIN-сессия. Замена колонки на FK
-- потребовала бы синхронной правки всего этого на живом проде с историей.
-- Вместо этого роль становится НАДСТРОЙКОЙ:
--   * staff.role остаётся как есть — базовый уровень (owner/manager/barista);
--   * staff.role_id (опционально) ссылается на кастомную роль с набором прав.
-- Если role_id IS NULL — поведение прежнее, байт-в-байт. Откат = обнулить
-- role_id, никаких обратных миграций данных.
--
-- ── Модель разрешения права ─────────────────────────────────
-- 1) owner — может всё, всегда (роль его не ограничивает: иначе владелец
--    запирает сам себя, а восстановить доступ из бэкофиса будет нечем);
-- 2) есть кастомная роль → право разрешено, если ключ входит в roles.perms;
-- 3) роли нет → прежняя логика: perms точки ('all' | 'manager') + база.
--
-- 'manage' (управление сотрудниками, настройками, ролями) в кастомные роли
-- НЕ выдаётся сознательно: иначе носитель такой роли создаёт себе роль с
-- любыми правами и обходит модель. Он остаётся только у owner/manager.
--
-- ⚠️ ТРЕБУЕТ 090 (строгий require_staff_perm).
-- ============================================================

CREATE TABLE roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- Базовый уровень: с чем роль сопоставима, если право не описано явно.
  -- 'owner' недоступен — владельца назначают только сменой staff.role.
  base       TEXT NOT NULL DEFAULT 'barista' CHECK (base IN ('manager', 'barista')),
  -- Разрешённые действия: ["refund","discount",...]. Ключи те же, что в
  -- locations.settings.perms (src/lib/perms.ts). 'manage' сюда не попадает —
  -- фильтруется на записи в save_role().
  perms      JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_roles_org ON roles(org_id);
CREATE UNIQUE INDEX idx_roles_org_name ON roles(org_id, LOWER(name));

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES roles(id) ON DELETE SET NULL;

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

-- Чтение — своя организация (нужно и кассе для can(), и бэкофису).
-- Запись только через RPC: прямых INSERT/UPDATE-грантов нет.
CREATE POLICY roles_select ON roles FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

REVOKE ALL ON roles FROM anon, authenticated;
GRANT SELECT ON roles TO authenticated;
GRANT ALL ON roles TO service_role;
GRANT SELECT(role_id) ON staff TO authenticated;

COMMENT ON TABLE roles IS
  'Именованные наборы прав (094). Надстройка над staff.role: role_id IS NULL = прежнее поведение.';
COMMENT ON COLUMN roles.perms IS
  'JSON-массив разрешённых ключей прав; ''manage'' исключён сознательно (эскалация привилегий).';

-- ── Право по кастомной роли ─────────────────────────────────
-- Вынесено отдельной функцией, чтобы require_staff_perm остался читаемым,
-- а логика была переиспользуема (клиент читает roles напрямую по RLS).
CREATE OR REPLACE FUNCTION role_allows(p_role_id UUID, p_perm TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT r.perms ? p_perm FROM roles r WHERE r.id = p_role_id),
    FALSE
  );
$$;

REVOKE EXECUTE ON FUNCTION role_allows FROM anon, public;
GRANT EXECUTE ON FUNCTION role_allows(UUID, TEXT) TO authenticated;

-- ── require_staff_perm: + ветка кастомной роли ──────────────
-- Тело 090 сохранено полностью (строгая проверка сессии, скользящее
-- продление, фолбэк-уровни 055). Добавлена ТОЛЬКО ветка role_id.
CREATE OR REPLACE FUNCTION require_staff_perm(p_session UUID, p_perm TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff staff%ROWTYPE;
  v_level TEXT;
BEGIN
  -- СТРОГИЙ режим (045, восстановлен 090): без токена — отказ.
  IF p_session IS NULL THEN
    RAISE EXCEPTION 'staff session required';
  END IF;

  SELECT s.* INTO v_staff
  FROM staff_sessions ss
  JOIN staff s ON s.id = ss.staff_id
  WHERE ss.token = p_session
    AND ss.org_id = auth_org_id()
    AND ss.revoked_at IS NULL
    AND ss.expires_at > NOW()
    AND s.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff session invalid';
  END IF;

  -- Скользящее продление: активная сессия не протухает посреди смены
  UPDATE staff_sessions
  SET expires_at = GREATEST(expires_at, NOW() + INTERVAL '72 hours')
  WHERE token = p_session;

  -- Владелец не ограничивается ролью: иначе он запрёт сам себя
  IF v_staff.role = 'owner' THEN
    RETURN v_staff.id;
  END IF;

  -- НОВОЕ (094): кастомная роль — источник истины для своих ключей.
  -- 'manage' сюда не попадает (save_role его вырезает), поэтому управление
  -- сотрудниками кастомной ролью получить нельзя.
  IF v_staff.role_id IS NOT NULL AND p_perm <> 'manage' THEN
    IF role_allows(v_staff.role_id, p_perm) THEN
      RETURN v_staff.id;
    END IF;
    RAISE EXCEPTION 'forbidden: %', p_perm;
  END IF;

  -- Фолбэк-уровни из 055: stock_take тоже менеджерский
  v_level := COALESCE(
    (SELECT l.settings #>> ARRAY['perms', p_perm] FROM locations l WHERE l.id = auth_location_id()),
    CASE p_perm WHEN 'refund' THEN 'manager' WHEN 'manage' THEN 'manager'
                WHEN 'stock_take' THEN 'manager' ELSE 'all' END
  );

  IF v_level = 'manager' AND v_staff.role NOT IN ('manager', 'owner') THEN
    RAISE EXCEPTION 'forbidden: %', p_perm;
  END IF;

  RETURN v_staff.id;
END $$;

REVOKE EXECUTE ON FUNCTION require_staff_perm FROM anon, public;

-- ── save_role: создание и правка роли ───────────────────────
-- Право — единый гейт 091 ('manage'), то есть владелец бэкофиса без PIN
-- либо manager-сессия кассы.
CREATE OR REPLACE FUNCTION save_role(
  p_name    TEXT,
  p_base    TEXT,
  p_perms   JSONB,
  p_role_id UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_id    UUID;
  v_perms JSONB;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  IF COALESCE(TRIM(p_name), '') = '' THEN
    RAISE EXCEPTION 'role name required';
  END IF;
  IF p_base NOT IN ('manager', 'barista') THEN
    RAISE EXCEPTION 'invalid base role';
  END IF;
  IF jsonb_typeof(p_perms) <> 'array' THEN
    RAISE EXCEPTION 'perms must be a json array';
  END IF;

  -- Отсекаем 'manage' и неизвестные ключи: роль не должна раздавать
  -- управление сотрудниками и не должна копить мусорные права.
  SELECT COALESCE(jsonb_agg(value), '[]'::JSONB) INTO v_perms
  FROM jsonb_array_elements_text(p_perms) AS value
  WHERE value IN ('discount', 'price_edit', 'refund', 'void_order', 'close_shift',
                  'cash_movement', 'online_pause', 'stock_receive', 'stock_take');

  IF p_role_id IS NULL THEN
    INSERT INTO roles (org_id, name, base, perms)
    VALUES (v_org, TRIM(p_name), p_base, v_perms)
    RETURNING id INTO v_id;
  ELSE
    UPDATE roles SET name = TRIM(p_name), base = p_base, perms = v_perms
    WHERE id = p_role_id AND org_id = v_org
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'role not found';
    END IF;
  END IF;

  RETURN v_id;
END $$;

REVOKE EXECUTE ON FUNCTION save_role FROM anon, public;
GRANT EXECUTE ON FUNCTION save_role(TEXT, TEXT, JSONB, UUID, UUID) TO authenticated;

-- ── delete_role ─────────────────────────────────────────────
-- Роль удаляется всегда: staff.role_id ON DELETE SET NULL вернёт носителей
-- к базовому поведению (staff.role сохранён), доступ не потеряется.
CREATE OR REPLACE FUNCTION delete_role(
  p_role_id UUID,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  DELETE FROM roles WHERE id = p_role_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION delete_role FROM anon, public;
GRANT EXECUTE ON FUNCTION delete_role(UUID, UUID) TO authenticated;

-- ── update_staff: + назначение роли ─────────────────────────
-- Тело 093 сохранено; добавлен ключ role_id в allow-лист патча.
CREATE OR REPLACE FUNCTION update_staff(
  p_staff_id UUID,
  p_patch    JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor  TEXT;
  v_target TEXT;
  v_role_id UUID;
BEGIN
  v_actor := current_actor_role(p_staff_session);
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  IF p_patch ? 'role' AND (p_patch ->> 'role') NOT IN ('owner', 'manager', 'barista') THEN
    RAISE EXCEPTION 'invalid role';
  END IF;

  SELECT role INTO v_target FROM staff WHERE id = p_staff_id AND org_id = auth_org_id();
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'staff not found';
  END IF;

  -- Строку владельца правит только владелец; повысить до владельца — тоже
  IF v_actor IS DISTINCT FROM 'owner'
     AND (v_target = 'owner' OR (p_patch ->> 'role') = 'owner') THEN
    RAISE EXCEPTION 'only owner can modify owner';
  END IF;

  -- Роль должна принадлежать той же организации (иначе чужой набор прав)
  IF p_patch ? 'role_id' AND (p_patch ->> 'role_id') IS NOT NULL THEN
    v_role_id := (p_patch ->> 'role_id')::UUID;
    IF NOT EXISTS (SELECT 1 FROM roles WHERE id = v_role_id AND org_id = auth_org_id()) THEN
      RAISE EXCEPTION 'role not in organization';
    END IF;
  END IF;

  UPDATE staff SET
    name      = CASE WHEN p_patch ? 'name' THEN p_patch ->> 'name' ELSE name END,
    role      = CASE WHEN p_patch ? 'role' THEN p_patch ->> 'role' ELSE role END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch ->> 'is_active')::BOOLEAN ELSE is_active END,
    role_id   = CASE WHEN p_patch ? 'role_id' THEN (p_patch ->> 'role_id')::UUID ELSE role_id END
  WHERE id = p_staff_id AND org_id = auth_org_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION update_staff FROM anon, public;
GRANT EXECUTE ON FUNCTION update_staff(UUID, JSONB, UUID) TO authenticated;

-- ── verify_staff_pin: + role_id и набор прав в payload ──────
-- Без этого клиент кассы не узнаёт о кастомной роли и продолжает прятать
-- кнопки по старой логике: сервер бы разрешил, а UI не показал. Тело 044
-- сохранено, добавлены две колонки в RETURNS TABLE и в RETURN QUERY.
DROP FUNCTION IF EXISTS verify_staff_pin(TEXT);

CREATE FUNCTION verify_staff_pin(p_pin TEXT)
RETURNS TABLE (id UUID, name TEXT, role TEXT, location_id UUID, session_token UUID,
               role_id UUID, role_perms JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_staff staff%ROWTYPE;
  v_token UUID;
BEGIN
  SELECT s.* INTO v_staff
  FROM staff s
  WHERE s.org_id = auth_org_id()
    AND s.is_active
    AND (s.location_id IS NULL OR s.location_id = auth_location_id())
    AND s.pin_hash = crypt(p_pin, s.pin_hash)
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Гигиена: сессии не финансовые записи, протухшие удаляем
  DELETE FROM staff_sessions
  WHERE org_id = auth_org_id() AND expires_at < NOW() - INTERVAL '7 days';

  INSERT INTO staff_sessions (staff_id, org_id, location_id)
  VALUES (v_staff.id, v_staff.org_id, auth_location_id())
  RETURNING token INTO v_token;

  RETURN QUERY SELECT v_staff.id, v_staff.name, v_staff.role, v_staff.location_id, v_token,
                      v_staff.role_id,
                      (SELECT r.perms FROM roles r WHERE r.id = v_staff.role_id);
END $$;

REVOKE EXECUTE ON FUNCTION verify_staff_pin FROM anon, public;
GRANT EXECUTE ON FUNCTION verify_staff_pin(TEXT) TO authenticated;

COMMENT ON FUNCTION role_allows(UUID, TEXT) IS
  'Разрешает ли кастомная роль действие. Владелец и ''manage'' проверяются отдельно в require_staff_perm.';
