-- 167: permissions must be explicit even on a Supabase install that grants
-- broad default table privileges. Existing drawer/slug tests exercise RPCs.
BEGIN;
SELECT plan(10);
SELECT ok(has_table_privilege('authenticated', 'drawer_opens', 'SELECT'), 'owner can read scoped drawer events');
SELECT ok(has_table_privilege('authenticated', 'location_slugs', 'SELECT'), 'owner can read own location slug');
SELECT ok(NOT has_table_privilege('authenticated', 'drawer_opens', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'drawer writes and administrative privileges denied to client');
SELECT ok(NOT has_table_privilege('authenticated', 'location_slugs', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'slug writes and administrative privileges denied to client');
SELECT ok(NOT has_table_privilege('anon', 'drawer_opens', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'anonymous drawer table access denied');
SELECT ok(NOT has_table_privilege('anon', 'location_slugs', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'anonymous slug table access denied');
SELECT ok((SELECT bool_and(has_table_privilege('service_role', t, p))
  FROM unnest(ARRAY['drawer_opens','location_slugs']) t,
       unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p), 'service role retains all table privileges');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.oid IN ('drawer_opens'::regclass, 'location_slugs'::regclass) AND a.grantee = 0
), 'PUBLIC cannot reintroduce implicit client privileges');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid='drawer_opens'::regclass), 'drawer RLS retained');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid='location_slugs'::regclass), 'slug RLS retained');
SELECT * FROM finish();
ROLLBACK;
