-- pgTAP: матрица entitlements → поведение (Phase 6 плана product separation).
--
-- | Продукты   | Ожидание                                                  |
-- |------------|-----------------------------------------------------------|
-- | POS        | касса и каталог работают; публичной QR-витрины нет        |
-- | Menu       | каталог и QR-витрина работают; корзины нет                |
-- | Orders     | каталог, витрина, корзина, приём и инбокс работают        |
-- | Reserve    | публичная бронь и веб-стол работают                       |
-- | POS+Menu   | касса и витрина работают; Orders и Reserve — нет          |
-- | Все        | всё работает                                              |
-- | Нет        | только активационный UX (все серверные пути закрыты)      |
-- | Developer  | всё доступно бессрочно                                    |
--
-- Дополнительно закреплено: операционный тумблер настроек НЕ обходит
-- entitlement; прямой вызов RPC заблокирован независимо от видимости
-- навигации (module_disabled); гейт стоит ДО прочих проверок.

BEGIN;
SELECT plan(46);

-- ── Фикстуры ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('80000000-0000-4000-8000-00000000000a', 'M POS'),
  ('80000000-0000-4000-8000-00000000000b', 'M Menu'),
  ('80000000-0000-4000-8000-00000000000c', 'M Orders'),
  ('80000000-0000-4000-8000-00000000000d', 'M Reserve'),
  ('80000000-0000-4000-8000-00000000000e', 'M POS+Menu'),
  ('80000000-0000-4000-8000-00000000000f', 'M All'),
  ('80000000-0000-4000-8000-000000000010', 'M None'),
  ('80000000-0000-4000-8000-000000000011', 'M Developer');
UPDATE orgs SET account_type = 'developer'
WHERE id = '80000000-0000-4000-8000-000000000011';

INSERT INTO locations (id, org_id, name) VALUES
  ('81000000-0000-4000-8000-00000000000a', '80000000-0000-4000-8000-00000000000a', 'L POS'),
  ('81000000-0000-4000-8000-00000000000b', '80000000-0000-4000-8000-00000000000b', 'L Menu'),
  ('81000000-0000-4000-8000-00000000000c', '80000000-0000-4000-8000-00000000000c', 'L Orders'),
  ('81000000-0000-4000-8000-00000000000d', '80000000-0000-4000-8000-00000000000d', 'L Reserve'),
  ('81000000-0000-4000-8000-000000000010', '80000000-0000-4000-8000-000000000010', 'L None');

INSERT INTO organization_products (org_id, product) VALUES
  ('80000000-0000-4000-8000-00000000000a', 'pos'),
  ('80000000-0000-4000-8000-00000000000b', 'menu'),
  ('80000000-0000-4000-8000-00000000000c', 'online_orders'),
  ('80000000-0000-4000-8000-00000000000d', 'reservations'),
  ('80000000-0000-4000-8000-00000000000e', 'pos'),
  ('80000000-0000-4000-8000-00000000000e', 'menu'),
  ('80000000-0000-4000-8000-00000000000f', 'pos'),
  ('80000000-0000-4000-8000-00000000000f', 'menu'),
  ('80000000-0000-4000-8000-00000000000f', 'online_orders'),
  ('80000000-0000-4000-8000-00000000000f', 'reservations');
INSERT INTO organization_products (org_id, product, source)
SELECT '80000000-0000-4000-8000-000000000011', key, 'developer' FROM product_catalog;

INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES
  ('82000000-0000-4000-8000-000000000001', 'owner@mall.example',
   '{"org_id":"80000000-0000-4000-8000-00000000000f"}'::jsonb),
  ('82000000-0000-4000-8000-000000000002', 'owner@mnone.example',
   '{"org_id":"80000000-0000-4000-8000-000000000010"}'::jsonb);
INSERT INTO organization_members (org_id, auth_user_id, role, display_name) VALUES
  ('80000000-0000-4000-8000-00000000000f', '82000000-0000-4000-8000-000000000001', 'owner', 'All'),
  ('80000000-0000-4000-8000-000000000010', '82000000-0000-4000-8000-000000000002', 'owner', 'None');

-- ── POS-only ─────────────────────────────────────────────────
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000a', 'pos_operate'),
  'POS: касса работает');
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000a', 'catalog_manage'),
  'POS: каталог редактируется');
SELECT ok(NOT org_has_capability('80000000-0000-4000-8000-00000000000a', 'public_menu'),
  'POS: публичной QR-витрины нет');
SELECT is(
  (org_public_menu_gates('80000000-0000-4000-8000-00000000000a') ->> 'public_menu')::boolean,
  false,
  'POS: Edge-гейт витрины закрыт'
);

-- ── Menu-only ────────────────────────────────────────────────
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000b', 'public_menu'),
  'Menu: QR-витрина работает');
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000b', 'catalog_manage'),
  'Menu: каталог редактируется');
SELECT ok(NOT org_has_capability('80000000-0000-4000-8000-00000000000b', 'online_orders'),
  'Menu: корзины нет');
SELECT ok(NOT org_has_capability('80000000-0000-4000-8000-00000000000b', 'pos_operate'),
  'Menu: кассы нет');
SELECT throws_ok(
  $$ SELECT submit_online_order('81000000-0000-4000-8000-00000000000b',
       '83000000-0000-4000-8000-000000000001', 'Guest', '0501234567', '[]'::jsonb) $$,
  'P0001', 'module_disabled',
  'Menu: приём заказа заблокирован сервером (module_disabled)'
);

-- ── Orders-only ──────────────────────────────────────────────
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000c', 'public_menu'),
  'Orders: публичное меню включено без покупки Menu');
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000c', 'online_orders'),
  'Orders: корзина и приём работают');
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000c', 'orders_desk'),
  'Orders: веб-инбокс работает');
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000c', 'catalog_manage'),
  'Orders: каталог редактируется');
SELECT ok(NOT org_has_capability('80000000-0000-4000-8000-00000000000c', 'pos_operate'),
  'Orders: кассы нет');
SELECT is(
  (org_public_menu_gates('80000000-0000-4000-8000-00000000000c') ->> 'online_orders')::boolean,
  true,
  'Orders: Edge-гейт корзины открыт'
);
-- Гейт пройден: заявка падает дальше по валидации, а не по module_disabled
SELECT throws_ok(
  $$ SELECT submit_online_order('81000000-0000-4000-8000-00000000000c',
       '83000000-0000-4000-8000-000000000002', 'Guest', '0501234567', '[]'::jsonb) $$,
  'P0001', 'invalid_items',
  'Orders: приём заказа проходит гейт (standalone-режим без смены)'
);

-- ── Reserve-only ─────────────────────────────────────────────
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000d', 'public_reservations'),
  'Reserve: публичная бронь работает');
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000d', 'reservations_desk'),
  'Reserve: веб-стол хостес работает');
SELECT ok(NOT org_has_capability('80000000-0000-4000-8000-00000000000d', 'catalog_manage'),
  'Reserve: каталога нет');
SELECT ok(NOT org_has_capability('80000000-0000-4000-8000-00000000000d', 'public_menu'),
  'Reserve: витрины меню нет');
-- Гейт пройден: дальше падает по выключенному тумблеру владельца
SELECT throws_ok(
  $$ SELECT submit_reservation('81000000-0000-4000-8000-00000000000d',
       '83000000-0000-4000-8000-000000000003', 'Guest', '0501234567', 2,
       NOW() + INTERVAL '2 hours') $$,
  'P0001', 'disabled',
  'Reserve: бронь проходит гейт модуля и упирается в настройку точки'
);

-- ── Операционный тумблер НЕ обходит entitlement ──────────────
UPDATE locations
SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{reservations}',
                         '{"enabled": true}'::jsonb)
WHERE id = '81000000-0000-4000-8000-00000000000a';
SELECT throws_ok(
  $$ SELECT submit_reservation('81000000-0000-4000-8000-00000000000a',
       '83000000-0000-4000-8000-000000000004', 'Guest', '0501234567', 2,
       NOW() + INTERVAL '2 hours') $$,
  'P0001', 'module_disabled',
  'включённый тумблер настроек не заменяет entitlement (POS-org без Reserve)'
);
SELECT throws_ok(
  $$ SELECT reservation_availability('81000000-0000-4000-8000-00000000000a',
       CURRENT_DATE + 1, 2) $$,
  'P0001', 'module_disabled',
  'live-доступность закрыта без entitlement независимо от настроек'
);

-- ── POS+Menu ─────────────────────────────────────────────────
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000e', 'pos_operate'),
  'POS+Menu: касса работает');
SELECT ok(org_has_capability('80000000-0000-4000-8000-00000000000e', 'public_menu'),
  'POS+Menu: QR-витрина работает');
SELECT ok(NOT org_has_capability('80000000-0000-4000-8000-00000000000e', 'online_orders'),
  'POS+Menu: корзины нет (Orders не куплен)');
SELECT ok(NOT org_has_capability('80000000-0000-4000-8000-00000000000e', 'reservations_desk'),
  'POS+Menu: стола хостес нет (Reserve не куплен)');

-- ── Все продукты ─────────────────────────────────────────────
SELECT is(
  (SELECT COUNT(*)::int FROM unnest(ARRAY[
    'catalog_manage', 'public_menu', 'online_orders', 'orders_desk',
    'public_reservations', 'reservations_desk', 'pos_operate', 'pos_reports'
  ]) c WHERE org_has_capability('80000000-0000-4000-8000-00000000000f', c)),
  8,
  'все продукты: доступны все восемь capabilities'
);

-- ── Без продуктов: серверные пути закрыты ────────────────────
SELECT is(
  (SELECT COUNT(*)::int FROM unnest(ARRAY[
    'catalog_manage', 'public_menu', 'online_orders', 'orders_desk',
    'public_reservations', 'reservations_desk', 'pos_operate', 'pos_reports'
  ]) c WHERE org_has_capability('80000000-0000-4000-8000-000000000010', c)),
  0,
  'без продуктов: ни одной capability'
);
SELECT is(
  (org_public_menu_gates('80000000-0000-4000-8000-000000000010') ->> 'public_menu')::boolean,
  false,
  'без продуктов: витрина закрыта'
);
SELECT throws_ok(
  $$ SELECT submit_online_order('81000000-0000-4000-8000-000000000010',
       '83000000-0000-4000-8000-000000000005', 'Guest', '0501234567', '[]'::jsonb) $$,
  'P0001', 'module_disabled',
  'без продуктов: приём заказа закрыт'
);
SELECT throws_ok(
  $$ SELECT submit_reservation('81000000-0000-4000-8000-000000000010',
       '83000000-0000-4000-8000-000000000006', 'Guest', '0501234567', 2,
       NOW() + INTERVAL '2 hours') $$,
  'P0001', 'module_disabled',
  'без продуктов: бронь закрыта'
);

-- Статус существующей заявки закрывается вместе с продуктом (protected read)
INSERT INTO online_orders (org_id, location_id, client_uuid, customer_name,
  customer_phone, items, subtotal, total)
VALUES ('80000000-0000-4000-8000-00000000000b', '81000000-0000-4000-8000-00000000000b',
  '83000000-0000-4000-8000-000000000007', 'Guest', '0501234567', '[]'::jsonb, 0, 0);
SELECT throws_ok(
  $$ SELECT get_online_order_status('83000000-0000-4000-8000-000000000007') $$,
  'P0001', 'module_disabled',
  'статус заявки — защищённое чтение: без продукта Orders закрыт'
);

-- ── POS-гейты: смена и отчёт ─────────────────────────────────
-- Организация без продуктов: устройство есть, но касса закрыта сервером.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"82000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000010","location_id":"81000000-0000-4000-8000-000000000010"}}',
  true
);
SELECT throws_ok(
  $$ SELECT open_shift('84000000-0000-4000-8000-000000000001', 0) $$,
  'P0001', 'module_disabled',
  'без продуктов: смена не открывается (module_disabled)'
);
SELECT throws_ok(
  $$ SELECT place_order('83000000-0000-4000-8000-000000000008',
       '84000000-0000-4000-8000-000000000001', 'takeaway', NULL, '[]'::jsonb) $$,
  'P0001', 'module_disabled',
  'без продуктов: продажа не проходит (module_disabled)'
);

-- POS-организация проходит гейт и падает дальше по прежней причине.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"82000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"80000000-0000-4000-8000-00000000000a","location_id":"81000000-0000-4000-8000-00000000000a"}}',
  true
);
SELECT throws_ok(
  $$ SELECT open_shift('84000000-0000-4000-8000-000000000001', 0) $$,
  'P0001', 'invalid staff',
  'POS: смена проходит capability-гейт (падает дальше по staff)'
);

-- sales_report: владелец организации без продуктов не читает POS-отчёт,
-- владелец полной организации — читает.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"82000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000010"}}',
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT sales_report(NOW() - INTERVAL '1 day', NOW()) $$,
  'P0001', 'module_disabled',
  'без продуктов: sales_report закрыт (нет pos_reports)'
);
RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"82000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"80000000-0000-4000-8000-00000000000f"}}',
  true
);
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT sales_report(NOW() - INTERVAL '1 day', NOW()) $$,
  'все продукты: sales_report доступен владельцу'
);
RESET ROLE;

-- ── Отключение блокирует, но данные сохраняются ──────────────
SELECT set_config('app.allow_developer_grant_change', '', true);
SELECT lives_ok(
  $$ SELECT revoke_org_product('80000000-0000-4000-8000-00000000000b', 'menu') $$,
  'Menu приостановлен оператором'
);
SELECT is(
  (org_public_menu_gates('80000000-0000-4000-8000-00000000000b') ->> 'public_menu')::boolean,
  false,
  'после приостановки витрина закрыта'
);
SELECT is(
  (SELECT COUNT(*)::int FROM online_orders
   WHERE org_id = '80000000-0000-4000-8000-00000000000b'),
  1,
  'данные организации не удалены'
);
SELECT lives_ok(
  $$ SELECT grant_org_product('80000000-0000-4000-8000-00000000000b', 'menu') $$,
  'повторная выдача возвращает продукт'
);
SELECT is(
  (org_public_menu_gates('80000000-0000-4000-8000-00000000000b') ->> 'public_menu')::boolean,
  true,
  'после повторной выдачи доступ к сохранённым данным восстановлен'
);

-- ── Developer: всё доступно бессрочно ────────────────────────
SELECT is(
  (SELECT COUNT(*)::int FROM unnest(ARRAY[
    'catalog_manage', 'public_menu', 'online_orders', 'orders_desk',
    'public_reservations', 'reservations_desk', 'pos_operate', 'pos_reports'
  ]) c WHERE org_has_capability('80000000-0000-4000-8000-000000000011', c)),
  8,
  'developer: доступны все capabilities'
);
SELECT is(
  (SELECT COUNT(*)::int FROM organization_products
   WHERE org_id = '80000000-0000-4000-8000-000000000011'
     AND source = 'developer' AND expires_at IS NULL AND status = 'active'),
  4,
  'developer: все четыре продукта бессрочны (source=developer)'
);
SELECT throws_ok(
  $$ UPDATE organization_products SET status = 'expired'
     WHERE org_id = '80000000-0000-4000-8000-000000000011' AND product = 'pos' $$,
  'P0001', 'developer_grant_protected',
  'developer-грант не просрочивается обычным путём записи'
);

SELECT * FROM finish();
ROLLBACK;
