-- pgTAP: фактическая RLS-изоляция устройств + контракт RPC 064/065.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(13);

SELECT has_column('devices', 'device_uuid');
SELECT has_column('devices', 'auth_user_id');
SELECT has_column('devices', 'settings');
SELECT has_column('devices', 'app_version');

SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'devices'),
  true,
  'RLS включён на devices'
);
SELECT isnt(
  (SELECT count(*) FROM pg_policies WHERE tablename = 'devices' AND policyname = 'devices_update_own'),
  0::bigint,
  'политика devices_update_own существует'
);

SELECT has_function('patch_location_settings');
SELECT has_function('save_menu_item');
SELECT has_function('register_device');
SELECT ok(
  has_function_privilege(
    'authenticated',
    'register_device(uuid,text,jsonb,text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated может вызвать register_device'
);

INSERT INTO orgs (id, name) VALUES
  ('20000000-0000-4000-8000-000000000001', 'Org A'),
  ('20000000-0000-4000-8000-000000000002', 'Org B');

INSERT INTO locations (id, org_id, name) VALUES
  ('21000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Loc A'),
  ('21000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Loc B');

INSERT INTO devices (
  id, org_id, location_id, name, device_uuid, auth_user_id, settings
) VALUES
  (
    '22000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    'A own',
    '23000000-0000-4000-8000-000000000001',
    '24000000-0000-4000-8000-000000000001',
    '{}'
  ),
  (
    '22000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    'A other',
    '23000000-0000-4000-8000-000000000002',
    '24000000-0000-4000-8000-000000000002',
    '{}'
  ),
  (
    '22000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000002',
    '21000000-0000-4000-8000-000000000002',
    'B hidden',
    '23000000-0000-4000-8000-000000000003',
    '24000000-0000-4000-8000-000000000003',
    '{}'
  );

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"24000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"20000000-0000-4000-8000-000000000001","location_id":"21000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT results_eq(
  $$ SELECT name FROM devices ORDER BY name $$,
  $$ VALUES ('A other'::text), ('A own'::text) $$,
  'устройство видит свою организацию и не видит Org B'
);

-- Data-modifying CTE запрещён внутри скалярного подзапроса (top-level only),
-- поэтому UPDATE выполняется отдельно, а инвариант проверяется по состоянию.
UPDATE devices SET name = 'hacked'
WHERE device_uuid = '23000000-0000-4000-8000-000000000002';

SELECT is(
  (SELECT name FROM devices WHERE device_uuid = '23000000-0000-4000-8000-000000000002'),
  'A other',
  'устройство не меняет строку другого auth_user той же организации'
);

UPDATE devices SET name = 'A own updated'
WHERE device_uuid = '23000000-0000-4000-8000-000000000001';

SELECT is(
  (SELECT name FROM devices WHERE device_uuid = '23000000-0000-4000-8000-000000000001'),
  'A own updated',
  'устройство меняет собственную строку'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
