-- pgTAP: упаковка (075) — авто-списание расходников продажей и точные
-- компенсации по журналу (void/split), включая дрейф каталога после продажи.
-- Запуск: supabase test db (локальный стек, production не затрагивается).

BEGIN;
SELECT plan(21);

SELECT has_table('variant_supplies');
SELECT has_column('stock_movements', 'order_item_id');

-- ── Фикстуры: org, точка, сотрудник, каталог, расходники ─────
INSERT INTO orgs (id, name)
VALUES ('30000000-0000-4000-8000-000000000001', 'pgTAP org');

INSERT INTO locations (id, org_id, name)
VALUES ('30100000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001', 'pgTAP location');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('30200000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        '30100000-0000-4000-8000-000000000001',
        'pgTAP owner', 'owner', 'unused-in-test');

INSERT INTO menu_categories (id, org_id, location_id, name)
VALUES ('30300000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        '30100000-0000-4000-8000-000000000001', 'Кофе');

-- Капучино БЕЗ track_inventory: упаковка списывается независимо от
-- учёта самого товара
INSERT INTO menu_items (id, org_id, category_id, name, price)
VALUES ('30400000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        '30300000-0000-4000-8000-000000000001', 'Капучино', 1400);

INSERT INTO item_variants (id, org_id, item_id, name, price, is_default, sort_order) VALUES
  ('30500000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001',
   '30400000-0000-4000-8000-000000000001', 'Большой', 1600, TRUE, 0),
  ('30500000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000001',
   '30400000-0000-4000-8000-000000000001', 'Маленький', 1400, FALSE, 1);

INSERT INTO supply_items (id, org_id, location_id, name, unit, stock) VALUES
  ('30600000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001',
   '30100000-0000-4000-8000-000000000001', 'Стакан L', 'шт', 100),
  ('30600000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000001',
   '30100000-0000-4000-8000-000000000001', 'Крышка L', 'шт', 100),
  ('30600000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001',
   '30100000-0000-4000-8000-000000000001', 'Стакан S', 'шт', 50),
  ('30600000-0000-4000-8000-000000000004',
   '30000000-0000-4000-8000-000000000001',
   '30100000-0000-4000-8000-000000000001', 'Салфетка', 'шт', 100);

-- Большой → стакан L + крышка L (только с собой); Маленький → стакан S;
-- салфетка ×2 — на весь товар и при любом типе заказа
INSERT INTO variant_supplies (org_id, menu_item_id, variant_id, supply_item_id, qty, takeaway_only) VALUES
  ('30000000-0000-4000-8000-000000000001', '30400000-0000-4000-8000-000000000001',
   '30500000-0000-4000-8000-000000000001', '30600000-0000-4000-8000-000000000001', 1, TRUE),
  ('30000000-0000-4000-8000-000000000001', '30400000-0000-4000-8000-000000000001',
   '30500000-0000-4000-8000-000000000001', '30600000-0000-4000-8000-000000000002', 1, TRUE),
  ('30000000-0000-4000-8000-000000000001', '30400000-0000-4000-8000-000000000001',
   '30500000-0000-4000-8000-000000000002', '30600000-0000-4000-8000-000000000003', 1, TRUE),
  ('30000000-0000-4000-8000-000000000001', '30400000-0000-4000-8000-000000000001',
   NULL, '30600000-0000-4000-8000-000000000004', 2, FALSE);

INSERT INTO orders (id, org_id, location_id, staff_id, client_uuid, daily_number,
                    order_type, status, subtotal, vat_rate, vat_amount, total) VALUES
  ('30700000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001',
   '30100000-0000-4000-8000-000000000001',
   '30200000-0000-4000-8000-000000000001',
   '30800000-0000-4000-8000-000000000001', 1, 'takeaway', 'open', 3200, 18, 488, 3200),
  ('30700000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000001',
   '30100000-0000-4000-8000-000000000001',
   '30200000-0000-4000-8000-000000000001',
   '30800000-0000-4000-8000-000000000002', 2, 'here', 'open', 1600, 18, 244, 1600);

-- ── Продажа с собой: большой ×2 ──────────────────────────────
INSERT INTO order_items (id, org_id, order_id, menu_item_id, variant_id, name, variant_name, unit_price, qty, line_total)
VALUES ('30900000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        '30700000-0000-4000-8000-000000000001',
        '30400000-0000-4000-8000-000000000001',
        '30500000-0000-4000-8000-000000000001',
        'Капучино', 'Большой', 1600, 2, 3200);

SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000001'),
  98, 'takeaway ×2: стакан L списан (−2)');
SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000002'),
  98, 'takeaway ×2: крышка L списана (−2)');
SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000004'),
  96, 'салфетка ×2/шт списана при любом типе (−4)');
SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000003'),
  50, 'стакан S другого варианта не тронут');
SELECT is(
  (SELECT count(*) FROM stock_movements
   WHERE order_item_id = '30900000-0000-4000-8000-000000000001' AND supply_item_id IS NOT NULL),
  3::bigint, 'журнал: 3 строки sale по упаковке с order_item_id');

-- ── Продажа в зале: takeaway_only связки не списываются ──────
INSERT INTO order_items (id, org_id, order_id, menu_item_id, variant_id, name, variant_name, unit_price, qty, line_total)
VALUES ('30900000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000001',
        '30700000-0000-4000-8000-000000000002',
        '30400000-0000-4000-8000-000000000001',
        '30500000-0000-4000-8000-000000000001',
        'Капучино', 'Большой', 1600, 1, 1600);

SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000001'),
  98, 'here: стакан L не списан (takeaway_only)');
SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000004'),
  94, 'here: салфетка списана (связка на любой тип)');

-- ── Split: qty 2 → 1 возвращает половину ─────────────────────
UPDATE order_items SET qty = 1, line_total = 1600
WHERE id = '30900000-0000-4000-8000-000000000001';

SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000001'),
  99, 'split 2→1: стакан L компенсирован (+1)');
SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000004'),
  96, 'split 2→1: салфетка компенсирована (+2)');

-- ── Void позиции ПОСЛЕ удаления связок: возврат по журналу ───
-- Каталог «уехал» (связок больше нет), но журнал помнит списанное.
DELETE FROM variant_supplies
WHERE menu_item_id = '30400000-0000-4000-8000-000000000001';

UPDATE order_items SET voided_at = NOW()
WHERE id = '30900000-0000-4000-8000-000000000001';

SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000001'),
  100, 'void позиции без связок в каталоге: стакан L возвращён по журналу');
SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000004'),
  98, 'void позиции: салфетка возвращена (+2)');

-- ── Void всего заказа: возврат по активным позициям ──────────
UPDATE orders SET status = 'voided'
WHERE id = '30700000-0000-4000-8000-000000000002';

SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000004'),
  100, 'void заказа: салфетка here-позиции возвращена (+2)');
SELECT is((SELECT stock FROM supply_items WHERE id = '30600000-0000-4000-8000-000000000001'),
  100, 'void заказа: стакан L не переначислен');

-- ── save_menu_item: p_supplies и выживание при старом клиенте ─
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"30a00000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"30000000-0000-4000-8000-000000000001","location_id":"30100000-0000-4000-8000-000000000001"}}',
  true
);

-- Строгий режим (090): save_menu_item требует staff-сессию
INSERT INTO staff_sessions (token, staff_id, org_id, location_id)
VALUES ('30d00000-0000-4000-8000-000000000001',
        '30200000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        '30100000-0000-4000-8000-000000000001');

CREATE TEMP TABLE saved_item AS
SELECT save_menu_item(
  jsonb_build_object('category_id', '30300000-0000-4000-8000-000000000001',
                     'name', 'Латте', 'price', 1500),
  '[{"name":"Большой","price":1700,"is_default":true},{"name":"Маленький","price":1500}]'::jsonb,
  '[]'::jsonb,
  NULL,
  '30d00000-0000-4000-8000-000000000001',
  '[{"variant_index":0,"supply_item_id":"30600000-0000-4000-8000-000000000001","qty":1},
    {"variant_index":null,"supply_item_id":"30600000-0000-4000-8000-000000000004","qty":2,"takeaway_only":false}]'::jsonb
) AS id;

SELECT is(
  (SELECT count(*) FROM variant_supplies WHERE menu_item_id = (SELECT id FROM saved_item)),
  2::bigint, 'save_menu_item создал 2 связки упаковки');
SELECT is(
  (SELECT iv.sort_order FROM variant_supplies vs
   JOIN item_variants iv ON iv.id = vs.variant_id
   WHERE vs.menu_item_id = (SELECT id FROM saved_item) AND vs.variant_id IS NOT NULL),
  0, 'variant_index=0 привязан к первому варианту');

-- Старый клиент: пересохранение без p_supplies пересоздаёт варианты,
-- но упаковка переносится на новые варианты по имени
CREATE TEMP TABLE resave_legacy AS
SELECT save_menu_item(
  jsonb_build_object('category_id', '30300000-0000-4000-8000-000000000001',
                     'name', 'Латте', 'price', 1500),
  '[{"name":"Большой","price":1800,"is_default":true},{"name":"Маленький","price":1500}]'::jsonb,
  '[]'::jsonb,
  (SELECT id FROM saved_item),
  '30d00000-0000-4000-8000-000000000001'
) AS id;

SELECT is(
  (SELECT count(*) FROM variant_supplies WHERE menu_item_id = (SELECT id FROM saved_item)),
  2::bigint, 'старый клиент без p_supplies не теряет упаковку');
SELECT is(
  (SELECT iv.name FROM variant_supplies vs
   JOIN item_variants iv ON iv.id = vs.variant_id
   WHERE vs.menu_item_id = (SELECT id FROM saved_item) AND vs.variant_id IS NOT NULL),
  'Большой', 'variant-связка переехала на пересозданный вариант по имени');

-- Явная пустая упаковка очищает связки
CREATE TEMP TABLE resave_clear AS
SELECT save_menu_item(
  jsonb_build_object('category_id', '30300000-0000-4000-8000-000000000001',
                     'name', 'Латте', 'price', 1500),
  '[{"name":"Большой","price":1800,"is_default":true}]'::jsonb,
  '[]'::jsonb,
  (SELECT id FROM saved_item),
  '30d00000-0000-4000-8000-000000000001',
  '[]'::jsonb
) AS id;

SELECT is(
  (SELECT count(*) FROM variant_supplies WHERE menu_item_id = (SELECT id FROM saved_item)),
  0::bigint, 'p_supplies=[] очищает упаковку');

-- ── Запись в variant_supplies закрыта для клиента ─────────────
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ INSERT INTO variant_supplies (org_id, menu_item_id, supply_item_id, qty)
     VALUES ('30000000-0000-4000-8000-000000000001',
             '30400000-0000-4000-8000-000000000001',
             '30600000-0000-4000-8000-000000000001', 1) $$,
  '42501', NULL, 'authenticated не пишет в variant_supplies напрямую');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
