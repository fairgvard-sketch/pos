-- pgTAP: поставщики и накладные (077) — средневзвешенная себестоимость,
-- идемпотентность документа прихода, денежная оценка журнала (value),
-- фасовки и RLS. Запуск: supabase test db (production не затрагивается).

BEGIN;
SELECT plan(24);

SELECT has_table('suppliers');
SELECT has_table('supply_docs');
SELECT has_table('supply_packagings');

-- ── Фикстуры ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('41000000-0000-4000-8000-000000000001', 'pgTAP org A'),
  ('41000000-0000-4000-8000-000000000002', 'pgTAP org B');

INSERT INTO locations (id, org_id, name) VALUES
  ('41100000-0000-4000-8000-000000000001',
   '41000000-0000-4000-8000-000000000001', 'Loc A'),
  ('41100000-0000-4000-8000-000000000002',
   '41000000-0000-4000-8000-000000000002', 'Loc B');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('41200000-0000-4000-8000-000000000001',
        '41000000-0000-4000-8000-000000000001',
        '41100000-0000-4000-8000-000000000001',
        'pgTAP owner', 'owner', 'unused-in-test');

INSERT INTO menu_categories (id, org_id, location_id, name)
VALUES ('41300000-0000-4000-8000-000000000001',
        '41000000-0000-4000-8000-000000000001',
        '41100000-0000-4000-8000-000000000001', 'Выпечка');

-- Товар с учётом: cost 900 агорот, остаток 10
INSERT INTO menu_items (id, org_id, category_id, name, price, cost, track_inventory, stock)
VALUES ('41400000-0000-4000-8000-000000000001',
        '41000000-0000-4000-8000-000000000001',
        '41300000-0000-4000-8000-000000000001', 'Круассан', 1600, 900, TRUE, 10);

-- Расходники: молоко (мл, cost за литр), стакан (шт), мука (г, без cost)
INSERT INTO supply_items (id, org_id, location_id, name, unit, stock, cost) VALUES
  ('41600000-0000-4000-8000-000000000001',
   '41000000-0000-4000-8000-000000000001',
   '41100000-0000-4000-8000-000000000001', 'Молоко', 'мл', 4000, 700),
  ('41600000-0000-4000-8000-000000000002',
   '41000000-0000-4000-8000-000000000001',
   '41100000-0000-4000-8000-000000000001', 'Стакан', 'шт', 100, 50),
  ('41600000-0000-4000-8000-000000000003',
   '41000000-0000-4000-8000-000000000001',
   '41100000-0000-4000-8000-000000000001', 'Мука', 'г', 0, NULL),
  ('41600000-0000-4000-8000-000000000004',
   '41000000-0000-4000-8000-000000000002',
   '41100000-0000-4000-8000-000000000002', 'Чужой сахар', 'г', 100, 200);

-- Рецепт товара: 1 стакан на единицу при любом типе заказа
INSERT INTO variant_supplies (org_id, menu_item_id, variant_id, supply_item_id, qty, takeaway_only)
VALUES ('41000000-0000-4000-8000-000000000001',
        '41400000-0000-4000-8000-000000000001', NULL,
        '41600000-0000-4000-8000-000000000002', 1, FALSE);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"41c00000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"41000000-0000-4000-8000-000000000001","location_id":"41100000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Поставщик через RPC ──────────────────────────────────────
CREATE TEMP TABLE sup AS
SELECT ((upsert_supplier(NULL, 'Тнува', '0501234567')) ->> 'id')::UUID AS id;

SELECT is((SELECT count(*) FROM suppliers WHERE name = 'Тнува'),
  1::bigint, 'upsert_supplier создаёт поставщика');

-- ── Приход-накладная: средневзвешенный cost, total, value ────
-- Молоко 6000 мл по 800/л, стакан 100 шт по 60, мука 25000 г по 320/кг
CREATE TEMP TABLE recv1 AS
SELECT receive_stock(
  '41200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000001","qty":6000,"unit_cost":800},
    {"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000002","qty":100,"unit_cost":60},
    {"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000003","qty":25000,"unit_cost":320}]'::jsonb,
  NULL, NULL,
  (SELECT id FROM sup), 'INV-77',
  '41d00000-0000-4000-8000-000000000001'
) AS r;

SELECT is((SELECT stock FROM supply_items WHERE id = '41600000-0000-4000-8000-000000000001'),
  10000, 'приход: молоко 4000+6000 мл');
SELECT is((SELECT cost FROM supply_items WHERE id = '41600000-0000-4000-8000-000000000001'),
  760, 'средневзвешенный cost молока: (4000×700+6000×800)/10000 = 760');
SELECT is((SELECT cost FROM supply_items WHERE id = '41600000-0000-4000-8000-000000000002'),
  55, 'средневзвешенный cost стакана: (100×50+100×60)/200 = 55');
SELECT is((SELECT cost FROM supply_items WHERE id = '41600000-0000-4000-8000-000000000003'),
  320, 'первый приход без базы: cost = цена прихода');
SELECT is((SELECT total FROM supply_docs WHERE id = '41d00000-0000-4000-8000-000000000001'),
  18800::bigint, 'total накладной: 4800 (молоко) + 6000 (стаканы) + 8000 (мука)');
SELECT is(
  (SELECT doc_no FROM supply_docs
   WHERE id = '41d00000-0000-4000-8000-000000000001'
     AND supplier_id = (SELECT id FROM sup)),
  'INV-77', 'накладная связана с поставщиком и несёт его номер');
SELECT is(
  (SELECT value FROM stock_movements
   WHERE batch_id = '41d00000-0000-4000-8000-000000000001'
     AND supply_item_id = '41600000-0000-4000-8000-000000000001'),
  4800::bigint, 'строка журнала: value молока = round(6000×800/1000)');

-- ── Идемпотентность: повтор того же p_doc_id ─────────────────
CREATE TEMP TABLE recv1_replay AS
SELECT receive_stock(
  '41200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000001","qty":6000,"unit_cost":800},
    {"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000002","qty":100,"unit_cost":60},
    {"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000003","qty":25000,"unit_cost":320}]'::jsonb,
  NULL, NULL,
  (SELECT id FROM sup), 'INV-77',
  '41d00000-0000-4000-8000-000000000001'
) AS r;

SELECT is((SELECT (r ->> 'duplicate')::boolean FROM recv1_replay),
  TRUE, 'повтор p_doc_id помечен duplicate');
SELECT is((SELECT stock FROM supply_items WHERE id = '41600000-0000-4000-8000-000000000001'),
  10000, 'повтор не удвоил остаток молока');
SELECT is(
  (SELECT count(*) FROM stock_movements
   WHERE batch_id = '41d00000-0000-4000-8000-000000000001'),
  3::bigint, 'повтор не добавил строк журнала');

-- ── update_cost=TRUE: ручное «установить точно» ──────────────
CREATE TEMP TABLE recv2 AS
SELECT receive_stock(
  '41200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000002","qty":10,"unit_cost":100,"update_cost":true}]'::jsonb
) AS r;

SELECT is((SELECT cost FROM supply_items WHERE id = '41600000-0000-4000-8000-000000000002'),
  100, 'update_cost=true устанавливает cost точно, минуя среднее');

-- ── Продажа: снапшот cost и value в журнале ──────────────────
INSERT INTO orders (id, org_id, location_id, staff_id, client_uuid, daily_number,
                    order_type, status, subtotal, vat_rate, vat_amount, total)
VALUES ('41900000-0000-4000-8000-000000000001',
        '41000000-0000-4000-8000-000000000001',
        '41100000-0000-4000-8000-000000000001',
        '41200000-0000-4000-8000-000000000001',
        '41a00000-0000-4000-8000-000000000001', 1, 'here', 'open', 3200, 18, 488, 3200);

INSERT INTO order_items (id, org_id, order_id, menu_item_id, name, unit_price, qty, line_total)
VALUES ('41b00000-0000-4000-8000-000000000001',
        '41000000-0000-4000-8000-000000000001',
        '41900000-0000-4000-8000-000000000001',
        '41400000-0000-4000-8000-000000000001', 'Круассан', 1600, 2, 3200);

SELECT is(
  (SELECT value FROM stock_movements
   WHERE order_item_id = '41b00000-0000-4000-8000-000000000001'
     AND menu_item_id = '41400000-0000-4000-8000-000000000001'),
  -1800::bigint, 'sale товара: value = −qty×cost (2×900)');
SELECT is(
  (SELECT value FROM stock_movements
   WHERE order_item_id = '41b00000-0000-4000-8000-000000000001'
     AND supply_item_id = '41600000-0000-4000-8000-000000000002'),
  -200::bigint, 'sale расходника: value = −2×100 (текущий cost стакана)');

-- ── Инвентаризация и списание: недостача в деньгах ───────────
CREATE TEMP TABLE count1 AS
SELECT stock_take(
  '41200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000001","counted":9000}]'::jsonb
) AS r;

SELECT is(
  (SELECT value FROM stock_movements
   WHERE type = 'count' AND supply_item_id = '41600000-0000-4000-8000-000000000001'),
  -760::bigint, 'count: value дельты = round(−1000×760/1000)');

CREATE TEMP TABLE waste1 AS
SELECT add_waste(
  '41200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000001","qty":500,"reason":"прокисло"}]'::jsonb
) AS r;

SELECT is(
  (SELECT value FROM stock_movements
   WHERE type = 'waste' AND supply_item_id = '41600000-0000-4000-8000-000000000001'),
  -380::bigint, 'waste: value = round(−500×760/1000)');

-- ── Фасовки: своя org пишет, чужой расходник отклонён ────────
SET LOCAL ROLE authenticated;

INSERT INTO supply_packagings (org_id, supply_item_id, name, qty)
VALUES ('41000000-0000-4000-8000-000000000001',
        '41600000-0000-4000-8000-000000000003', 'Мешок 25 кг', 25000);

SELECT is((SELECT count(*) FROM supply_packagings
   WHERE supply_item_id = '41600000-0000-4000-8000-000000000003'),
  1::bigint, 'authenticated заводит фасовку своей org');

SELECT throws_ok(
  $$ INSERT INTO supply_packagings (org_id, supply_item_id, name, qty)
     VALUES ('41000000-0000-4000-8000-000000000001',
             '41600000-0000-4000-8000-000000000004', 'Мешок 10 кг', 10000) $$,
  '42501', NULL, 'фасовка на чужой расходник отклонена RLS');

-- ── RLS: org B не видит поставщиков и накладных org A ────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"41c00000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"41000000-0000-4000-8000-000000000002","location_id":"41100000-0000-4000-8000-000000000002"}}',
  true
);

SELECT is((SELECT count(*) FROM suppliers), 0::bigint, 'org B не видит поставщиков org A');
SELECT is((SELECT count(*) FROM supply_docs), 0::bigint, 'org B не видит накладных org A');

RESET ROLE;

-- ── Чужой поставщик в приходе отклоняется ────────────────────
INSERT INTO suppliers (id, org_id, name)
VALUES ('41e00000-0000-4000-8000-000000000001',
        '41000000-0000-4000-8000-000000000002', 'Чужой поставщик');

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"41c00000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"41000000-0000-4000-8000-000000000001","location_id":"41100000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$ SELECT receive_stock(
       '41200000-0000-4000-8000-000000000001',
       '[{"kind":"supply","supply_item_id":"41600000-0000-4000-8000-000000000001","qty":100,"unit_cost":700}]'::jsonb,
       NULL, NULL, '41e00000-0000-4000-8000-000000000001') $$,
  'supplier not found', 'приход с поставщиком чужой org отклонён');

SELECT * FROM finish();
ROLLBACK;
