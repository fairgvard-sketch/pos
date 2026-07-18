-- pgTAP: источник телеметрии 'shift' (082) — shift_overdue попадает в журнал.

BEGIN;
SELECT plan(3);

-- Данные: организация, точка
INSERT INTO orgs (id, name) VALUES ('40000000-0000-4000-8000-000000000001', 'Org S');
INSERT INTO locations (id, org_id, name)
  VALUES ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Loc S');

-- JWT-клеймы устройства (только внутри транзакции теста)
SELECT set_config('request.jwt.claims', json_build_object(
  'sub', '42000000-0000-4000-8000-000000000001',
  'app_metadata', json_build_object(
    'org_id', '40000000-0000-4000-8000-000000000001',
    'location_id', '41000000-0000-4000-8000-000000000001'
  )
)::text, true);

SELECT is(
  report_client_errors(
    '43000000-0000-4000-8000-000000000001',
    '[{"fingerprint":"fp-shift-1","source":"shift","message":"shift_overdue: days=1"},
      {"fingerprint":"fp-unknown-1","source":"martian","message":"x"}]'::jsonb
  ),
  2,
  'пакет с source=shift и неизвестным source принят целиком'
);

SELECT is(
  (SELECT source FROM client_errors WHERE fingerprint = 'fp-shift-1'),
  'shift',
  'source=shift сохранён как есть (не клампится в window)'
);

SELECT is(
  (SELECT source FROM client_errors WHERE fingerprint = 'fp-unknown-1'),
  'window',
  'неизвестный source по-прежнему клампится в window'
);

SELECT * FROM finish();
ROLLBACK;
