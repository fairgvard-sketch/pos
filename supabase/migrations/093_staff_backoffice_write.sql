-- ============================================================
-- 093 STAFF BACKOFFICE WRITE — управление командой из веб-кабинета.
--
-- До 093 управление сотрудниками (create_staff/update_staff/set_staff_pin/
-- delete_staff) принимало только PIN-сессию (require_staff_perm, строгий
-- режим 090). Веб-владелец входит паролем и PIN не имеет — раздел «Команда»
-- в бэкофисе не мог писать вообще.
--
-- Как в 092: тела скопированы из текущего определения (044) БЕЗ изменений,
-- кроме строки гейта — require_staff_perm → require_backoffice_or_staff (091).
-- Для кассы поведение идентично: гейт для не-владельца вызывает тот же
-- require_staff_perm со строгой проверкой сессии.
--
-- Отличие от 092 (меню): меню org-scoped, а сотрудник привязан к точке, и в
-- токене веб-владельца location_id НЕТ. Поэтому create_staff дополнительно
-- прогоняет p_location_id через assert_backoffice_location (091) — веб-владелец
-- обязан назвать точку своей организации, касса (auth_backoffice_role() IS
-- NULL) проходит проверку молча и работает как раньше.
--
-- Ролевая защита: 044 не давала менеджеру трогать владельца — эта проверка
-- была ТОЛЬКО клиентской (StaffSection.canEdit). Веб-кабинет — второй клиент,
-- поэтому правило переносится в БД: не-владелец не может создать владельца,
-- повысить до владельца, править или удалить строку владельца. Так менеджер
-- не может выписать себе owner-права ни из кассы, ни из браузера.
--
-- ⚠️ ТРЕБУЕТ 091 (require_backoffice_or_staff, assert_backoffice_location).
-- ============================================================

-- ── Кто действует: роль автора операции ──────────────────────
-- Владелец бэкофиса → его роль в organization_members; касса → роль staff-строки
-- активной PIN-сессии. Нужна, чтобы «только владелец трогает владельца»
-- работало одинаково в обоих контурах.
CREATE OR REPLACE FUNCTION current_actor_role(p_session UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := auth_backoffice_role();
BEGIN
  IF v_role IS NOT NULL THEN
    RETURN v_role;
  END IF;

  -- Касса: роль сотрудника активной PIN-сессии. Условия те же, что в
  -- require_staff_perm (090) — иначе роль могла бы прийти из отозванной
  -- или протухшей сессии. NULL здесь не опасен: следом вызывается сам
  -- require_staff_perm, который на невалидной сессии бросает исключение.
  RETURN (
    SELECT s.role
    FROM staff_sessions ss
    JOIN staff s ON s.id = ss.staff_id
    WHERE ss.token = p_session
      AND ss.org_id = auth_org_id()
      AND ss.revoked_at IS NULL
      AND ss.expires_at > NOW()
      AND s.is_active
    LIMIT 1
  );
END $$;

REVOKE EXECUTE ON FUNCTION current_actor_role FROM anon, public;
GRANT EXECUTE ON FUNCTION current_actor_role(UUID) TO authenticated;

-- ── create_staff: гейт 091 + явная точка + защита роли owner ─
CREATE OR REPLACE FUNCTION create_staff(
  p_name        TEXT,
  p_role        TEXT,
  p_pin         TEXT,
  p_location_id UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_id  UUID;
  v_actor TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Веб-владелец называет точку явно (в его JWT location_id нет); касса —
  -- проходит молча, точку определяет токен устройства.
  PERFORM assert_backoffice_location(p_location_id);

  v_actor := current_actor_role(p_staff_session);
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  IF p_role NOT IN ('owner', 'manager', 'barista') THEN
    RAISE EXCEPTION 'invalid role';
  END IF;
  -- Владельца заводит только владелец (раньше — только клиентская проверка)
  IF p_role = 'owner' AND v_actor IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only owner can assign owner role';
  END IF;
  IF p_pin !~ '^\d{4,8}$' THEN
    RAISE EXCEPTION 'PIN must be 4-8 digits';
  END IF;

  INSERT INTO staff (org_id, location_id, name, role, pin_hash)
  VALUES (v_org, p_location_id, p_name, p_role, crypt(p_pin, gen_salt('bf')))
  RETURNING staff.id INTO v_id;

  RETURN v_id;
END $$;

REVOKE EXECUTE ON FUNCTION create_staff FROM anon, public;
GRANT EXECUTE ON FUNCTION create_staff(TEXT, TEXT, TEXT, UUID, UUID) TO authenticated;

-- ── update_staff: гейт 091 + защита строки owner ─────────────
CREATE OR REPLACE FUNCTION update_staff(
  p_staff_id UUID,
  p_patch    JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor  TEXT;
  v_target TEXT;
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

  UPDATE staff SET
    name      = CASE WHEN p_patch ? 'name' THEN p_patch ->> 'name' ELSE name END,
    role      = CASE WHEN p_patch ? 'role' THEN p_patch ->> 'role' ELSE role END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch ->> 'is_active')::BOOLEAN ELSE is_active END
  WHERE id = p_staff_id AND org_id = auth_org_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION update_staff FROM anon, public;
GRANT EXECUTE ON FUNCTION update_staff(UUID, JSONB, UUID) TO authenticated;

-- ── set_staff_pin: гейт 091 + защита строки owner ────────────
CREATE OR REPLACE FUNCTION set_staff_pin(
  p_staff_id UUID,
  p_pin      TEXT,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_actor  TEXT;
  v_target TEXT;
BEGIN
  v_actor := current_actor_role(p_staff_session);
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  IF p_pin !~ '^\d{4,8}$' THEN
    RAISE EXCEPTION 'PIN must be 4-8 digits';
  END IF;

  SELECT role INTO v_target FROM staff WHERE id = p_staff_id AND org_id = auth_org_id();
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'staff not found';
  END IF;
  -- Иначе менеджер перевыпустил бы PIN владельца и вошёл под ним
  IF v_target = 'owner' AND v_actor IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only owner can modify owner';
  END IF;

  UPDATE staff
  SET pin_hash = crypt(p_pin, gen_salt('bf'))
  WHERE id = p_staff_id AND org_id = auth_org_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION set_staff_pin FROM anon, public;
GRANT EXECUTE ON FUNCTION set_staff_pin(UUID, TEXT, UUID) TO authenticated;

-- ── delete_staff: гейт 091 + защита строки owner ─────────────
-- Проверка «есть записи» не меняется: сотрудник с историей не удаляется
-- никогда (аудит священен) — вместо удаления клиент предлагает деактивацию.
CREATE OR REPLACE FUNCTION delete_staff(
  p_staff_id UUID,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_actor  TEXT;
  v_target TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  v_actor := current_actor_role(p_staff_session);
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  SELECT role INTO v_target FROM staff WHERE id = p_staff_id AND org_id = v_org;
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'staff not found';
  END IF;
  IF v_target = 'owner' AND v_actor IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only owner can modify owner';
  END IF;

  -- Любая ссылка на сотрудника из аудируемых таблиц блокирует удаление.
  -- (Авторство платежа — через orders, отдельной payments.staff_id нет.)
  IF EXISTS (SELECT 1 FROM orders         WHERE staff_id    = p_staff_id)
     OR EXISTS (SELECT 1 FROM orders       WHERE voided_by   = p_staff_id)
     OR EXISTS (SELECT 1 FROM orders       WHERE refunded_by = p_staff_id)
     OR EXISTS (SELECT 1 FROM refunds      WHERE staff_id    = p_staff_id)
     OR EXISTS (SELECT 1 FROM shifts       WHERE opened_by   = p_staff_id)
     OR EXISTS (SELECT 1 FROM shifts       WHERE closed_by   = p_staff_id)
     OR EXISTS (SELECT 1 FROM time_entries WHERE staff_id    = p_staff_id)
     OR EXISTS (SELECT 1 FROM cash_movements WHERE staff_id  = p_staff_id)
  THEN
    RAISE EXCEPTION 'staff has records';
  END IF;

  DELETE FROM staff WHERE id = p_staff_id AND org_id = v_org;
END $$;

REVOKE EXECUTE ON FUNCTION delete_staff FROM anon, public;
GRANT EXECUTE ON FUNCTION delete_staff(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION current_actor_role(UUID) IS
  'Роль автора операции: членство в бэкофисе (веб) или роль staff активной PIN-сессии (касса).';
