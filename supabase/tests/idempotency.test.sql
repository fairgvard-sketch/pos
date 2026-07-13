-- pgTAP: реальный replay pay_order с одним p_payment_uuid.
-- Запуск: supabase test db (локальный стек, production не затрагивается).

BEGIN;
SELECT plan(7);

SELECT has_table('op_log');
SELECT has_column('op_log', 'op_uuid');
SELECT has_column('op_log', 'result');

-- Минимальная рабочая продажа: организация, точка, сотрудник, открытая смена,
-- open-заказ. RPC вызывается дважды с одним payment UUID.
INSERT INTO orgs (id, name)
VALUES ('10000000-0000-4000-8000-000000000001', 'pgTAP org');

INSERT INTO locations (id, org_id, name)
VALUES (
  '11000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'pgTAP location'
);

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES (
  '12000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001',
  'pgTAP owner', 'owner', 'unused-in-test'
);

INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float)
VALUES (
  '13000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001',
  'open', 0
);

INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total
) VALUES (
  '14000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001',
  '15000000-0000-4000-8000-000000000001',
  1, 'here', 'open', 1000, 18, 153, 1000
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"10000000-0000-4000-8000-000000000001","location_id":"11000000-0000-4000-8000-000000000001"}}',
  true
);

CREATE TEMP TABLE first_pay AS
SELECT pay_order(
  '14000000-0000-4000-8000-000000000001',
  '[{"method":"cash","amount":1000,"tendered":1000,"change_due":0}]'::jsonb,
  0,
  '17000000-0000-4000-8000-000000000001',
  NOW()
)::jsonb AS result;

CREATE TEMP TABLE replay_pay AS
SELECT pay_order(
  '14000000-0000-4000-8000-000000000001',
  '[{"method":"cash","amount":1000,"tendered":1000,"change_due":0}]'::jsonb,
  0,
  '17000000-0000-4000-8000-000000000001',
  NOW()
)::jsonb AS result;

SELECT is(
  (SELECT result FROM replay_pay),
  (SELECT result FROM first_pay),
  'replay возвращает тот же результат и receipt_number'
);
SELECT is(
  (SELECT count(*) FROM payments WHERE order_id = '14000000-0000-4000-8000-000000000001'),
  1::bigint,
  'replay не создаёт второй платёж'
);
SELECT is(
  (SELECT counter FROM receipt_counters WHERE location_id = '11000000-0000-4000-8000-000000000001'),
  1,
  'replay не тратит второй номер чека'
);
SELECT is(
  (SELECT count(*) FROM op_log WHERE op_uuid = '17000000-0000-4000-8000-000000000001'),
  1::bigint,
  'idempotency log содержит одну операцию'
);

SELECT * FROM finish();
ROLLBACK;
