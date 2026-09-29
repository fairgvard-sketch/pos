-- pgTAP: публичный каталог заведений ANGLE Guest (173).
BEGIN;
SELECT plan(12);

SELECT has_table('restaurant_directory_profiles', 'directory profile table exists');
SELECT has_column('restaurant_directory_profiles', 'location_id');
SELECT has_column('restaurant_directory_profiles', 'is_published');
SELECT has_column('restaurant_directory_profiles', 'demo_rating');
SELECT has_column('restaurant_directory_profiles', 'demo_rating_count');

SELECT ok(
  NOT has_table_privilege('anon', 'restaurant_directory_profiles', 'SELECT,INSERT,UPDATE,DELETE'),
  'anonymous guest cannot enumerate or mutate directory rows directly'
);
SELECT ok(
  has_table_privilege('authenticated', 'restaurant_directory_profiles', 'SELECT'),
  'authenticated organization can read its own directory profile'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'restaurant_directory_profiles', 'INSERT,UPDATE,DELETE'),
  'authenticated client cannot self-publish by direct DML'
);

INSERT INTO orgs (id, name) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'Directory org A'),
  ('d0000000-0000-4000-8000-000000000002', 'Directory org B');
INSERT INTO locations (id, org_id, name) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Directory loc A'),
  ('d1000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'Directory loc B');
INSERT INTO auth.users (id, raw_app_meta_data) VALUES
  ('d4000000-0000-4000-8000-000000000001', '{"org_id":"d0000000-0000-4000-8000-000000000001"}');
INSERT INTO organization_members (org_id, auth_user_id, role) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'owner');

INSERT INTO restaurant_directory_profiles (
  location_id, org_id, is_published, demo_rating, demo_rating_count
) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', TRUE, 4.8, 320),
  ('d1000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', TRUE, NULL, NULL);

SELECT throws_ok($$
  UPDATE restaurant_directory_profiles
  SET demo_rating_count = NULL
  WHERE location_id = 'd1000000-0000-4000-8000-000000000001'
$$, '23514', NULL, 'demo rating and count must be stored as a pair');

SELECT throws_ok($$
  UPDATE restaurant_directory_profiles
  SET demo_rating = 5.5
  WHERE location_id = 'd1000000-0000-4000-8000-000000000001'
$$, '23514', NULL, 'demo rating remains inside the 1..5 range');

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"d0000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM restaurant_directory_profiles),
  1,
  'RLS exposes only profiles from the active organization'
);
SELECT is(
  (SELECT location_id FROM restaurant_directory_profiles LIMIT 1),
  'd1000000-0000-4000-8000-000000000001'::UUID,
  'the visible directory row belongs to the active organization'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
