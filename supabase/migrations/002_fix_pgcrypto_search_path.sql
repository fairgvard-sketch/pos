-- ============================================================
-- 002 FIX — pgcrypto в Supabase живёт в схеме extensions,
-- а функции были созданы с search_path = public, из-за чего
-- gen_salt()/crypt() не находились. Пересоздаём функции
-- с search_path = public, extensions.
-- (Для чистых установок 001 уже исправлена; эта миграция
-- нужна базам, где 001 применили до фикса.)
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
