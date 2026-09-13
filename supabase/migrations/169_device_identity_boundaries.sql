-- A6.2: an unexpired JWT is not proof that a device account still exists.
-- Preserve the digital membership and legacy PIN models; archive is cosmetic.
-- Only revoked/deleted/banned device identities lose their existing claims.
CREATE OR REPLACE FUNCTION auth_org_id()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org UUID := NULLIF(auth.jwt()->'app_metadata'->>'org_id','')::UUID;
  v_location UUID := NULLIF(auth.jwt()->'app_metadata'->>'location_id','')::UUID;
BEGIN
  IF current_setting('role', TRUE) = 'authenticated' THEN
    IF v_location IS NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.organization_members m
        WHERE m.org_id=v_org AND m.auth_user_id=auth.uid() AND m.is_active
      ) THEN RETURN NULL; END IF;
    ELSE
      -- delete_device_web removes dedicated Auth users. PostgREST validates
      -- JWT signature/expiry, not account liveness; check the authority here.
      IF NOT EXISTS (
        SELECT 1 FROM auth.users u WHERE u.id=auth.uid()
          AND (u.banned_until IS NULL OR u.banned_until<=NOW())
      ) OR NOT EXISTS (
        SELECT 1 FROM public.locations l WHERE l.id=v_location AND l.org_id=v_org
      ) THEN RETURN NULL; END IF;
    END IF;
  END IF;
  RETURN v_org;
END $$;
REVOKE ALL ON FUNCTION auth_org_id() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION auth_org_id() TO authenticated,service_role;

-- Location-only RLS/RPCs must not keep using the deleted account's claim.
-- Trusted server/operator calls retain the existing claim-reader semantics.
CREATE OR REPLACE FUNCTION auth_location_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN current_setting('role',TRUE)='authenticated' AND public.auth_org_id() IS NULL
    THEN NULL ELSE NULLIF(auth.jwt()->'app_metadata'->>'location_id','')::UUID END
$$;

-- A UUID is a lookup key, not permission to claim another Auth user's device.
-- Same account + location retries remain idempotent; distinct physical devices
-- may still share one account by using different device_uuid values.
CREATE OR REPLACE FUNCTION register_device(
  p_device_uuid UUID,
  p_name TEXT DEFAULT NULL,
  p_settings JSONB DEFAULT NULL,
  p_app_version TEXT DEFAULT NULL,
  p_webview_version TEXT DEFAULT NULL,
  p_printer_capabilities JSONB DEFAULT NULL
) RETURNS devices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
  v_uid UUID := auth.uid();
  v_row devices;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_device_uuid IS NULL THEN RAISE EXCEPTION 'device_uuid_required'; END IF;
  INSERT INTO devices (
    org_id,location_id,device_uuid,auth_user_id,name,settings,
    app_version,webview_version,printer_capabilities,last_seen_at
  ) VALUES (
    v_org,v_loc,p_device_uuid,v_uid,COALESCE(p_name,'Касса'),COALESCE(p_settings,'{}'::jsonb),
    p_app_version,p_webview_version,p_printer_capabilities,NOW()
  )
  ON CONFLICT (org_id,device_uuid) DO UPDATE SET
    name=COALESCE(p_name,devices.name),
    settings=devices.settings||COALESCE(p_settings,'{}'::jsonb),
    app_version=COALESCE(p_app_version,devices.app_version),
    webview_version=COALESCE(p_webview_version,devices.webview_version),
    printer_capabilities=COALESCE(p_printer_capabilities,devices.printer_capabilities),
    last_seen_at=NOW()
  WHERE devices.auth_user_id=v_uid AND devices.location_id=v_loc
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'device_identity_conflict'; END IF;
  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION register_device(UUID,TEXT,JSONB,TEXT,TEXT,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION register_device(UUID,TEXT,JSONB,TEXT,TEXT,JSONB) TO authenticated,service_role;

-- UUID-only FK does not guarantee that a device's location is in its tenant.
-- No historical records are rewritten; apply to new/changed identity fields.
CREATE FUNCTION check_device_tenant_reference()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.locations l WHERE l.id=NEW.location_id AND l.org_id=NEW.org_id) THEN
    RAISE EXCEPTION 'device_location_not_in_org' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION check_device_tenant_reference() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER device_tenant_reference BEFORE INSERT OR UPDATE OF org_id,location_id ON devices
  FOR EACH ROW EXECUTE FUNCTION check_device_tenant_reference();
