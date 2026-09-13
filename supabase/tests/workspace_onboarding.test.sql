-- 165: replay, access control, atomicity and compatibility. Concurrency is
-- exercised separately by scripts/test-onboarding-concurrency.mjs on a disposable DB.
BEGIN;
SELECT plan(20);
SELECT ok(NOT has_function_privilege('anon', 'create_digital_workspace(uuid,text,text,text[])', 'EXECUTE'), 'anon cannot bootstrap');
SELECT ok(has_function_privilege('authenticated', 'create_digital_workspace(uuid,text,text,text[])', 'EXECUTE'), 'authenticated can use guarded RPC');
SELECT ok(NOT has_table_privilege('authenticated', 'digital_workspace_requests', 'SELECT,INSERT,UPDATE,DELETE'), 'receipts are private');
SELECT ok(NOT has_function_privilege('authenticated', 'bootstrap_digital_org_unlocked_165(text,text,text,text[])', 'EXECUTE'), 'digital lock cannot be bypassed');
SELECT ok(NOT has_function_privilege('authenticated', 'bootstrap_org_unlocked_165(text,text,text,text,text)', 'EXECUTE'), 'POS lock cannot be bypassed');
SELECT ok(NOT has_function_privilege('authenticated', 'lock_bootstrap_account()', 'EXECUTE'), 'lock helper is private');

INSERT INTO auth.users(id, email) VALUES
  ('71000000-0000-4000-8000-000000000001', 'workspace-a@example.test'),
  ('71000000-0000-4000-8000-000000000002', 'workspace-b@example.test');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT lives_ok($$ SELECT create_digital_workspace('72000000-0000-4000-8000-000000000001', 'A4 Cafe', 'A4 Main', ARRAY['menu','pos']) $$, 'owner creates a workspace');
SELECT lives_ok($$ SELECT create_digital_workspace('72000000-0000-4000-8000-000000000001', ' A4 Cafe ', 'A4 Main', ARRAY['menu','menu']) $$, 'same normalized request replays');
SELECT throws_ok($$ SELECT create_digital_workspace('72000000-0000-4000-8000-000000000001', 'Changed', 'A4 Main', ARRAY['menu']) $$, 'P0001', 'workspace_request_conflict', 'same key cannot change the request');
SELECT throws_ok($$ SELECT create_digital_workspace('72000000-0000-4000-8000-000000000002', 'Second', 'Main', ARRAY['menu']) $$, 'P0001', 'org already bootstrapped for this account', 'different key cannot create another org');
RESET ROLE;
SELECT is((SELECT count(*)::INT FROM orgs WHERE name = 'A4 Cafe'), 1, 'one organization');
SELECT is((SELECT count(*)::INT FROM locations WHERE org_id = (SELECT (result->>'org_id')::UUID FROM digital_workspace_requests WHERE request_id = '72000000-0000-4000-8000-000000000001')), 1, 'one location');
SELECT is((SELECT count(*)::INT FROM organization_members WHERE auth_user_id = '71000000-0000-4000-8000-000000000001'), 1, 'one owner membership');
SELECT is((SELECT count(*)::INT FROM organization_products WHERE org_id = (SELECT (result->>'org_id')::UUID FROM digital_workspace_requests WHERE request_id = '72000000-0000-4000-8000-000000000001')), 0, 'no product or trial granted');
SELECT is((SELECT array_agg(product) FROM product_activation_requests WHERE requested_by = '71000000-0000-4000-8000-000000000001'), ARRAY['menu'], 'only a digital interest request');
SELECT is((SELECT count(*)::INT FROM digital_workspace_requests WHERE auth_user_id = '71000000-0000-4000-8000-000000000001'), 1, 'one durable receipt');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SELECT throws_ok($$ SELECT create_digital_workspace('72000000-0000-4000-8000-000000000001', 'A4 Cafe', 'A4 Main', ARRAY['menu']) $$, 'P0001', 'workspace_request_conflict', 'other user cannot replay the receipt');
SELECT throws_ok($$ SELECT create_digital_workspace('72000000-0000-4000-8000-000000000003', ' ', 'Main', ARRAY['menu']) $$, 'P0001', 'invalid_name', 'invalid request rolls back');
RESET ROLE;
SELECT is((SELECT count(*)::INT FROM digital_workspace_requests WHERE auth_user_id = '71000000-0000-4000-8000-000000000002'), 0, 'failed request leaves no receipt');
UPDATE organization_members SET is_active = false WHERE auth_user_id = '71000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT throws_ok($$ SELECT create_digital_workspace('72000000-0000-4000-8000-000000000001', 'A4 Cafe', 'A4 Main', ARRAY['menu']) $$, 'P0001', 'workspace_no_longer_available', 'replay cannot resurrect revoked membership');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
