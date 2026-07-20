-- 088: Back office identities.
--
-- A Supabase user can manage an organisation from the ANGLE back office.
-- POS staff still authenticate inside the terminal with a PIN; this table is
-- only for owner/manager web identities and must never contain staff PINs.

CREATE TABLE IF NOT EXISTS organization_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'accountant')),
  display_name TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, auth_user_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_members_user
  ON organization_members(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_org
  ON organization_members(org_id);

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;

-- Existing installations used the Supabase Auth identity both to bootstrap
-- the organisation and to enrol the first terminal. Preserve that account as
-- the initial owner so enabling the back office cannot lock anybody out.
INSERT INTO organization_members (org_id, auth_user_id, role, display_name)
SELECT
  (u.raw_app_meta_data ->> 'org_id')::UUID,
  u.id,
  'owner',
  COALESCE(NULLIF(u.raw_user_meta_data ->> 'full_name', ''), split_part(u.email, '@', 1))
FROM auth.users u
JOIN orgs o ON o.id::TEXT = LOWER(u.raw_app_meta_data ->> 'org_id')
WHERE u.raw_app_meta_data ? 'org_id'
  AND (u.raw_app_meta_data ->> 'org_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
ON CONFLICT (org_id, auth_user_id) DO NOTHING;

-- Kept as a SECURITY DEFINER helper so policies on organization_members do not
-- recursively query the same table.
CREATE OR REPLACE FUNCTION auth_backoffice_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.role
  FROM organization_members m
  WHERE m.auth_user_id = auth.uid()
    AND m.org_id = auth_org_id()
    AND m.is_active
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth_backoffice_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION auth_backoffice_role() TO authenticated;

CREATE POLICY organization_members_select_self
  ON organization_members
  FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid() AND org_id = auth_org_id());

CREATE POLICY organization_members_select_org_admin
  ON organization_members
  FOR SELECT
  TO authenticated
  USING (
    org_id = auth_org_id()
    AND auth_backoffice_role() IN ('owner', 'manager')
  );

REVOKE ALL ON organization_members FROM anon, authenticated;
GRANT SELECT (
  id, org_id, auth_user_id, role, display_name, is_active, created_at, updated_at
) ON organization_members TO authenticated;

-- A compact bootstrap payload for the web back office. The function verifies
-- membership first and never accepts an org id from the browser.
CREATE OR REPLACE FUNCTION get_backoffice_context()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_org       UUID := auth_org_id();
  v_member    organization_members%ROWTYPE;
  v_payload   JSONB;
BEGIN
  IF v_uid IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_member
  FROM organization_members
  WHERE auth_user_id = v_uid
    AND org_id = v_org
    AND is_active
  LIMIT 1;

  IF v_member.id IS NULL THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;

  SELECT jsonb_build_object(
    'member', jsonb_build_object(
      'id', v_member.id,
      'role', v_member.role,
      'display_name', v_member.display_name
    ),
    'organization', jsonb_build_object(
      'id', o.id,
      'name', o.name
    ),
    'locations', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', l.id,
          'name', l.name,
          'currency', l.currency,
          'timezone', l.timezone
        ) ORDER BY l.created_at
      )
      FROM locations l
      WHERE l.org_id = o.id
    ), '[]'::JSONB),
    'counts', jsonb_build_object(
      'locations', (SELECT COUNT(*) FROM locations l WHERE l.org_id = o.id),
      'staff', (SELECT COUNT(*) FROM staff s WHERE s.org_id = o.id AND s.is_active),
      'devices', (SELECT COUNT(*) FROM devices d WHERE d.org_id = o.id)
    )
  ) INTO v_payload
  FROM orgs o
  WHERE o.id = v_org;

  RETURN v_payload;
END;
$$;

REVOKE ALL ON FUNCTION get_backoffice_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_backoffice_context() TO authenticated;

COMMENT ON TABLE organization_members IS
  'Owner and manager web identities for ANGLE back office; POS staff remain PIN based.';
