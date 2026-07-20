-- pgTAP: срочность заказа и порядок станций (087).
-- set_order_urgent — идемпотентный флаг очереди бариста: org-скоуп,
-- no-op вне статусов open/paid (replay офлайн-очереди не падает).
-- reorder_menu получает p_kind='station'.

BEGIN;
SELECT plan(12);

-- ── Схема и гранты ──────────────────────────────────────────
SELECT has_column('orders', 'is_urgent', 'orders.is_urgent существует');
SELECT has_function('set_order_urgent', ARRAY['uuid', 'boolean', 'uuid']);
SELECT ok(
  has_function_privilege('authenticated', 'set_order_urgent(uuid,boolean,uuid)', 'EXECUTE'),
  'устройство может переключать срочность'
);
SELECT ok(
  NOT has_function_privilege('anon', 'set_order_urgent(uuid,boolean,uuid)', 'EXECUTE'),
  'anon не может переключать срочность'
);

-- ── Фикстура: org, точка, сотрудник, заказы, станции ────────
INSERT INTO orgs (id, name)
VALUES ('60000000-0000-4000-8000-000000000001', 'pgTAP org U'),
       ('60000000-0000-4000-8000-000000000002', 'pgTAP org U2');
INSERT INTO locations (id, org_id, name)
VALUES ('61000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001', 'Loc U');
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('62000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        '61000000-0000-4000-8000-000000000001',
        'pgTAP cashier', 'barista', 'unused-in-test');
-- Оплаченный заказ в очереди и уже выданный (вне очереди)
INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total
) VALUES
  ('64000000-0000-4000-8000-000000000001',
   '60000000-0000-4000-8000-000000000001',
   '61000000-0000-4000-8000-000000000001',
   '62000000-0000-4000-8000-000000000001',
   '65000000-0000-4000-8000-000000000001',
   1, 'here', 'paid', 1000, 18, 153, 1000),
  ('64000000-0000-4000-8000-000000000002',
   '60000000-0000-4000-8000-000000000001',
   '61000000-0000-4000-8000-000000000001',
   '62000000-0000-4000-8000-000000000001',
   '65000000-0000-4000-8000-000000000002',
   2, 'here', 'fulfilled', 1000, 18, 153, 1000);
INSERT INTO stations (id, org_id, location_id, name, sort_order)
VALUES ('66000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        '61000000-0000-4000-8000-000000000001', 'Бар', 0),
       ('66000000-0000-4000-8000-000000000002',
        '60000000-0000-4000-8000-000000000001',
        '61000000-0000-4000-8000-000000000001', 'Кухня', 1);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"67000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"60000000-0000-4000-8000-000000000001","location_id":"61000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Срочность: toggle и границы ─────────────────────────────
SELECT lives_ok(
  $$SELECT set_order_urgent('64000000-0000-4000-8000-000000000001')$$,
  'set_order_urgent проходит без staff-сессии (мягкий режим)'
);
SELECT is(
  (SELECT is_urgent FROM orders WHERE id = '64000000-0000-4000-8000-000000000001'),
  TRUE, 'заказ в очереди помечен срочным'
);
SELECT lives_ok(
  $$SELECT set_order_urgent('64000000-0000-4000-8000-000000000002', TRUE)$$,
  'fulfilled-заказ не падает (replay офлайн-очереди)'
);
SELECT is(
  (SELECT is_urgent FROM orders WHERE id = '64000000-0000-4000-8000-000000000002'),
  FALSE, 'fulfilled-заказ остаётся без флага (no-op)'
);

-- Чужая организация: снять флаг не выйдет (тихий no-op, не исключение)
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"67000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"60000000-0000-4000-8000-000000000002"}}',
  true
);
SELECT lives_ok(
  $$SELECT set_order_urgent('64000000-0000-4000-8000-000000000001', FALSE)$$,
  'чужой org не получает исключения'
);
SELECT is(
  (SELECT is_urgent FROM orders WHERE id = '64000000-0000-4000-8000-000000000001'),
  TRUE, 'чужой org не меняет флаг (org-скоуп)'
);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"67000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"60000000-0000-4000-8000-000000000001","location_id":"61000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Станции: атомарная перестановка ─────────────────────────
SELECT lives_ok(
  $$SELECT reorder_menu('station',
    '["66000000-0000-4000-8000-000000000002","66000000-0000-4000-8000-000000000001"]'::jsonb)$$,
  'reorder_menu принимает kind=station'
);
SELECT results_eq(
  $$SELECT id FROM stations
    WHERE org_id = '60000000-0000-4000-8000-000000000001'
    ORDER BY sort_order$$,
  $$VALUES ('66000000-0000-4000-8000-000000000002'::uuid),
           ('66000000-0000-4000-8000-000000000001'::uuid)$$,
  'порядок станций переставлен: кухня перед баром'
);

SELECT * FROM finish();
ROLLBACK;
