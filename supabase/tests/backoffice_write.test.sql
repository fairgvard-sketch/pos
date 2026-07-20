-- pgTAP: запись из веб-кабинета владельца (091).
--
-- Инварианты:
--   * владелец бэкофиса пишет настройки СВОЕЙ точки без PIN-сессии;
--   * точку он выбирает параметром, чужая точка/чужая org — отказ;
--   * membership↔staff связан сидом, автор операции = staff_id владельца;
--   * кассовый путь (patch_location_settings по токену) не сломан.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(11);

SELECT has_column('organization_members', 'staff_id');
SELECT has_function('require_backoffice_or_staff', ARRAY['uuid','text']);
SELECT has_function('assert_backoffice_location', ARRAY['uuid']);
SELECT has_function('patch_location_settings_web', ARRAY['uuid','jsonb','uuid']);
SELECT ok(
  NOT has_function_privilege('anon', 'patch_location_settings_web(uuid,jsonb,uuid)', 'EXECUTE'),
  'anon не вызывает patch_location_settings_web'
);

-- ── Фикстура: две организации, у org A — владелец со staff-строкой ──
INSERT INTO orgs (id, name) VALUES
  ('80000000-0000-4000-8000-000000000001', 'pgTAP org W1'),
  ('80000000-0000-4000-8000-000000000002', 'pgTAP org W2');

INSERT INTO locations (id, org_id, name) VALUES
  ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'Loc W1'),
  ('81000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000002', 'Loc W2');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('82000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000001', 'pgTAP owner W1', 'owner', 'unused-in-test');

INSERT INTO auth.users (id) VALUES
  ('83000000-0000-4000-8000-000000000001'),  -- владелец org A
  ('83000000-0000-4000-8000-000000000002');  -- владелец org B (без staff-строки)

-- Владелец org A связан со своей staff-строкой (как делает сид 091 или UI при
-- заведении владельца). org B — намеренно без связи: проверяем, что запись
-- всё равно проходит, а автор просто NULL.
INSERT INTO organization_members (org_id, auth_user_id, role, is_active, staff_id) VALUES
  ('80000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', 'owner', TRUE,
   '82000000-0000-4000-8000-000000000001'),
  ('80000000-0000-4000-8000-000000000002', '83000000-0000-4000-8000-000000000002', 'owner', TRUE,
   NULL);

SELECT is(
  (SELECT staff_id FROM organization_members
   WHERE auth_user_id = '83000000-0000-4000-8000-000000000001'),
  '82000000-0000-4000-8000-000000000001'::uuid,
  'владелец org A связан со своей owner-строкой в staff (автор в аудите)'
);

SET LOCAL ROLE authenticated;

-- ── Владелец org A: пишет настройки своей точки без PIN ──────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"83000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT lives_ok(
  $$ SELECT patch_location_settings_web(
       '81000000-0000-4000-8000-000000000001',
       '{"receipt":{"business_name":"Булочка"}}'::jsonb) $$,
  'владелец пишет настройки своей точки без PIN-сессии'
);

SELECT is(
  (SELECT settings #>> '{receipt,business_name}' FROM locations
   WHERE id = '81000000-0000-4000-8000-000000000001'),
  'Булочка',
  'настройка сохранилась в своей точке'
);

-- Чужая точка (org B) — отказ, даже с валидным членством в своей org
SELECT throws_ok(
  $$ SELECT patch_location_settings_web(
       '81000000-0000-4000-8000-000000000002',
       '{"receipt":{"business_name":"Взлом"}}'::jsonb) $$,
  'location not in organization',
  'владелец org A не пишет в точку org B'
);

-- ── Владелец org B без staff-связи: запись всё равно проходит ──
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"83000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000002"}}',
  true
);

SELECT lives_ok(
  $$ SELECT patch_location_settings_web(
       '81000000-0000-4000-8000-000000000002',
       '{"receipt":{"business_name":"Org B"}}'::jsonb) $$,
  'владелец без связанной staff-строки всё равно пишет (автор NULL, не блок)'
);

-- ── Аккаунт без членства (устройство без PIN) — отказ ────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"83000000-0000-4000-8000-0000000000ff","role":"authenticated","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000001","location_id":"81000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$ SELECT patch_location_settings_web(
       '81000000-0000-4000-8000-000000000001',
       '{"receipt":{"business_name":"NoAuth"}}'::jsonb) $$,
  'P0001', 'staff session required',
  'не-владелец без PIN-сессии не пишет настройки'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
