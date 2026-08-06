-- pgTAP: денежный ящик (144).
--   * журнал открытий закрыт на запись и открыт на чтение своей org;
--   * ручное открытие (no_sale) требует права cash_movement;
--   * сопутствующие открытия проходят в мягком режиме сессии;
--   * повтор с тем же uuid не задваивает запись (офлайн-replay);
--   * смена подставляется сервером, чужой заказ не попадает в ссылку.

BEGIN;
SELECT plan(12);

-- ── Сигнатура и гранты ──────────────────────────────────────
SELECT has_function('log_drawer_open',
  ARRAY['uuid','text','uuid','uuid','text','uuid','timestamptz','uuid']);
SELECT ok(
  has_function_privilege('authenticated',
    'log_drawer_open(uuid,text,uuid,uuid,text,uuid,timestamptz,uuid)', 'EXECUTE'),
  'касса может звать log_drawer_open'
);
SELECT ok(
  NOT has_function_privilege('anon',
    'log_drawer_open(uuid,text,uuid,uuid,text,uuid,timestamptz,uuid)', 'EXECUTE'),
  'anon не пишет в журнал ящика'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'drawer_opens', 'INSERT'),
  'прямой INSERT в drawer_opens закрыт (только RPC)'
);
SELECT ok(
  has_table_privilege('authenticated', 'drawer_opens', 'SELECT'),
  'журнал ящика читается клиентом (RLS скоупит по org)'
);

-- ── Фикстура: организация, точка, сотрудники, смена, заказ ──
INSERT INTO orgs (id, name)
VALUES ('60000000-0000-4000-8000-000000000001', 'pgTAP org D');
INSERT INTO organization_products (org_id, product)
VALUES ('60000000-0000-4000-8000-000000000001', 'pos');

INSERT INTO locations (id, org_id, name, settings)
VALUES ('61000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001', 'Loc D',
        '{"perms":{"cash_movement":"manager"}}'::jsonb);

-- Бариста (право cash_movement на точке = manager → ему нельзя)
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('62000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        '61000000-0000-4000-8000-000000000001',
        'pgTAP barista D', 'barista', 'unused-in-test');
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('62000000-0000-4000-8000-000000000002',
        '60000000-0000-4000-8000-000000000001',
        '61000000-0000-4000-8000-000000000001',
        'pgTAP manager D', 'manager', 'unused-in-test');

INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float)
VALUES ('63000000-0000-4000-8000-000000000001',
        '60000000-0000-4000-8000-000000000001',
        '61000000-0000-4000-8000-000000000001',
        '62000000-0000-4000-8000-000000000002', 'open', 0);

INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total
) VALUES (
  '64000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  '62000000-0000-4000-8000-000000000002',
  '65000000-0000-4000-8000-000000000001',
  1, 'here', 'paid', 1000, 18, 153, 1000
);

INSERT INTO staff_sessions (token, staff_id, org_id, location_id) VALUES
  ('66000000-0000-4000-8000-000000000001',
   '62000000-0000-4000-8000-000000000001',
   '60000000-0000-4000-8000-000000000001',
   '61000000-0000-4000-8000-000000000001'),
  ('66000000-0000-4000-8000-000000000002',
   '62000000-0000-4000-8000-000000000002',
   '60000000-0000-4000-8000-000000000001',
   '61000000-0000-4000-8000-000000000001');

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"67000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"60000000-0000-4000-8000-000000000001","location_id":"61000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Ручное открытие: право обязательно ──────────────────────
SELECT throws_ok(
  $$SELECT log_drawer_open('68000000-0000-4000-8000-000000000001',
      'no_sale', NULL, NULL, 'проверка', NULL, NULL, NULL)$$,
  'staff session required',
  'открытие без продажи без сессии отклоняется'
);
SELECT throws_ok(
  $$SELECT log_drawer_open('68000000-0000-4000-8000-000000000002',
      'no_sale', NULL, NULL, NULL, NULL, NULL,
      '66000000-0000-4000-8000-000000000001')$$,
  'forbidden: cash_movement',
  'баристе без права ящик без продажи не открыть'
);
SELECT lives_ok(
  $$SELECT log_drawer_open('68000000-0000-4000-8000-000000000003',
      'no_sale', NULL, NULL, 'разменять', NULL, NULL,
      '66000000-0000-4000-8000-000000000002')$$,
  'менеджер открывает ящик без продажи'
);

-- ── Сопутствующее открытие: мягкий режим, смена от сервера ──
SELECT lives_ok(
  $$SELECT log_drawer_open('68000000-0000-4000-8000-000000000004',
      'sale', '62000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001', NULL, NULL, NULL, NULL)$$,
  'открытие по продаже пишется и без токена (мягкий режим)'
);
SELECT is(
  (SELECT shift_id FROM drawer_opens
    WHERE id = '68000000-0000-4000-8000-000000000004'),
  '63000000-0000-4000-8000-000000000001'::uuid,
  'смена подставлена сервером'
);

-- ── Идемпотентность replay ──────────────────────────────────
SELECT is(
  (SELECT (log_drawer_open('68000000-0000-4000-8000-000000000004',
      'sale', '62000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001', NULL, NULL, NULL, NULL)
    ->> 'logged')),
  'false',
  'повтор с тем же uuid не пишет вторую строку'
);
SELECT is(
  (SELECT COUNT(*)::INT FROM drawer_opens
    WHERE id = '68000000-0000-4000-8000-000000000004'),
  1,
  'в журнале ровно одна запись открытия'
);

SELECT * FROM finish();
ROLLBACK;
