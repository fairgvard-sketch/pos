-- pgTAP: безопасный провижионинг продуктов (104).
--
-- Контракт Phase 2 плана product separation:
--   * выдача/приостановка entitlement'ов — только service_role
--     (grant_org_product / revoke_org_product); у authenticated нет ни
--     табличных грантов, ни EXECUTE на операторские функции;
--   * заявка на активацию — интерес, не доступ; клиент не может выдать
--     продукт сам себе никаким путём;
--   * revoke закрывает доступ БЕЗ удаления данных, повторный grant
--     возвращает доступ;
--   * attach_device_to_org привязывает device-аккаунт к существующей
--     организации (апгрейд digital → POS без второй организации).

BEGIN;
SELECT plan(30);

-- ── Структура и доступ ───────────────────────────────────────
SELECT has_table('product_activation_requests');
SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'product_activation_requests'),
  true, 'RLS включён на product_activation_requests'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'product_activation_requests', 'INSERT'),
  'authenticated не пишет заявки напрямую (только через RPC)'
);
SELECT ok(
  NOT has_table_privilege('anon', 'product_activation_requests', 'SELECT'),
  'anon не читает заявки'
);

SELECT has_function('grant_org_product');
SELECT has_function('revoke_org_product');
SELECT has_function('attach_device_to_org');
SELECT has_function('request_product_activation');

SELECT ok(
  NOT has_function_privilege('authenticated',
    'grant_org_product(uuid, text, text, text, timestamptz, text)', 'EXECUTE'),
  'authenticated не вызывает grant_org_product'
);
SELECT ok(
  NOT has_function_privilege('authenticated',
    'revoke_org_product(uuid, text, text, text)', 'EXECUTE'),
  'authenticated не вызывает revoke_org_product'
);
SELECT ok(
  NOT has_function_privilege('authenticated',
    'attach_device_to_org(uuid, uuid, uuid)', 'EXECUTE'),
  'authenticated не вызывает attach_device_to_org'
);
SELECT ok(
  has_function_privilege('authenticated',
    'request_product_activation(text)', 'EXECUTE'),
  'authenticated может подать заявку на активацию'
);

-- ── Данные ───────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('70000000-0000-4000-8000-000000000001', 'Provisioned Org'),
  ('70000000-0000-4000-8000-000000000002', 'Other Org');
INSERT INTO locations (id, org_id, name) VALUES
  ('71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'Main'),
  ('71000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', 'Foreign');
INSERT INTO auth.users (id, email) VALUES
  ('72000000-0000-4000-8000-000000000001', 'owner@prov.example'),
  ('72000000-0000-4000-8000-000000000002', 'stranger@prov.example'),
  ('72000000-0000-4000-8000-000000000003', 'device@prov.example');
INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES
  ('72000000-0000-4000-8000-000000000004', 'taken@prov.example',
   '{"org_id":"70000000-0000-4000-8000-000000000002"}'::jsonb);
INSERT INTO organization_members (org_id, auth_user_id, role, display_name) VALUES
  ('70000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 'owner', 'Owner');
INSERT INTO product_activation_requests (org_id, product, requested_by) VALUES
  ('70000000-0000-4000-8000-000000000001', 'menu', '72000000-0000-4000-8000-000000000001');

-- ── Операторская выдача ──────────────────────────────────────
SELECT lives_ok(
  $$ SELECT grant_org_product('70000000-0000-4000-8000-000000000001', 'menu') $$,
  'grant_org_product выдаёт продукт'
);
SELECT ok(
  org_has_product('70000000-0000-4000-8000-000000000001', 'menu'),
  'после grant продукт действует'
);
SELECT is(
  (SELECT status FROM product_activation_requests
   WHERE org_id = '70000000-0000-4000-8000-000000000001' AND product = 'menu'),
  'approved',
  'grant закрывает pending-заявку как approved'
);
SELECT throws_ok(
  $$ SELECT grant_org_product('70000000-0000-4000-8000-000000000001', 'nope') $$,
  'P0001', 'invalid_product',
  'grant неизвестного продукта отклоняется'
);
SELECT throws_ok(
  $$ SELECT grant_org_product('70000000-0000-4000-8000-000000000001', 'menu', 'expired') $$,
  'P0001', 'invalid_status',
  'grant с не-действующим статусом отклоняется'
);

-- ── Приостановка без удаления данных ─────────────────────────
SELECT lives_ok(
  $$ SELECT revoke_org_product('70000000-0000-4000-8000-000000000001', 'menu') $$,
  'revoke_org_product приостанавливает продукт'
);
SELECT ok(
  NOT org_has_product('70000000-0000-4000-8000-000000000001', 'menu'),
  'после revoke доступ закрыт'
);
SELECT is(
  (SELECT COUNT(*)::int FROM organization_products
   WHERE org_id = '70000000-0000-4000-8000-000000000001' AND product = 'menu'),
  1,
  'revoke сохраняет строку entitlement''а (данные не удаляются)'
);
SELECT lives_ok(
  $$ SELECT grant_org_product('70000000-0000-4000-8000-000000000001', 'menu') $$,
  'повторный grant возвращает доступ'
);

-- ── Заявка из кабинета ───────────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"72000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"70000000-0000-4000-8000-000000000001"}}',
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT request_product_activation('reservations') ->> 'status'),
  'pending',
  'владелец подаёт заявку на add-on: pending'
);
SELECT is(
  (SELECT request_product_activation('menu') ->> 'status'),
  'already_active',
  'заявка на уже активный продукт — already_active, дубль не создаётся'
);
SELECT throws_ok(
  $$ SELECT request_product_activation('nope') $$,
  'P0001', 'invalid_product',
  'заявка на неизвестный продукт отклоняется'
);

-- Клиент не может выдать продукт сам себе: операторская функция закрыта.
SELECT throws_ok(
  $$ SELECT grant_org_product('70000000-0000-4000-8000-000000000001', 'pos') $$,
  '42501', NULL,
  'authenticated получает permission denied на grant_org_product'
);

RESET ROLE;

-- Не-член организации не подаёт заявки.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"72000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"70000000-0000-4000-8000-000000000001"}}',
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT request_product_activation('menu') $$,
  'P0001', 'backoffice access denied',
  'без членства заявка отклоняется'
);
RESET ROLE;

-- ── Апгрейд digital → POS: привязка устройства ───────────────
SELECT lives_ok(
  $$ SELECT attach_device_to_org(
       '72000000-0000-4000-8000-000000000003',
       '70000000-0000-4000-8000-000000000001',
       '71000000-0000-4000-8000-000000000001') $$,
  'device-аккаунт привязывается к существующей организации'
);
SELECT is(
  (SELECT raw_app_meta_data ->> 'org_id' FROM auth.users
   WHERE id = '72000000-0000-4000-8000-000000000003'),
  '70000000-0000-4000-8000-000000000001',
  'app_metadata устройства указывает на существующую организацию (второй нет)'
);
SELECT throws_ok(
  $$ SELECT attach_device_to_org(
       '72000000-0000-4000-8000-000000000002',
       '70000000-0000-4000-8000-000000000001',
       '71000000-0000-4000-8000-000000000002') $$,
  'P0001', 'invalid_location',
  'точка чужой организации отклоняется'
);
SELECT throws_ok(
  $$ SELECT attach_device_to_org(
       '72000000-0000-4000-8000-000000000004',
       '70000000-0000-4000-8000-000000000001',
       '71000000-0000-4000-8000-000000000001') $$,
  'P0001', 'org already bootstrapped for this account',
  'аккаунт с организацией не перепривязывается'
);

SELECT * FROM finish();
ROLLBACK;
