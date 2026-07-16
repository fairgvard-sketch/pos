-- pgTAP: телеметрия парка (074) — heartbeat, журнал ошибок, изоляция org.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(17);

-- ── Схема ──
SELECT has_column('devices', 'bridge_version');
SELECT has_column('devices', 'outbox_pending');
SELECT has_column('devices', 'outbox_oldest_at');
SELECT has_column('devices', 'outbox_failed');
SELECT has_table('client_errors');

SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'client_errors'),
  true,
  'RLS включён на client_errors'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'client_errors', 'SELECT'),
  'authenticated не читает client_errors напрямую (закрыта, как op_log)'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'client_errors', 'INSERT'),
  'authenticated не пишет в client_errors напрямую'
);

SELECT has_function('device_heartbeat');
SELECT has_function('report_client_errors');
SELECT ok(
  has_function_privilege(
    'authenticated',
    'report_client_errors(uuid,jsonb)',
    'EXECUTE'
  ),
  'authenticated может вызвать report_client_errors'
);

-- ── Данные: две организации, по устройству ──
INSERT INTO orgs (id, name) VALUES
  ('30000000-0000-4000-8000-000000000001', 'Org A'),
  ('30000000-0000-4000-8000-000000000002', 'Org B');

INSERT INTO locations (id, org_id, name) VALUES
  ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Loc A'),
  ('31000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'Loc B');

INSERT INTO devices (
  id, org_id, location_id, name, device_uuid, auth_user_id, settings
) VALUES
  (
    '32000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    'A device',
    '33000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000001',
    '{}'
  ),
  (
    '32000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002',
    '31000000-0000-4000-8000-000000000002',
    'B device',
    '33000000-0000-4000-8000-000000000002',
    '34000000-0000-4000-8000-000000000002',
    '{}'
  );

-- ── Работаем как устройство Org A ──
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"34000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"30000000-0000-4000-8000-000000000001","location_id":"31000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT is(
  device_heartbeat(
    '33000000-0000-4000-8000-000000000001',
    '9.9.9', 2, 3, NOW() - INTERVAL '10 minutes', false
  ),
  true,
  'heartbeat обновляет собственное устройство'
);
SELECT is(
  (SELECT outbox_pending FROM devices
   WHERE device_uuid = '33000000-0000-4000-8000-000000000001'),
  3,
  'здоровье offline-очереди записано'
);
SELECT is(
  device_heartbeat('33000000-0000-4000-8000-000000000002', '9.9.9'),
  false,
  'heartbeat чужого устройства (Org B) — тихий no-op, не исключение'
);

SELECT is(
  report_client_errors(
    '33000000-0000-4000-8000-000000000001',
    '[{"fingerprint":"fp1","source":"react","message":"boom","stack":"at x","count":1},
      {"fingerprint":"fp1","source":"react","message":"boom","count":2}]'::jsonb
  ),
  2,
  'пакет ошибок принят'
);

RESET ROLE;

SELECT is(
  (SELECT count FROM client_errors WHERE fingerprint = 'fp1'),
  3,
  'повтор fingerprint схлопнут в count, а не в новые строки'
);
SELECT is(
  (SELECT org_id FROM client_errors WHERE fingerprint = 'fp1'),
  '30000000-0000-4000-8000-000000000001'::uuid,
  'ошибка записана в org устройства из JWT, а не из параметров'
);

SELECT * FROM finish();
ROLLBACK;
