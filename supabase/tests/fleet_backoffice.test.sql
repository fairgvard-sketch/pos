-- pgTAP: раздел «Девайсы» для веб-владельца бэкофиса (097).
--
-- Инвариант как у 089: членство в organization_members заменяет PIN-сессию, но
-- НЕ расширяет видимость — чужая организация недостижима, потому что тело RPC
-- читает devices под RLS вызывающего (SECURITY INVOKER). JWT-клеймы
-- подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(9);

-- ── Фикстура: две организации, у каждой по устройству ──
INSERT INTO orgs (id, name) VALUES
  ('70000000-0000-4000-8000-000000000001', 'pgTAP fleet F1'),
  ('70000000-0000-4000-8000-000000000002', 'pgTAP fleet F2');

INSERT INTO locations (id, org_id, name) VALUES
  ('71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'Loc F1'),
  ('71000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', 'Loc F2');

-- Org F1: две кассы — одна «на связи», одна «молчащая» с зависшей очередью.
-- Org F2: одна касса (не должна попасть в парк владельца F1).
INSERT INTO devices (
  id, org_id, location_id, name, last_seen_at,
  app_version, bridge_version, outbox_pending, outbox_oldest_at, outbox_failed
) VALUES
  ('72000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001',
   '71000000-0000-4000-8000-000000000001', 'Касса вход', NOW() - INTERVAL '1 minute',
   '2.0.0', 3, 0, NULL, FALSE),
  ('72000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001',
   '71000000-0000-4000-8000-000000000001', 'Касса веранда', NOW() - INTERVAL '2 hours',
   '2.0.0', 3, 5, NOW() - INTERVAL '3 hours', TRUE),
  ('72000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000002',
   '71000000-0000-4000-8000-000000000002', 'Чужая касса', NOW(),
   '2.0.0', 3, 0, NULL, FALSE);

INSERT INTO auth.users (id) VALUES
  ('73000000-0000-4000-8000-000000000001'),  -- владелец бэкофиса Org F1
  ('73000000-0000-4000-8000-000000000002');  -- аккаунт без членства

INSERT INTO organization_members (org_id, auth_user_id, role, is_active) VALUES
  ('70000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', 'owner', TRUE);

SET LOCAL ROLE authenticated;

-- ── Владелец бэкофиса: без PIN-сессии, без location_id в токене ──
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"73000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"70000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT lives_ok(
  $$ SELECT get_backoffice_fleet() $$,
  'владелец бэкофиса получает парк без PIN-сессии'
);

SELECT is(
  jsonb_array_length(get_backoffice_fleet()),
  2,
  'парк содержит обе кассы своей организации'
);

-- Главная проверка: чужая касса (Org F2) в парк не попала
SELECT is(
  (SELECT COUNT(*)::int
   FROM jsonb_array_elements(get_backoffice_fleet()) e
   WHERE e ->> 'name' = 'Чужая касса'),
  0,
  'касса чужой организации не попадает в парк владельца'
);

-- Сортировка: «молчащая» касса (больше silence) идёт первой
SELECT is(
  (get_backoffice_fleet() -> 0 ->> 'name'),
  'Касса веранда',
  'молчащая касса поднята наверх (сортировка по silence)'
);

-- Здоровье очереди прокидывается как есть
SELECT is(
  (SELECT (e ->> 'outbox_pending')::int
   FROM jsonb_array_elements(get_backoffice_fleet()) e
   WHERE e ->> 'name' = 'Касса веранда'),
  5,
  'outbox_pending отдаётся из телеметрии'
);

SELECT is(
  (SELECT (e ->> 'outbox_failed')::boolean
   FROM jsonb_array_elements(get_backoffice_fleet()) e
   WHERE e ->> 'name' = 'Касса веранда'),
  TRUE,
  'outbox_failed отдаётся из телеметрии'
);

-- Имя точки джойнится
SELECT is(
  (SELECT (e ->> 'location_name')
   FROM jsonb_array_elements(get_backoffice_fleet()) e
   WHERE e ->> 'name' = 'Касса вход'),
  'Loc F1',
  'имя точки джойнится к устройству'
);

-- ── Аккаунт без членства (устройство): прежний путь через PIN-сессию ──
-- С заведомо битым токеном сессии staff-гейт отвергает — членство прохода не дало.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"73000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"70000000-0000-4000-8000-000000000001","location_id":"71000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$ SELECT get_backoffice_fleet('74000000-0000-4000-8000-0000000000ff') $$,
  'P0001', 'staff session invalid',
  'битый токен без членства отвергается на staff-гейте'
);

RESET ROLE;

-- ── Контракт: anon не вызывает ──
SELECT ok(
  NOT has_function_privilege('anon',
    'get_backoffice_fleet(uuid)', 'EXECUTE'),
  'anon не вызывает get_backoffice_fleet'
);

SELECT * FROM finish();
ROLLBACK;
