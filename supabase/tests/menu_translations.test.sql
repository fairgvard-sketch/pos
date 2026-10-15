-- pgTAP: переводы QR-меню (184).
--
-- Форма перевода держится триггером на всех пяти таблицах каталога: кабинет
-- пишет категории и добавки прямыми запросами под RLS. save_menu_item
-- пишет переводы товара и размеров и не теряет переводы размеров, когда
-- клиент о них не знает и шлёт размеры без ключа translations.

BEGIN;
SELECT plan(22);

INSERT INTO orgs (id, name) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'pgTAP translations');
INSERT INTO organization_products(org_id, product) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'menu');
INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('f1100000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', 'Loc', 'Asia/Jerusalem');
INSERT INTO menu_categories (id, org_id, location_id, name, sort_order) VALUES
  ('f1200000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f1100000-0000-4000-8000-000000000001', 'משקאות חמים', 0);
INSERT INTO menu_items (id, org_id, category_id, name, price) VALUES
  ('f1300000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f1200000-0000-4000-8000-000000000001', 'קפוצ׳ינו', 1400);
INSERT INTO modifier_groups (id, org_id, name) VALUES
  ('f1400000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'חלב');
INSERT INTO modifiers (id, org_id, group_id, name) VALUES
  ('f1500000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f1400000-0000-4000-8000-000000000001', 'חלב שיבולת שועל');

-- ── Колонки и умолчание ──────────────────────────────────────
SELECT is((SELECT translations FROM menu_items WHERE id = 'f1300000-0000-4000-8000-000000000001'),
  '{}'::jsonb, 'у существующей позиции переводов нет — пустой объект');

-- ── Нормализация ─────────────────────────────────────────────
UPDATE menu_items SET translations =
  '{"en":{"name":"  Cappuccino\n  grande ","description":"  Espresso with milk.\nDouble shot.  "},
    "ru":{"name":"   ","description":null},
    "he":null}'::jsonb
WHERE id = 'f1300000-0000-4000-8000-000000000001';
SELECT is((SELECT translations FROM menu_items WHERE id = 'f1300000-0000-4000-8000-000000000001'),
  '{"en":{"name":"Cappuccino grande","description":"Espresso with milk.\nDouble shot."}}'::jsonb,
  'пробелы срезаны, абзацы описания целы, пустой язык выброшен');

UPDATE menu_items SET translations = 'null'::jsonb
WHERE id = 'f1300000-0000-4000-8000-000000000001';
SELECT is((SELECT translations FROM menu_items WHERE id = 'f1300000-0000-4000-8000-000000000001'),
  '{}'::jsonb, 'JSON null очищает переводы');

-- ── Отказы ───────────────────────────────────────────────────
SELECT throws_like($$
  UPDATE menu_items SET translations = '{"fr":{"name":"Cappuccino"}}'::jsonb
  WHERE id = 'f1300000-0000-4000-8000-000000000001'
$$, 'invalid_translations%', 'неизвестный язык отклоняется');

SELECT throws_like($$
  UPDATE menu_categories SET translations = '{"en":{"description":"Hot"}}'::jsonb
  WHERE id = 'f1200000-0000-4000-8000-000000000001'
$$, 'invalid_translations%', 'у категории нет описания');

SELECT throws_like($$
  UPDATE modifiers SET translations = '{"en":{"name":42}}'::jsonb
  WHERE id = 'f1500000-0000-4000-8000-000000000001'
$$, 'invalid_translations%', 'название не строкой отклоняется');

SELECT throws_like($$
  UPDATE modifiers SET translations = '["Oat milk"]'::jsonb
  WHERE id = 'f1500000-0000-4000-8000-000000000001'
$$, 'invalid_translations%', 'массив вместо объекта отклоняется');

SELECT throws_like(
  format($$UPDATE menu_items SET translations = '{"en":{"name":"%s"}}'::jsonb
           WHERE id = 'f1300000-0000-4000-8000-000000000001'$$, repeat('a', 121)),
  'translation_too_long%', 'название длиннее 120 символов отклоняется');

-- ── Кабинет: прямая запись категорий и добавок под RLS ──────
INSERT INTO auth.users (id) VALUES ('f1600000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('f1700000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', 'f1600000-0000-4000-8000-000000000001',
   'owner', TRUE);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f1600000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"f1000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT lives_ok($$
  UPDATE menu_categories SET translations = '{"en":{"name":"Hot drinks"},"ru":{"name":"Горячие напитки"}}'::jsonb
  WHERE id = 'f1200000-0000-4000-8000-000000000001'
$$, 'владелец пишет перевод категории напрямую');
SELECT is((SELECT translations -> 'ru' ->> 'name' FROM menu_categories
           WHERE id = 'f1200000-0000-4000-8000-000000000001'),
  'Горячие напитки', 'перевод категории записан');

SELECT lives_ok($$
  UPDATE modifiers SET translations = '{"en":{"name":" Oat milk "}}'::jsonb
  WHERE id = 'f1500000-0000-4000-8000-000000000001'
$$, 'владелец пишет перевод добавки напрямую');
SELECT is((SELECT translations FROM modifiers WHERE id = 'f1500000-0000-4000-8000-000000000001'),
  '{"en":{"name":"Oat milk"}}'::jsonb, 'триггер нормализует и под ролью authenticated');

-- ── save_menu_item: переводы товара и размеров ──────────────
SELECT lives_ok($$
  SELECT save_menu_item(
    '{"name":"קפוצ׳ינו","description":null,"category_id":"f1200000-0000-4000-8000-000000000001",
      "station_id":null,"price":1400,"image_url":null,"is_available":true,
      "translations":{"en":{"name":"Cappuccino","description":"Espresso and milk foam"},
                      "ru":{"name":"Капучино"}}}'::jsonb,
    '[{"name":"קטן","price":1400,"is_default":true,"translations":{"en":{"name":"Small"},"ru":{"name":"Маленький"}}},
      {"name":"גדול","price":1700,"is_default":false,"translations":{"en":{"name":"Large"}}}]'::jsonb,
    '[]'::jsonb, 'f1300000-0000-4000-8000-000000000001')
$$, 'сохранение с переводами проходит');

SELECT is((SELECT translations FROM menu_items WHERE id = 'f1300000-0000-4000-8000-000000000001'),
  '{"en":{"name":"Cappuccino","description":"Espresso and milk foam"},"ru":{"name":"Капучино"}}'::jsonb,
  'переводы товара записаны');
SELECT is((SELECT translations -> 'ru' ->> 'name' FROM item_variants
           WHERE item_id = 'f1300000-0000-4000-8000-000000000001' AND name = 'קטן'),
  'Маленький', 'перевод размера записан');

-- Клиент без переводов (касса, старый кабинет): ключа translations нет
SELECT lives_ok($$
  SELECT save_menu_item(
    '{"name":"קפוצ׳ינו","description":null,"category_id":"f1200000-0000-4000-8000-000000000001",
      "station_id":null,"price":1500,"image_url":null,"is_available":true}'::jsonb,
    '[{"name":"גדול","price":1800,"is_default":false},
      {"name":"קטן","price":1500,"is_default":true},
      {"name":"ענק","price":2200,"is_default":false}]'::jsonb,
    '[]'::jsonb, 'f1300000-0000-4000-8000-000000000001')
$$, 'сохранение без переводов проходит');

SELECT is((SELECT price FROM menu_items WHERE id = 'f1300000-0000-4000-8000-000000000001'),
  1500, 'правка применилась');
SELECT is((SELECT translations -> 'en' ->> 'name' FROM menu_items
           WHERE id = 'f1300000-0000-4000-8000-000000000001'),
  'Cappuccino', 'переводы товара не стёрты');
SELECT is((SELECT translations FROM item_variants
           WHERE item_id = 'f1300000-0000-4000-8000-000000000001' AND name = 'קטן'),
  '{"en":{"name":"Small"},"ru":{"name":"Маленький"}}'::jsonb,
  'перевод размера перенесён по имени, хотя размер сменил место');
SELECT is((SELECT translations FROM item_variants
           WHERE item_id = 'f1300000-0000-4000-8000-000000000001' AND name = 'ענק'),
  '{}'::jsonb, 'у нового размера переводов нет');

-- Ключ прислан пустым — осознанная очистка
SELECT lives_ok($$
  SELECT save_menu_item(
    '{"name":"קפוצ׳ינו","description":null,"category_id":"f1200000-0000-4000-8000-000000000001",
      "station_id":null,"price":1500,"image_url":null,"is_available":true,"translations":{}}'::jsonb,
    '[{"name":"קטן","price":1500,"is_default":true,"translations":{}}]'::jsonb,
    '[]'::jsonb, 'f1300000-0000-4000-8000-000000000001')
$$, 'сохранение с пустыми переводами проходит');
SELECT is((SELECT translations FROM menu_items WHERE id = 'f1300000-0000-4000-8000-000000000001')
          || (SELECT translations FROM item_variants
              WHERE item_id = 'f1300000-0000-4000-8000-000000000001' AND name = 'קטן'),
  '{}'::jsonb, 'пустой объект очищает переводы товара и размера');

SELECT * FROM finish();
ROLLBACK;
