-- pgTAP: массовые правки каталога из кабинета (128).
--
-- Проверяется то, ради чего функция появилась: переоценка достаёт и
-- варианты (иначе касса продаёт по старым ценам), чужие позиции не
-- трогаются, а частично применённой правки не бывает.

BEGIN;
SELECT plan(16);

INSERT INTO orgs (id, name) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'pgTAP bulk A'),
  ('d0000000-0000-4000-8000-000000000002', 'pgTAP bulk B');
INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('d6000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'A loc', 'Asia/Jerusalem'),
  ('d6000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'B loc', 'Asia/Jerusalem');
INSERT INTO menu_categories (id, org_id, location_id, name, sort_order) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'd6000000-0000-4000-8000-000000000001', 'Кофе', 0),
  ('d1000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001',
   'd6000000-0000-4000-8000-000000000001', 'Выпечка', 1),
  ('d1000000-0000-4000-8000-0000000000ff', 'd0000000-0000-4000-8000-000000000002',
   'd6000000-0000-4000-8000-000000000002', 'Чужая', 0);
INSERT INTO menu_items (id, org_id, category_id, name, price, is_available) VALUES
  ('d2000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'Латте', 1000, TRUE),
  ('d2000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'Эспрессо', 705, TRUE),
  ('d2000000-0000-4000-8000-0000000000ff', 'd0000000-0000-4000-8000-000000000002',
   'd1000000-0000-4000-8000-0000000000ff', 'Чужой товар', 500, TRUE);
-- У латте размеры: именно из них касса берёт цену
INSERT INTO item_variants (id, org_id, item_id, name, price, is_default, sort_order) VALUES
  ('d3000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'd2000000-0000-4000-8000-000000000001', 'S', 1000, TRUE, 0),
  ('d3000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001',
   'd2000000-0000-4000-8000-000000000001', 'L', 1400, FALSE, 1);

INSERT INTO auth.users (id) VALUES ('d4000000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('d5000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001',
   'owner', TRUE);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"d0000000-0000-4000-8000-000000000001"}}',
  true
);

CREATE FUNCTION pg_temp.both() RETURNS JSONB LANGUAGE sql AS $$
  SELECT '["d2000000-0000-4000-8000-000000000001","d2000000-0000-4000-8000-000000000002"]'::jsonb
$$;

-- ── Доступность ──────────────────────────────────────────────
SELECT lives_ok(
  format($$SELECT bulk_update_menu_items(%L::jsonb, 'availability', FALSE)$$, pg_temp.both()),
  'массовое снятие с продажи проходит');
SELECT is(
  (SELECT count(*)::INTEGER FROM menu_items
   WHERE org_id = 'd0000000-0000-4000-8000-000000000001' AND NOT is_available),
  2, 'обе позиции сняты');
-- Чужую строку под RLS не видно — смотрим вне роли, иначе сравнивали бы
-- с NULL и «проверка» проходила бы при любой ошибке функции.
RESET ROLE;
SELECT is(
  (SELECT is_available FROM menu_items WHERE id = 'd2000000-0000-4000-8000-0000000000ff'),
  TRUE, 'товар чужой организации не тронут');
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  format($$SELECT bulk_update_menu_items(%L::jsonb, 'availability', TRUE)$$, pg_temp.both()),
  'возврат в продажу проходит');

-- ── Категория ────────────────────────────────────────────────
SELECT lives_ok(
  format($$SELECT bulk_update_menu_items(%L::jsonb, 'category', NULL,
    'd1000000-0000-4000-8000-000000000002')$$, pg_temp.both()),
  'перенос в другую категорию проходит');
SELECT is(
  (SELECT count(*)::INTEGER FROM menu_items
   WHERE category_id = 'd1000000-0000-4000-8000-000000000002'),
  2, 'обе позиции в новой категории');
SELECT throws_ok(
  format($$SELECT bulk_update_menu_items(%L::jsonb, 'category', NULL,
    'd1000000-0000-4000-8000-0000000000ff')$$, pg_temp.both()),
  'invalid_category',
  'в чужую категорию перенести нельзя');

-- ── Цена ─────────────────────────────────────────────────────
SELECT lives_ok(
  format($$SELECT bulk_update_menu_items(%L::jsonb, 'price', NULL, NULL, 10)$$, pg_temp.both()),
  'переоценка процентом проходит');
SELECT is(
  (SELECT price FROM menu_items WHERE id = 'd2000000-0000-4000-8000-000000000001'),
  1100, '1000 + 10% = 1100');
SELECT is(
  (SELECT price FROM menu_items WHERE id = 'd2000000-0000-4000-8000-000000000002'),
  776, '705 + 10% округляется до агоры (775.5 → 776)');
SELECT is(
  (SELECT price FROM item_variants WHERE id = 'd3000000-0000-4000-8000-000000000002'),
  1540, 'варианты переоценены тоже — иначе касса продаёт по старой цене');

SELECT lives_ok(
  format($$SELECT bulk_update_menu_items(%L::jsonb, 'price', NULL, NULL, NULL, -100)$$, pg_temp.both()),
  'скидка фиксированной суммой проходит');
SELECT is(
  (SELECT price FROM menu_items WHERE id = 'd2000000-0000-4000-8000-000000000001'),
  1000, '1100 − 1 ₪ = 1000');

-- Цена не уходит в минус: отрицательная цена ломает чек, а не «скидка»
SELECT lives_ok(
  format($$SELECT bulk_update_menu_items(%L::jsonb, 'price', NULL, NULL, NULL, -999999)$$, pg_temp.both()),
  'слишком большая скидка не падает');
SELECT is(
  (SELECT min(price) FROM menu_items WHERE org_id = 'd0000000-0000-4000-8000-000000000001'),
  0, 'цена ограничена нулём снизу');

-- ── Чужие позиции в списке ───────────────────────────────────
SELECT throws_ok(
  $$SELECT bulk_update_menu_items(
      '["d2000000-0000-4000-8000-000000000001","d2000000-0000-4000-8000-0000000000ff"]'::jsonb,
      'availability', FALSE)$$,
  'foreign_items',
  'чужая позиция в списке отменяет всю правку, а не пропускается молча');

SELECT * FROM finish();
ROLLBACK;
