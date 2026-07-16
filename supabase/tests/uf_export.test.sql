-- pgTAP: выборка данных Единого формата 1.31 (миграция 073).
-- Права, staff-гейт 'manage', скоуп по точке и форма документов.

BEGIN;
SELECT plan(10);

-- ── Гранты ───────────────────────────────────────────────────
SELECT ok(
  has_function_privilege('authenticated', 'uf_export_info(uuid)', 'EXECUTE'),
  'authenticated can execute uf_export_info'
);
SELECT ok(
  NOT has_function_privilege('anon', 'uf_export_info(uuid)', 'EXECUTE'),
  'anon cannot execute uf_export_info'
);
SELECT ok(
  has_function_privilege(
    'authenticated',
    'uf_export_documents(uuid,date,date,timestamptz,uuid,integer)',
    'EXECUTE'
  ),
  'authenticated can execute uf_export_documents'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'uf_export_documents(uuid,date,date,timestamptz,uuid,integer)',
    'EXECUTE'
  ),
  'anon cannot execute uf_export_documents'
);

-- ── Данные ───────────────────────────────────────────────────
INSERT INTO orgs (id, name)
VALUES ('40000000-0000-4000-8000-000000000001', 'uf org');

INSERT INTO locations (id, org_id, name, receipt_business_name, receipt_tax_id)
VALUES (
  '41000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'uf location', 'Bulochka', '123456789'
);

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('42000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001',
   '41000000-0000-4000-8000-000000000001',
   'uf owner', 'owner', 'unused-in-test'),
  ('42000000-0000-4000-8000-000000000002',
   '40000000-0000-4000-8000-000000000001',
   '41000000-0000-4000-8000-000000000001',
   'uf barista', 'barista', 'unused-in-test');

INSERT INTO staff_sessions (token, staff_id, org_id, location_id) VALUES
  ('43000000-0000-4000-8000-000000000001',
   '42000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001',
   '41000000-0000-4000-8000-000000000001'),
  ('43000000-0000-4000-8000-000000000002',
   '42000000-0000-4000-8000-000000000002',
   '40000000-0000-4000-8000-000000000001',
   '41000000-0000-4000-8000-000000000001');

INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float)
VALUES (
  '44000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  'open', 0
);

-- Оплаченный заказ с номером чека (фискальный) + позиция + оплата
INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total,
  receipt_number, paid_at
) VALUES (
  '45000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  '46000000-0000-4000-8000-000000000001',
  1, 'here', 'paid', 2800, 18, 427, 2800,
  1042, '2026-07-15T10:00:00Z'
);

INSERT INTO order_items (org_id, order_id, name, unit_price, qty, line_total)
VALUES (
  '40000000-0000-4000-8000-000000000001',
  '45000000-0000-4000-8000-000000000001',
  'קפוצ׳ינו', 1400, 2, 2800
);

INSERT INTO payments (org_id, order_id, shift_id, method, amount)
VALUES (
  '40000000-0000-4000-8000-000000000001',
  '45000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000001',
  'cash', 2800
);

-- Возврат по заказу (документ 330)
INSERT INTO refunds (
  id, org_id, order_id, shift_id, staff_id,
  amount, method, reason, location_id, refund_number, created_at
) VALUES (
  '47000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '45000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  1400, 'cash', 'test', '41000000-0000-4000-8000-000000000001',
  7, '2026-07-15T11:00:00Z'
);

-- ── Контекст устройства ──────────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"40000000-0000-4000-8000-000000000001","location_id":"41000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Функциональные проверки ──────────────────────────────────
SELECT is(
  uf_export_info('43000000-0000-4000-8000-000000000001') ->> 'tax_id',
  '123456789',
  'uf_export_info returns the business tax id'
);

SELECT is(
  jsonb_array_length(
    uf_export_documents(
      '43000000-0000-4000-8000-000000000001',
      '2026-07-15', '2026-07-15', NULL, NULL, 200
    ) -> 'documents'
  ),
  2,
  'both the sale and the refund fall into the period'
);

SELECT is(
  uf_export_documents(
    '43000000-0000-4000-8000-000000000001',
    '2026-07-15', '2026-07-15', NULL, NULL, 200
  ) -> 'documents' -> 0 ->> 'kind',
  'order',
  'the sale precedes the refund chronologically'
);

SELECT is(
  uf_export_documents(
    '43000000-0000-4000-8000-000000000001',
    '2026-07-15', '2026-07-15', NULL, NULL, 200
  ) -> 'documents' -> 1 ->> 'vat_rate',
  '18.00',
  'the refund inherits the vat rate of its order'
);

SELECT is(
  jsonb_array_length(
    uf_export_documents(
      '43000000-0000-4000-8000-000000000001',
      '2026-07-01', '2026-07-14', NULL, NULL, 200
    ) -> 'documents'
  ),
  0,
  'documents outside the range are not returned'
);

SELECT throws_ok(
  $$ SELECT uf_export_documents(
    '43000000-0000-4000-8000-000000000002',
    '2026-07-15', '2026-07-15', NULL, NULL, 200
  ) $$,
  'forbidden: manage',
  'a barista session cannot export fiscal data'
);

SELECT * FROM finish();
ROLLBACK;
