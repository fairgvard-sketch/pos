-- pgTAP: server-side Israeli standard-business cash limit (migration 068).
-- Runs only against the local Supabase stack.

BEGIN;
SELECT plan(10);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'pay_order(uuid,jsonb,integer,uuid,timestamptz)',
    'EXECUTE'
  ),
  'authenticated can execute the guarded pay_order'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'pay_order_unchecked(uuid,jsonb,integer,uuid,timestamptz)',
    'EXECUTE'
  ),
  'authenticated cannot bypass the guard through pay_order_unchecked'
);

INSERT INTO orgs (id, name)
VALUES ('30000000-0000-4000-8000-000000000001', 'cash-limit org');

INSERT INTO locations (id, org_id, name)
VALUES (
  '31000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'cash-limit location'
);

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES (
  '32000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001',
  'cash-limit owner', 'owner', 'unused-in-test'
);

INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float)
VALUES (
  '33000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  'open', 0
);

INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total
) VALUES
  (
    '34000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    '32000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000001',
    1, 'here', 'open', 600000, 18, 91525, 600000
  ),
  (
    '34000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    '32000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000002',
    2, 'here', 'open', 600001, 18, 91526, 600001
  ),
  (
    '34000000-0000-4000-8000-000000000003',
    '30000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    '32000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000003',
    3, 'here', 'open', 600001, 18, 91526, 600001
  ),
  (
    '34000000-0000-4000-8000-000000000004',
    '30000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    '32000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000004',
    4, 'here', 'open', 1000, 18, 153, 1000
  );

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"36000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"30000000-0000-4000-8000-000000000001","location_id":"31000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT lives_ok(
  $$ SELECT pay_order(
    '34000000-0000-4000-8000-000000000001',
    '[{"method":"cash","amount":600000,"tendered":600000,"change_due":0}]',
    0, '37000000-0000-4000-8000-000000000001', NOW()
  ) $$,
  '6,000 NIS may be paid fully in cash'
);

SELECT is(
  (SELECT count(*) FROM payments WHERE order_id = '34000000-0000-4000-8000-000000000001'),
  1::bigint,
  'threshold payment creates one financial row'
);

SELECT lives_ok(
  $$ SELECT pay_order(
    '34000000-0000-4000-8000-000000000002',
    '[{"method":"cash","amount":60000},{"method":"card","amount":540001}]',
    0, '37000000-0000-4000-8000-000000000002', NOW()
  ) $$,
  'above threshold, exactly 10% cash plus card is allowed'
);

SELECT is(
  (
    SELECT sum(amount) FROM payments
    WHERE order_id = '34000000-0000-4000-8000-000000000002' AND method = 'cash'
  ),
  60000::bigint,
  'mixed payment records the legal cash maximum'
);

SELECT throws_ok(
  $$ SELECT pay_order(
    '34000000-0000-4000-8000-000000000003',
    '[{"method":"cash","amount":60001},{"method":"card","amount":540000}]',
    0, '37000000-0000-4000-8000-000000000003', NOW()
  ) $$,
  '22023', 'cash_limit_exceeded',
  'one agorot above the legal cash maximum is rejected'
);

SELECT is(
  (SELECT count(*) FROM payments WHERE order_id = '34000000-0000-4000-8000-000000000003'),
  0::bigint,
  'rejected cash payment writes no financial rows'
);

SELECT throws_ok(
  $$ SELECT pay_order(
    '34000000-0000-4000-8000-000000000004',
    '[{"method":"card","amount":1001}]',
    0, '37000000-0000-4000-8000-000000000004', NOW()
  ) $$,
  '22023', 'payment_total_mismatch',
  'payment amount must equal the payable total'
);

SELECT is(
  (SELECT count(*) FROM payments WHERE order_id = '34000000-0000-4000-8000-000000000004'),
  0::bigint,
  'mismatched payment writes no financial rows'
);

SELECT * FROM finish();
ROLLBACK;
