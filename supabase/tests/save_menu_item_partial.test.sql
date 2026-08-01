-- pgTAP: частичный payload save_menu_item не стирает поля (129).
--
-- Регресс, найденный приёмкой: веб-кабинет не слал sku/cost/stock, а
-- функция писала их напрямую — каждая правка позиции из кабинета молча
-- обнуляла артикул, себестоимость и остаток.

BEGIN;
SELECT plan(9);

INSERT INTO orgs (id, name) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'pgTAP partial');
INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('e6000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001', 'Loc', 'Asia/Jerusalem');
INSERT INTO menu_categories (id, org_id, location_id, name, sort_order) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'e6000000-0000-4000-8000-000000000001', 'Кофе', 0);
INSERT INTO menu_items (id, org_id, category_id, name, price, sku, cost, stock, track_inventory)
VALUES ('e2000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
        'e1000000-0000-4000-8000-000000000001', 'Латте', 1000, 'COF-1', 400, 25, TRUE);

INSERT INTO auth.users (id) VALUES ('e4000000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('e5000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001',
   'owner', TRUE);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"e4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"e0000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Правка без sku/cost/stock: так делал веб-кабинет ─────────
SELECT lives_ok($$
  SELECT save_menu_item(
    '{"name":"Латте","description":null,"category_id":"e1000000-0000-4000-8000-000000000001",
      "station_id":null,"price":1100,"image_url":null,"is_available":true,
      "is_favorite":false,"ask_modifiers":false}'::jsonb,
    '[]'::jsonb, '[]'::jsonb, 'e2000000-0000-4000-8000-000000000001')
$$, 'сохранение без этих ключей проходит');

SELECT is((SELECT price FROM menu_items WHERE id = 'e2000000-0000-4000-8000-000000000001'),
  1100, 'цена обновилась — правка применилась');
SELECT is((SELECT sku FROM menu_items WHERE id = 'e2000000-0000-4000-8000-000000000001'),
  'COF-1', 'артикул НЕ стёрт');
SELECT is((SELECT cost FROM menu_items WHERE id = 'e2000000-0000-4000-8000-000000000001'),
  400, 'себестоимость НЕ стёрта');
SELECT is((SELECT stock FROM menu_items WHERE id = 'e2000000-0000-4000-8000-000000000001'),
  25, 'остаток НЕ стёрт');

-- ── Ключ прислан — значение меняется ─────────────────────────
SELECT lives_ok($$
  SELECT save_menu_item(
    '{"name":"Латте","description":null,"category_id":"e1000000-0000-4000-8000-000000000001",
      "station_id":null,"price":1100,"image_url":null,"is_available":true,
      "is_favorite":false,"ask_modifiers":false,"sku":"COF-9"}'::jsonb,
    '[]'::jsonb, '[]'::jsonb, 'e2000000-0000-4000-8000-000000000001')
$$, 'сохранение с артикулом проходит');
SELECT is((SELECT sku FROM menu_items WHERE id = 'e2000000-0000-4000-8000-000000000001'),
  'COF-9', 'присланный артикул записан');

-- ── Пустая строка — осознанная очистка ───────────────────────
SELECT lives_ok($$
  SELECT save_menu_item(
    '{"name":"Латте","description":null,"category_id":"e1000000-0000-4000-8000-000000000001",
      "station_id":null,"price":1100,"image_url":null,"is_available":true,
      "is_favorite":false,"ask_modifiers":false,"sku":""}'::jsonb,
    '[]'::jsonb, '[]'::jsonb, 'e2000000-0000-4000-8000-000000000001')
$$, 'пустой артикул принимается');
SELECT is((SELECT sku FROM menu_items WHERE id = 'e2000000-0000-4000-8000-000000000001'),
  NULL, 'пустая строка очищает артикул — это осознанное действие, а не умолчание');

SELECT * FROM finish();
ROLLBACK;
