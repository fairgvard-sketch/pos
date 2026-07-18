-- pgTAP: staff-сессии горячего потока (086, мягкий режим).
-- Обёртки place/pay/open/append/mark_* валидируют p_staff_session,
-- impl-функции закрыты от клиентов, автор операции остаётся p_staff_id.

BEGIN;
SELECT plan(11);

-- ── Сигнатуры и гранты ──────────────────────────────────────
SELECT has_function('require_staff_session');
SELECT has_function('place_order',
  ARRAY['uuid','uuid','text','text','jsonb','jsonb','text','timestamptz','uuid']);
SELECT has_function('pay_order',
  ARRAY['uuid','jsonb','integer','uuid','timestamptz','uuid']);
SELECT ok(
  NOT has_function_privilege('authenticated',
    'place_order_impl(uuid,uuid,text,text,jsonb,jsonb,text,timestamptz)', 'EXECUTE'),
  'place_order_impl закрыта от клиентов'
);
SELECT ok(
  NOT has_function_privilege('authenticated',
    'pay_order_impl(uuid,jsonb,integer,uuid,timestamptz)', 'EXECUTE'),
  'pay_order_impl закрыта от клиентов'
);
SELECT ok(
  has_function_privilege('authenticated',
    'mark_item_ready(uuid,boolean,uuid)', 'EXECUTE'),
  'бариста зовёт новую сигнатуру mark_item_ready'
);

-- ── Фикстура: организация, точка, сотрудник, смена, открытый заказ ──
INSERT INTO orgs (id, name)
VALUES ('50000000-0000-4000-8000-000000000001', 'pgTAP org H');
INSERT INTO locations (id, org_id, name)
VALUES ('51000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001', 'Loc H');
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('52000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        '51000000-0000-4000-8000-000000000001',
        'pgTAP barista', 'barista', 'unused-in-test');
INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float)
VALUES ('53000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        '51000000-0000-4000-8000-000000000001',
        '52000000-0000-4000-8000-000000000001', 'open', 0);
INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total
) VALUES (
  '54000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001',
  '55000000-0000-4000-8000-000000000001',
  1, 'here', 'open', 1000, 18, 153, 1000
);

-- Валидная и протухшая сессии сотрудника
INSERT INTO staff_sessions (token, staff_id, org_id, location_id)
VALUES ('56000000-0000-4000-8000-000000000001',
        '52000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        '51000000-0000-4000-8000-000000000001');
INSERT INTO staff_sessions (token, staff_id, org_id, location_id, expires_at)
VALUES ('56000000-0000-4000-8000-000000000002',
        '52000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        '51000000-0000-4000-8000-000000000001',
        NOW() - INTERVAL '1 hour');

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"57000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"50000000-0000-4000-8000-000000000001","location_id":"51000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Поведение require_staff_session ─────────────────────────
SELECT is(
  require_staff_session(NULL), NULL,
  'мягкий режим: NULL-токен пропускается'
);
SELECT is(
  require_staff_session('56000000-0000-4000-8000-000000000001'),
  '52000000-0000-4000-8000-000000000001'::uuid,
  'валидная сессия возвращает staff_id'
);
SELECT throws_ok(
  $$SELECT require_staff_session('56000000-0000-4000-8000-000000000002')$$,
  'staff session invalid',
  'протухшая сессия отклоняется'
);

-- ── e2e: оплата с валидной сессией проходит, автор — из payload ──
SELECT lives_ok(
  $$SELECT pay_order(
      '54000000-0000-4000-8000-000000000001',
      '[{"method":"cash","amount":1000}]'::jsonb,
      0, '58000000-0000-4000-8000-000000000001', NULL,
      '56000000-0000-4000-8000-000000000001')$$,
  'pay_order с валидной сессией проходит'
);
SELECT is(
  (SELECT status FROM orders WHERE id = '54000000-0000-4000-8000-000000000001'),
  'paid',
  'заказ оплачен, мягкий режим не мешает потоку'
);

SELECT * FROM finish();
ROLLBACK;
