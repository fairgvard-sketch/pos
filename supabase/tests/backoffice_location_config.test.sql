-- pgTAP: конфигурация точки и УФ-выгрузка из веб-кабинета (107).
--
-- Инварианты:
--   * владелец бэкофиса правит колонки СВОЕЙ точки (НДС, лояльность,
--     реквизиты) без PIN-сессии; чужая точка — отказ;
--   * ключ 'settings' в update_location_config_web запрещён
--     (перезапись JSONB целиком — только через patch с merge);
--   * uf_export_info_web/uf_export_documents_web отдают данные только
--     по точке своей org; ядро *_for клиентским ролям недоступно;
--   * аккаунт без членства и без PIN-сессии — отказ.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(14);

SELECT has_function('update_location_config_web', ARRAY['uuid','jsonb','uuid']);
SELECT has_function('uf_export_info_web', ARRAY['uuid','uuid']);
SELECT has_function('uf_export_documents_web',
  ARRAY['uuid','date','date','timestamptz','uuid','integer','uuid']);

SELECT ok(
  NOT has_function_privilege('anon', 'update_location_config_web(uuid,jsonb,uuid)', 'EXECUTE'),
  'anon не вызывает update_location_config_web'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'uf_export_info_for(uuid)', 'EXECUTE'),
  'ядро uf_export_info_for недоступно клиентским ролям'
);
SELECT ok(
  NOT has_function_privilege('authenticated',
    'uf_export_documents_for(uuid,date,date,timestamptz,uuid,integer)', 'EXECUTE'),
  'ядро uf_export_documents_for недоступно клиентским ролям'
);

-- ── Фикстура: две организации, у org A — владелец-член ───────
INSERT INTO orgs (id, name) VALUES
  ('84000000-0000-4000-8000-000000000001', 'pgTAP org C1'),
  ('84000000-0000-4000-8000-000000000002', 'pgTAP org C2');

INSERT INTO locations (id, org_id, name, receipt_tax_id) VALUES
  ('85000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000001', 'Loc C1', '123456789'),
  ('85000000-0000-4000-8000-000000000002', '84000000-0000-4000-8000-000000000002', 'Loc C2', '987654321');

INSERT INTO auth.users (id) VALUES
  ('86000000-0000-4000-8000-000000000001');

INSERT INTO organization_members (org_id, auth_user_id, role, is_active) VALUES
  ('84000000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', 'owner', TRUE);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"86000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"84000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Колонки своей точки: НДС + лояльность без PIN ────────────
SELECT lives_ok(
  $$ SELECT update_location_config_web(
       '85000000-0000-4000-8000-000000000001',
       '{"vat_rate": 17, "loyalty_mode": "stamps", "loyalty_stamps_goal": 8}'::jsonb) $$,
  'владелец правит НДС и лояльность своей точки без PIN'
);

SELECT is(
  (SELECT vat_rate::TEXT || '/' || loyalty_mode || '/' || loyalty_stamps_goal::TEXT
   FROM locations WHERE id = '85000000-0000-4000-8000-000000000001'),
  '17.00/stamps/8',
  'колонки точки обновились'
);

-- Чужая точка — отказ
SELECT throws_ok(
  $$ SELECT update_location_config_web(
       '85000000-0000-4000-8000-000000000002',
       '{"vat_rate": 0}'::jsonb) $$,
  'location not in organization',
  'чужая точка недоступна'
);

-- Перезапись settings целиком — запрещена
SELECT throws_ok(
  $$ SELECT update_location_config_web(
       '85000000-0000-4000-8000-000000000001',
       '{"settings": {}}'::jsonb) $$,
  'use patch_location_settings_web for settings',
  'ключ settings отвергается: merge только через patch_location_settings_web'
);

-- ── УФ-выгрузка из веб-кабинета ──────────────────────────────
SELECT is(
  (SELECT uf_export_info_web('85000000-0000-4000-8000-000000000001') ->> 'tax_id'),
  '123456789',
  'uf_export_info_web отдаёт реквизиты своей точки'
);

SELECT throws_ok(
  $$ SELECT uf_export_info_web('85000000-0000-4000-8000-000000000002') $$,
  'location not in organization',
  'uf_export_info_web не отдаёт чужую точку'
);

SELECT lives_ok(
  $$ SELECT uf_export_documents_web(
       '85000000-0000-4000-8000-000000000001', '2026-07-01', '2026-07-31') $$,
  'uf_export_documents_web работает для своей точки (пустой период — ок)'
);

-- ── Аккаунт без членства и без PIN — отказ ───────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"86000000-0000-4000-8000-0000000000ff","role":"authenticated","app_metadata":{"org_id":"84000000-0000-4000-8000-000000000001","location_id":"85000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$ SELECT update_location_config_web(
       '85000000-0000-4000-8000-000000000001',
       '{"vat_rate": 0}'::jsonb) $$,
  'P0001', 'staff session required',
  'не-член без PIN-сессии не правит конфигурацию'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
