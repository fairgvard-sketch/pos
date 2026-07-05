-- ============================================================
-- 001 FOUNDATION — organizations, locations, devices, staff
--
-- Auth model:
--   * Устройство (планшет/касса) логинится через Supabase Auth
--     (email+password, один раз при настройке устройства).
--   * org_id / location_id лежат в app_metadata JWT — их ставит
--     bootstrap_org() при онбординге. RLS читает их из токена.
--   * Сотрудники переключаются PIN-кодом ВНУТРИ приложения:
--     verify_staff_pin() сверяет bcrypt-хеш, PIN не покидает БД.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- ORGS
-- ============================================================
CREATE TABLE orgs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- LOCATIONS (точки: кофейня, пекарня...)
-- ============================================================
CREATE TABLE locations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'ILS',
  -- НДС в процентах; Израиль 2026 = 18. Хранится здесь, снапшотится в заказ.
  vat_rate   NUMERIC(5,2) NOT NULL DEFAULT 18.00,
  timezone   TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DEVICES (зарегистрированные кассы/планшеты)
-- ============================================================
CREATE TABLE devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id   UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ
);

-- ============================================================
-- STAFF (PIN — только bcrypt-хеш, никогда открытым текстом)
-- ============================================================
CREATE TABLE staff (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- NULL = сотрудник доступен на всех точках организации
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'barista')),
  pin_hash    TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_locations_org ON locations(org_id);
CREATE INDEX idx_devices_org   ON devices(org_id);
CREATE INDEX idx_staff_org     ON staff(org_id);

-- ============================================================
-- JWT HELPERS — источник истины для RLS
-- ============================================================
CREATE OR REPLACE FUNCTION auth_org_id()
RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF((auth.jwt() -> 'app_metadata') ->> 'org_id', '')::UUID
$$;

CREATE OR REPLACE FUNCTION auth_location_id()
RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF((auth.jwt() -> 'app_metadata') ->> 'location_id', '')::UUID
$$;

-- ============================================================
-- ROW LEVEL SECURITY — всё скоупится на org из JWT
-- ============================================================
ALTER TABLE orgs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices   ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff     ENABLE ROW LEVEL SECURITY;

CREATE POLICY orgs_select ON orgs FOR SELECT TO authenticated
  USING (id = auth_org_id());
CREATE POLICY orgs_update ON orgs FOR UPDATE TO authenticated
  USING (id = auth_org_id());

CREATE POLICY locations_all ON locations FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());

CREATE POLICY devices_all ON devices FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());

CREATE POLICY staff_select ON staff FOR SELECT TO authenticated
  USING (org_id = auth_org_id());
CREATE POLICY staff_update ON staff FOR UPDATE TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());

-- pin_hash не должен утекать на клиент: колоночные гранты.
-- (RLS решает "какие строки", гранты — "какие колонки".)
REVOKE SELECT, INSERT, UPDATE ON staff FROM authenticated;
GRANT SELECT (id, org_id, location_id, name, role, is_active, created_at)
  ON staff TO authenticated;
GRANT UPDATE (name, role, location_id, is_active)
  ON staff TO authenticated;

-- ============================================================
-- ONBOARDING: bootstrap_org()
-- Вызывается один раз новым auth-аккаунтом: создаёт организацию,
-- точку, владельца и прописывает org_id в app_metadata токена.
-- ============================================================
CREATE OR REPLACE FUNCTION bootstrap_org(
  p_org_name      TEXT,
  p_location_name TEXT,
  p_owner_name    TEXT,
  p_owner_pin     TEXT
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_org UUID;
  v_loc UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = v_uid AND raw_app_meta_data ? 'org_id'
  ) THEN
    RAISE EXCEPTION 'org already bootstrapped for this account';
  END IF;
  IF p_owner_pin !~ '^\d{4,8}$' THEN
    RAISE EXCEPTION 'PIN must be 4-8 digits';
  END IF;

  INSERT INTO orgs (name) VALUES (p_org_name) RETURNING id INTO v_org;
  INSERT INTO locations (org_id, name)
    VALUES (v_org, p_location_name) RETURNING id INTO v_loc;
  INSERT INTO staff (org_id, location_id, name, role, pin_hash)
    VALUES (v_org, NULL, p_owner_name, 'owner', crypt(p_owner_pin, gen_salt('bf')));

  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', v_org, 'location_id', v_loc)
  WHERE id = v_uid;

  RETURN json_build_object('org_id', v_org, 'location_id', v_loc);
END $$;

REVOKE EXECUTE ON FUNCTION bootstrap_org FROM anon, public;

-- ============================================================
-- PIN-ВХОД СОТРУДНИКА: verify_staff_pin()
-- Возвращает сотрудника при совпадении PIN, иначе пустой результат.
-- ============================================================
CREATE OR REPLACE FUNCTION verify_staff_pin(p_pin TEXT)
RETURNS TABLE (id UUID, name TEXT, role TEXT, location_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.name, s.role, s.location_id
  FROM staff s
  WHERE s.org_id = auth_org_id()
    AND s.is_active
    AND (s.location_id IS NULL OR s.location_id = auth_location_id())
    AND s.pin_hash = crypt(p_pin, s.pin_hash);
END $$;

REVOKE EXECUTE ON FUNCTION verify_staff_pin FROM anon, public;

-- ============================================================
-- УПРАВЛЕНИЕ СОТРУДНИКАМИ (PIN задаётся только через RPC)
-- ============================================================
CREATE OR REPLACE FUNCTION create_staff(
  p_name        TEXT,
  p_role        TEXT,
  p_pin         TEXT,
  p_location_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_id  UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_pin !~ '^\d{4,8}$' THEN
    RAISE EXCEPTION 'PIN must be 4-8 digits';
  END IF;

  INSERT INTO staff (org_id, location_id, name, role, pin_hash)
  VALUES (v_org, p_location_id, p_name, p_role, crypt(p_pin, gen_salt('bf')))
  RETURNING staff.id INTO v_id;

  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION set_staff_pin(p_staff_id UUID, p_pin TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF p_pin !~ '^\d{4,8}$' THEN
    RAISE EXCEPTION 'PIN must be 4-8 digits';
  END IF;

  UPDATE staff
  SET pin_hash = crypt(p_pin, gen_salt('bf'))
  WHERE id = p_staff_id AND org_id = auth_org_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION create_staff  FROM anon, public;
REVOKE EXECUTE ON FUNCTION set_staff_pin FROM anon, public;
