-- pgTAP: реестр продуктов, карта capabilities и lifecycle entitlement'ов (103).
--
-- Контракт Phase 1 плана product separation:
--   * product_catalog / product_capabilities закрыты на запись клиентам;
--   * все четыре продукта могут быть и первым продуктом, и add-on'ом;
--   * org_has_capability производит возможности из active/trialing,
--     не истёкших entitlement'ов; неизвестные ключи — FALSE (fail closed);
--   * ANGLE Orders включает public_menu без покупки Menu;
--   * POS даёт catalog_manage/pos_operate, но НЕ public_menu;
--   * просрочка/suspended/будущий starts_at гасят доступ без удаления данных;
--   * деактивация продукта в реестре гасит его entitlement'ы целиком;
--   * developer-гранты защищены триггером от случайной деактивации.

BEGIN;
SELECT plan(37);

-- ── Структура и доступ ───────────────────────────────────────
SELECT has_table('product_catalog');
SELECT has_table('product_capabilities');

SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'product_catalog'),
  true, 'RLS включён на product_catalog'
);
SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'product_capabilities'),
  true, 'RLS включён на product_capabilities'
);

SELECT ok(
  has_table_privilege('authenticated', 'product_catalog', 'SELECT'),
  'authenticated читает реестр продуктов (карточки кабинета)'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'product_catalog', 'INSERT'),
  'authenticated не пишет в реестр продуктов'
);
SELECT ok(
  NOT has_table_privilege('anon', 'product_catalog', 'SELECT'),
  'anon не читает реестр продуктов'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'product_capabilities', 'INSERT'),
  'authenticated не пишет в карту capabilities'
);

SELECT is(
  (SELECT COUNT(*)::int FROM product_catalog
   WHERE key IN ('pos', 'menu', 'online_orders', 'reservations')
     AND can_be_primary AND can_be_addon AND is_active),
  4,
  'все четыре продукта могут быть и первым standalone-продуктом, и add-on''ом'
);

SELECT has_function('org_has_capability');
SELECT has_column('organization_products', 'status');
SELECT has_column('organization_products', 'source');
SELECT has_column('organization_products', 'expires_at');
SELECT has_column('orgs', 'account_type');

-- ── Данные ───────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('60000000-0000-4000-8000-00000000000a', 'Menu Only Org'),
  ('60000000-0000-4000-8000-00000000000b', 'Orders Only Org'),
  ('60000000-0000-4000-8000-00000000000c', 'POS Only Org'),
  ('60000000-0000-4000-8000-00000000000d', 'Lifecycle Org'),
  ('60000000-0000-4000-8000-00000000000e', 'Developer Org');

SELECT is(
  (SELECT account_type FROM orgs WHERE id = '60000000-0000-4000-8000-00000000000a'),
  'customer',
  'новая организация по умолчанию customer'
);

INSERT INTO organization_products (org_id, product) VALUES
  ('60000000-0000-4000-8000-00000000000a', 'menu'),
  ('60000000-0000-4000-8000-00000000000b', 'online_orders'),
  ('60000000-0000-4000-8000-00000000000c', 'pos');

-- ── Menu-only ────────────────────────────────────────────────
SELECT ok(
  org_has_capability('60000000-0000-4000-8000-00000000000a', 'public_menu'),
  'Menu даёт публичную QR-витрину'
);
SELECT ok(
  NOT org_has_capability('60000000-0000-4000-8000-00000000000a', 'online_orders'),
  'Menu не даёт корзину/приём заказов'
);
SELECT ok(
  org_has_capability('60000000-0000-4000-8000-00000000000a', 'catalog_manage'),
  'Menu даёт управление каталогом'
);
SELECT ok(
  NOT org_has_capability('60000000-0000-4000-8000-00000000000a', 'pos_operate'),
  'Menu не даёт работу кассы'
);
SELECT ok(
  NOT org_has_capability('60000000-0000-4000-8000-00000000000a', 'no_such_capability'),
  'неизвестный capability-ключ — FALSE (fail closed)'
);
SELECT ok(
  NOT org_has_product('60000000-0000-4000-8000-00000000000a', 'no_such_product'),
  'неизвестный product-ключ — FALSE (fail closed)'
);

-- ── Orders-only: public_menu входит без покупки Menu ─────────
SELECT ok(
  org_has_capability('60000000-0000-4000-8000-00000000000b', 'public_menu'),
  'Orders включает публичное меню без отдельного entitlement Menu'
);
SELECT ok(
  org_has_capability('60000000-0000-4000-8000-00000000000b', 'orders_desk'),
  'Orders даёт веб-инбокс заказов'
);
SELECT ok(
  NOT org_has_product('60000000-0000-4000-8000-00000000000b', 'menu'),
  'прямой грант Menu у Orders-организации отсутствует (bundling ≠ грант)'
);

-- ── POS-only ─────────────────────────────────────────────────
SELECT ok(
  NOT org_has_capability('60000000-0000-4000-8000-00000000000c', 'public_menu'),
  'POS без Menu не открывает публичную QR-витрину'
);
SELECT ok(
  org_has_capability('60000000-0000-4000-8000-00000000000c', 'pos_operate'),
  'POS даёт работу кассы'
);

-- ── Lifecycle: оценивается в момент запроса ──────────────────
INSERT INTO organization_products (org_id, product, status) VALUES
  ('60000000-0000-4000-8000-00000000000d', 'menu', 'trialing');
SELECT ok(
  org_has_product('60000000-0000-4000-8000-00000000000d', 'menu'),
  'trialing-entitlement действует'
);

UPDATE organization_products
SET expires_at = NOW() - INTERVAL '1 minute'
WHERE org_id = '60000000-0000-4000-8000-00000000000d';
SELECT ok(
  NOT org_has_product('60000000-0000-4000-8000-00000000000d', 'menu'),
  'истёкший entitlement не действует (без удаления данных)'
);
SELECT ok(
  NOT org_has_capability('60000000-0000-4000-8000-00000000000d', 'public_menu'),
  'истёкший entitlement гасит и производные capabilities'
);

UPDATE organization_products
SET expires_at = NULL, status = 'suspended'
WHERE org_id = '60000000-0000-4000-8000-00000000000d';
SELECT ok(
  NOT org_has_product('60000000-0000-4000-8000-00000000000d', 'menu'),
  'suspended-entitlement не действует'
);

UPDATE organization_products
SET status = 'active', starts_at = NOW() + INTERVAL '1 day'
WHERE org_id = '60000000-0000-4000-8000-00000000000d';
SELECT ok(
  NOT org_has_product('60000000-0000-4000-8000-00000000000d', 'menu'),
  'entitlement с будущим starts_at ещё не действует'
);

-- ── Реестр: деактивация продукта гасит его entitlement'ы ─────
UPDATE product_catalog SET is_active = FALSE WHERE key = 'menu';
SELECT ok(
  NOT org_has_capability('60000000-0000-4000-8000-00000000000a', 'public_menu'),
  'неактивный в реестре продукт гасит capabilities (fail closed)'
);
UPDATE product_catalog SET is_active = TRUE WHERE key = 'menu';

-- ── Защита developer-грантов ─────────────────────────────────
INSERT INTO organization_products (org_id, product, source)
VALUES ('60000000-0000-4000-8000-00000000000e', 'menu', 'developer');

SELECT throws_ok(
  $$ UPDATE organization_products SET is_active = FALSE
     WHERE org_id = '60000000-0000-4000-8000-00000000000e' $$,
  'P0001', 'developer_grant_protected',
  'developer-грант нельзя деактивировать обычным UPDATE'
);
SELECT throws_ok(
  $$ DELETE FROM organization_products
     WHERE org_id = '60000000-0000-4000-8000-00000000000e' $$,
  'P0001', 'developer_grant_protected',
  'developer-грант нельзя удалить обычным DELETE'
);
SELECT lives_ok(
  $$ UPDATE organization_products SET metadata = '{"note":"ok"}'::jsonb
     WHERE org_id = '60000000-0000-4000-8000-00000000000e' $$,
  'не-lifecycle поля developer-гранта правятся свободно'
);
SELECT set_config('app.allow_developer_grant_change', 'on', true);
SELECT lives_ok(
  $$ UPDATE organization_products SET status = 'suspended'
     WHERE org_id = '60000000-0000-4000-8000-00000000000e' $$,
  'осознанное изменение developer-гранта проходит с явным GUC'
);
SELECT set_config('app.allow_developer_grant_change', '', true);

-- ── Тип аккаунта ─────────────────────────────────────────────
SELECT throws_ok(
  $$ UPDATE orgs SET account_type = 'vip'
     WHERE id = '60000000-0000-4000-8000-00000000000e' $$,
  '23514', NULL,
  'account_type ограничен customer/developer/demo'
);

SELECT * FROM finish();
ROLLBACK;
