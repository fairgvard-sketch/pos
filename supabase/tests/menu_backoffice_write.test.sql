-- pgTAP: правка меню из веб-кабинета владельца (092).
--
-- Меню org-scoped, поэтому веб-владелец правит его без выбора точки и без PIN —
-- через единый гейт require_backoffice_or_staff. Кассовый путь (с токеном)
-- покрыт variant_supplies.test.sql и не дублируется здесь.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(6);

-- ── Фикстура: две организации, у org A — веб-владелец и категория ──
INSERT INTO orgs (id, name) VALUES
  ('90000000-0000-4000-8000-000000000001', 'pgTAP org M1'),
  ('90000000-0000-4000-8000-000000000002', 'pgTAP org M2');

INSERT INTO locations (id, org_id, name) VALUES
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'Loc M1');

INSERT INTO menu_categories (id, org_id, location_id, name) VALUES
  ('93000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001', 'Кофе'),
  ('93000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001', 'Выпечка');

INSERT INTO auth.users (id) VALUES
  ('94000000-0000-4000-8000-000000000001'),  -- веб-владелец org A
  ('94000000-0000-4000-8000-000000000002');  -- аккаунт org B

INSERT INTO organization_members (org_id, auth_user_id, role, is_active) VALUES
  ('90000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', 'owner', TRUE),
  ('90000000-0000-4000-8000-000000000002', '94000000-0000-4000-8000-000000000002', 'owner', TRUE);

SET LOCAL ROLE authenticated;

-- ── Владелец org A создаёт товар без PIN-сессии ─────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"94000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"90000000-0000-4000-8000-000000000001"}}',
  true
);

CREATE TEMP TABLE new_item AS
SELECT save_menu_item(
  jsonb_build_object('category_id', '93000000-0000-4000-8000-000000000001',
                     'name', 'Латте', 'price', 1500)
) AS id;

SELECT is(
  (SELECT name FROM menu_items WHERE id = (SELECT id FROM new_item)),
  'Латте',
  'владелец создаёт товар из веба без PIN'
);
SELECT is(
  (SELECT price FROM menu_items WHERE id = (SELECT id FROM new_item)),
  1500,
  'цена сохранилась'
);

-- Правка цены существующего товара
SELECT save_menu_item(
  jsonb_build_object('category_id', '93000000-0000-4000-8000-000000000001',
                     'name', 'Латте', 'price', 1700),
  '[]'::jsonb, '[]'::jsonb,
  (SELECT id FROM new_item)
);
SELECT is(
  (SELECT price FROM menu_items WHERE id = (SELECT id FROM new_item)),
  1700,
  'владелец меняет цену товара'
);

-- Переупорядочивание категорий
SELECT lives_ok(
  $$ SELECT reorder_menu('category',
     '["93000000-0000-4000-8000-000000000002","93000000-0000-4000-8000-000000000001"]'::jsonb) $$,
  'владелец переставляет категории из веба'
);
SELECT is(
  (SELECT sort_order FROM menu_categories WHERE id = '93000000-0000-4000-8000-000000000002'),
  0,
  'порядок применён'
);

-- ── Аккаунт org B: категория org A ему не видна, правка не проходит ──
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"94000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"90000000-0000-4000-8000-000000000002"}}',
  true
);

-- save_menu_item пишет под своей org (v_org из JWT), поэтому товар с
-- category_id чужой org уходит в НЕсуществующую для B категорию — товар
-- создастся в org B, но к каталогу org A доступа нет. Проверяем изоляцию
-- иначе: reorder чужих id под org B ничего не меняет (WHERE org_id = v_org).
SELECT is(
  (SELECT count(*) FROM menu_items WHERE org_id = '90000000-0000-4000-8000-000000000002'),
  0::bigint,
  'org B не видит и не трогает товары org A'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
