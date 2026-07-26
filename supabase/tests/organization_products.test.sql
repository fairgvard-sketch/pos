-- pgTAP: продуктовые модули организации и digital-only онбординг (100).
--
-- Проверяется контракт Phase 1 standalone digital products:
--   * organization_products закрыта на запись клиентам, чтение — своя org;
--   * bootstrap_digital_org создаёт org/точку/членство БЕЗ PIN, staff
--     и устройства, пишет в app_metadata только org_id;
--   * device-путь bootstrap_org сеет все модули (нет регрессии POS);
--   * submit_online_order / submit_reservation отклоняют организацию
--     без модуля кодом module_disabled, причём ДО settings-тумблеров;
--   * организация с модулем проходит проверку и падает дальше по
--     прежним причинам (disabled/closed) — порядок гейтов закреплён.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(28);

-- ── Структура и доступ ───────────────────────────────────────
SELECT has_table('organization_products');
SELECT has_column('organization_products', 'product');
SELECT has_column('organization_products', 'is_active');

SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'organization_products'),
  true,
  'RLS включён на organization_products'
);

SELECT has_function('org_has_product');
SELECT has_function('bootstrap_digital_org');

SELECT ok(
  NOT has_function_privilege('anon', 'bootstrap_digital_org(text, text, text, text[])', 'EXECUTE'),
  'anon не вызывает bootstrap_digital_org'
);
SELECT ok(
  has_function_privilege('authenticated', 'bootstrap_digital_org(text, text, text, text[])', 'EXECUTE'),
  'authenticated может вызвать bootstrap_digital_org'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'organization_products', 'INSERT'),
  'authenticated не пишет в organization_products (провижионинг только сервером)'
);
SELECT ok(
  NOT has_table_privilege('anon', 'organization_products', 'SELECT'),
  'anon не читает organization_products'
);

-- ── Данные: legacy-организация с полным набором модулей ──────
-- Симулирует организацию, прошедшую бэкфилл миграции 100.
INSERT INTO orgs (id, name) VALUES
  ('50000000-0000-4000-8000-000000000001', 'Legacy POS Org');
INSERT INTO locations (id, org_id, name) VALUES
  ('51000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'Legacy Loc');
INSERT INTO organization_products (org_id, product)
SELECT '50000000-0000-4000-8000-000000000001', m
FROM unnest(ARRAY['menu', 'online_orders', 'reservations', 'pos']) m;

INSERT INTO auth.users (id, email) VALUES
  ('52000000-0000-4000-8000-000000000001', 'device@pos.example'),   -- device-онбординг
  ('52000000-0000-4000-8000-000000000002', 'owner@cafe.example'),   -- digital-владелец
  ('52000000-0000-4000-8000-000000000003', 'second@cafe.example');  -- invalid_products

-- ── Device-путь: bootstrap_org сеет все четыре модуля ────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"52000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
CREATE TEMP TABLE _pos AS
SELECT bootstrap_org('Cafe POS', 'Main', 'Boss', '1234') AS res;

SELECT is(
  (SELECT COUNT(*)::int FROM organization_products
   WHERE org_id = (SELECT (res ->> 'org_id')::uuid FROM _pos) AND is_active),
  4,
  'device-онбординг получает все четыре модуля'
);

-- ── Digital-путь: без PIN, staff и устройства ────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"52000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
CREATE TEMP TABLE _digital AS
WITH r AS (
  -- 'pos' в self-serve списке молча отбрасывается
  SELECT bootstrap_digital_org('Cafe Digital', 'Main St', NULL, ARRAY['menu', 'pos']) AS res
)
SELECT (res ->> 'org_id')::uuid      AS org_id,
       (res ->> 'location_id')::uuid AS location_id,
       res -> 'products'             AS products
FROM r;

SELECT is(
  (SELECT array_agg(product ORDER BY product) FROM organization_products
   WHERE org_id = (SELECT org_id FROM _digital) AND is_active),
  ARRAY['menu'],
  'digital-org получает только запрошенные digital-модули; pos отброшен'
);
SELECT is(
  (SELECT role FROM organization_members
   WHERE org_id = (SELECT org_id FROM _digital)
     AND auth_user_id = '52000000-0000-4000-8000-000000000002'),
  'owner',
  'digital-владелец получает owner-членство в organization_members'
);
SELECT is(
  (SELECT COUNT(*)::int FROM staff WHERE org_id = (SELECT org_id FROM _digital)),
  0,
  'digital-онбординг не создаёт staff-строку и PIN'
);
SELECT ok(
  (SELECT raw_app_meta_data ? 'org_id' FROM auth.users
   WHERE id = '52000000-0000-4000-8000-000000000002'),
  'org_id записан в app_metadata digital-владельца'
);
SELECT ok(
  NOT (SELECT raw_app_meta_data ? 'location_id' FROM auth.users
       WHERE id = '52000000-0000-4000-8000-000000000002'),
  'location_id в JWT digital-владельца НЕ пишется (семантика устройства)'
);
SELECT ok(
  (SELECT org_has_product(org_id, 'menu') FROM _digital),
  'org_has_product видит купленный модуль'
);
SELECT ok(
  NOT (SELECT org_has_product(org_id, 'pos') FROM _digital),
  'org_has_product не даёт неподключённый модуль'
);

SELECT throws_ok(
  $$ SELECT bootstrap_digital_org('Second Org', 'Loc', NULL, ARRAY['menu']) $$,
  'P0001', 'org already bootstrapped for this account',
  'повторный digital-онбординг того же аккаунта отклоняется'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"52000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
SELECT throws_ok(
  $$ SELECT bootstrap_digital_org('Bad Org', 'Loc', NULL, ARRAY['pos']) $$,
  'P0001', 'invalid_products',
  'pos не предоставляется self-serve: без валидных digital-модулей — invalid_products'
);

-- ── Бэкофис digital-владельца: контекст без устройства и смены ─
SELECT set_config(
  'test.digital_claims',
  '{"sub":"52000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"'
    || (SELECT org_id FROM _digital) || '"}}',
  true
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', current_setting('test.digital_claims'), true);

SELECT is(
  (SELECT get_backoffice_context() -> 'organization' ->> 'name'),
  'Cafe Digital',
  'digital-владелец получает контекст бэкофиса без PIN/устройства/смены'
);
SELECT is(
  (SELECT get_backoffice_context() -> 'products'),
  '["menu"]'::jsonb,
  'контекст бэкофиса отдаёт модули организации'
);
SELECT is(
  (SELECT (get_backoffice_context() -> 'counts' ->> 'staff')::int),
  0,
  'digital-org живёт без сотрудников'
);
SELECT is(
  (SELECT COUNT(*)::int FROM organization_products),
  1,
  'RLS: клиент видит только модули своей организации'
);

RESET ROLE;

-- ── Enforcement публичных мутаций ────────────────────────────
SELECT throws_ok(
  format(
    $$ SELECT submit_online_order(%L, '53000000-0000-4000-8000-000000000001', 'Guest', '0501234567', '[]'::jsonb) $$,
    (SELECT location_id FROM _digital)
  ),
  'P0001', 'module_disabled',
  'submit_online_order отклоняет организацию без модуля online_orders'
);
SELECT throws_ok(
  format(
    $$ SELECT submit_reservation(%L, '53000000-0000-4000-8000-000000000002', 'Guest', '0501234567', 2, NOW() + INTERVAL '2 hours') $$,
    (SELECT location_id FROM _digital)
  ),
  'P0001', 'module_disabled',
  'submit_reservation отклоняет организацию без модуля reservations (до settings-тумблера)'
);
SELECT throws_ok(
  $$ SELECT submit_reservation('51000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000003', 'Guest', '0501234567', 2, NOW() + INTERVAL '2 hours') $$,
  'P0001', 'disabled',
  'организация с модулем reservations проходит гейт и падает дальше по settings (disabled)'
);
SELECT throws_ok(
  $$ SELECT submit_online_order('51000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000004', 'Guest', '0501234567', '[]'::jsonb) $$,
  'P0001', 'closed',
  'организация с модулем online_orders проходит гейт и падает дальше по смене (closed)'
);

SELECT * FROM finish();
ROLLBACK;
