-- A4: one bootstrap per Auth identity, including concurrent digital/POS calls.
-- Preserve the legacy signatures/errors; the new cabinet RPC adds a durable
-- client-generated request receipt. No product, trial or subscription is granted.

CREATE OR REPLACE FUNCTION lock_bootstrap_account()
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  PERFORM 1 FROM auth.users WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not authenticated'; END IF;
  RETURN v_uid;
END $$;
REVOKE ALL ON FUNCTION lock_bootstrap_account() FROM PUBLIC, anon, authenticated, service_role;

-- Move unchanged 104 bodies behind private entry points, as in the capability
-- wrappers. A caller cannot bypass the lock by invoking the old bodies directly.
ALTER FUNCTION bootstrap_org(TEXT, TEXT, TEXT, TEXT, TEXT) RENAME TO bootstrap_org_unlocked_165;
ALTER FUNCTION bootstrap_digital_org(TEXT, TEXT, TEXT, TEXT[]) RENAME TO bootstrap_digital_org_unlocked_165;
REVOKE ALL ON FUNCTION bootstrap_org_unlocked_165(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION bootstrap_digital_org_unlocked_165(TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION bootstrap_org(
  p_org_name TEXT, p_location_name TEXT, p_owner_name TEXT, p_owner_pin TEXT,
  p_business_address TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM lock_bootstrap_account();
  RETURN bootstrap_org_unlocked_165(p_org_name, p_location_name, p_owner_name, p_owner_pin, p_business_address);
END $$;
REVOKE ALL ON FUNCTION bootstrap_org(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bootstrap_org(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

CREATE FUNCTION bootstrap_digital_org(
  p_org_name TEXT, p_location_name TEXT, p_owner_name TEXT DEFAULT NULL,
  p_products TEXT[] DEFAULT ARRAY['menu']
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM lock_bootstrap_account();
  RETURN bootstrap_digital_org_unlocked_165(p_org_name, p_location_name, p_owner_name, p_products);
END $$;
REVOKE ALL ON FUNCTION bootstrap_digital_org(TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bootstrap_digital_org(TEXT, TEXT, TEXT, TEXT[]) TO authenticated, service_role;

CREATE TABLE digital_workspace_requests (
  request_id UUID PRIMARY KEY,
  auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (auth_user_id)
);
ALTER TABLE digital_workspace_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON digital_workspace_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON digital_workspace_requests TO service_role;

CREATE FUNCTION create_digital_workspace(
  p_request_id UUID, p_org_name TEXT, p_location_name TEXT,
  p_products TEXT[] DEFAULT ARRAY['menu']
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID;
  v_request JSONB;
  v_receipt digital_workspace_requests;
  v_result JSONB;
  v_products TEXT[];
BEGIN
  v_uid := lock_bootstrap_account();
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'workspace_request_id_required'; END IF;
  SELECT COALESCE(array_agg(DISTINCT p ORDER BY p), '{}') INTO v_products
    FROM unnest(p_products) p WHERE p IN ('menu', 'online_orders', 'reservations');
  v_request := jsonb_build_object('org_name', TRIM(p_org_name),
    'location_name', TRIM(p_location_name), 'products', to_jsonb(v_products));

  SELECT * INTO v_receipt FROM digital_workspace_requests WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.auth_user_id <> v_uid OR v_receipt.request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'workspace_request_conflict';
    END IF;
    -- A receipt does not resurrect a deleted workspace or revoked membership.
    IF NOT EXISTS (
      SELECT 1 FROM organization_members m JOIN auth.users u ON u.id = m.auth_user_id
      WHERE m.auth_user_id = v_uid AND m.org_id = (v_receipt.result ->> 'org_id')::UUID
        AND m.is_active AND m.role = 'owner'
        AND u.raw_app_meta_data ->> 'org_id' = m.org_id::TEXT
    ) THEN RAISE EXCEPTION 'workspace_no_longer_available'; END IF;
    RETURN v_receipt.result;
  END IF;

  v_result := bootstrap_digital_org(p_org_name, p_location_name, NULL, v_products)::JSONB;
  INSERT INTO digital_workspace_requests(request_id, auth_user_id, request, result)
    VALUES (p_request_id, v_uid, v_request, v_result);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION create_digital_workspace(UUID, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_digital_workspace(UUID, TEXT, TEXT, TEXT[]) TO authenticated, service_role;

COMMENT ON FUNCTION create_digital_workspace(UUID, TEXT, TEXT, TEXT[]) IS
  '165: atomic digital onboarding with an account-bound request UUID; retries return the original result, never grant products.';
COMMENT ON TABLE digital_workspace_requests IS
  '165: private onboarding receipts; no client read/write. Server-authorized replay only.';
COMMENT ON FUNCTION bootstrap_org(TEXT, TEXT, TEXT, TEXT, TEXT) IS
  '165: legacy POS bootstrap serialized with digital bootstrap on the Auth user row; no entitlement grants.';
COMMENT ON FUNCTION bootstrap_digital_org(TEXT, TEXT, TEXT, TEXT[]) IS
  '165: legacy digital bootstrap serialized on the Auth user row. Repeated legacy calls retain the already-bootstrapped error.';
