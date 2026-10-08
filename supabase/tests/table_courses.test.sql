-- pgTAP: курсы подачи и Fire для счёта стола (179).
--
-- Закуска уходит на кухню сразу, горячее и десерт ждут Fire. Нет более
-- раннего курса — курс уходит сразу. Кухня придержанное не видит, «всё
-- готово» его не трогает, оплата освобождает остаток.

BEGIN;
SELECT plan(33);

INSERT INTO orgs (id, name)
VALUES ('c9000000-0000-4000-8000-000000000001', 'pgTAP courses');
INSERT INTO organization_products (org_id, product) VALUES
  ('c9000000-0000-4000-8000-000000000001', 'pos');

INSERT INTO locations (id, org_id, name, timezone)
VALUES ('c9100000-0000-4000-8000-000000000001',
        'c9000000-0000-4000-8000-000000000001', 'Loc C', 'Asia/Jerusalem');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('c9200000-0000-4000-8000-000000000001',
        'c9000000-0000-4000-8000-000000000001',
        'c9100000-0000-4000-8000-000000000001',
        'pgTAP waiter', 'owner', 'unused-in-test');

INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float)
VALUES ('c9300000-0000-4000-8000-000000000001',
        'c9000000-0000-4000-8000-000000000001',
        'c9100000-0000-4000-8000-000000000001',
        'c9200000-0000-4000-8000-000000000001', 'open', 0);

INSERT INTO tables (id, org_id, location_id, label) VALUES
  ('c9400000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001',
   'c9100000-0000-4000-8000-000000000001', '1'),
  ('c9400000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000001',
   'c9100000-0000-4000-8000-000000000001', '2');

INSERT INTO menu_categories (id, org_id, location_id, name, sort_order) VALUES
  ('c9500000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001',
   'c9100000-0000-4000-8000-000000000001', 'Кухня', 0);

-- Салат — курс 1, Стейк — 2, Торт — 3, Вода — без курса
INSERT INTO menu_items (id, org_id, category_id, name, price, course) VALUES
  ('c9600000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001',
   'c9500000-0000-4000-8000-000000000001', 'Salad', 3000, 1),
  ('c9600000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000001',
   'c9500000-0000-4000-8000-000000000001', 'Steak', 9000, 2),
  ('c9600000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-000000000001',
   'c9500000-0000-4000-8000-000000000001', 'Cake', 2500, 3),
  ('c9600000-0000-4000-8000-000000000004', 'c9000000-0000-4000-8000-000000000001',
   'c9500000-0000-4000-8000-000000000001', 'Water', 1000, NULL);

-- A, B — открытые счета столов; C — открытый заказ без стола
INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, vat_rate, shift_id, table_id, table_label
) VALUES
  ('c9700000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000001',
   'c9100000-0000-4000-8000-000000000001', 'c9200000-0000-4000-8000-000000000001',
   'c9800000-0000-4000-8000-00000000000a', 1, 'here', 'open', 18,
   'c9300000-0000-4000-8000-000000000001', 'c9400000-0000-4000-8000-000000000001', '1'),
  ('c9700000-0000-4000-8000-00000000000b', 'c9000000-0000-4000-8000-000000000001',
   'c9100000-0000-4000-8000-000000000001', 'c9200000-0000-4000-8000-000000000001',
   'c9800000-0000-4000-8000-00000000000b', 2, 'here', 'open', 18,
   'c9300000-0000-4000-8000-000000000001', 'c9400000-0000-4000-8000-000000000002', '2'),
  ('c9700000-0000-4000-8000-00000000000c', 'c9000000-0000-4000-8000-000000000001',
   'c9100000-0000-4000-8000-000000000001', 'c9200000-0000-4000-8000-000000000001',
   'c9800000-0000-4000-8000-00000000000c', 3, 'here', 'open', 18,
   'c9300000-0000-4000-8000-000000000001', NULL, NULL);

-- Касса: JWT устройства точки
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"c9900000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"c9000000-0000-4000-8000-000000000001","location_id":"c9100000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Закуска и горячее одним заходом: горячее ждёт ───────────
SELECT lives_ok($$
  SELECT append_to_order('c9700000-0000-4000-8000-00000000000a',
    'c9200000-0000-4000-8000-000000000001',
    '[{"menu_item_id":"c9600000-0000-4000-8000-000000000001","qty":1},
      {"menu_item_id":"c9600000-0000-4000-8000-000000000002","qty":1},
      {"menu_item_id":"c9600000-0000-4000-8000-000000000004","qty":1}]'::jsonb,
    'c9a00000-0000-4000-8000-000000000001')
$$, 'дозаказ с курсами из каталога проходит');

SELECT is(
  (SELECT array_agg(name ORDER BY name) FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000a' AND held),
  ARRAY['Steak'],
  'придержано только горячее: есть более ранний курс'
);
SELECT is(
  (SELECT course FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000a' AND name = 'Steak'),
  2::smallint,
  'строка помнит курс из каталога'
);
SELECT is(
  (SELECT course FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000a' AND name = 'Water'),
  NULL::smallint,
  'блюдо без курса остаётся без курса'
);

-- Replay того же op_uuid не задваивает строки
SELECT lives_ok($$
  SELECT append_to_order('c9700000-0000-4000-8000-00000000000a',
    'c9200000-0000-4000-8000-000000000001',
    '[{"menu_item_id":"c9600000-0000-4000-8000-000000000001","qty":1},
      {"menu_item_id":"c9600000-0000-4000-8000-000000000002","qty":1},
      {"menu_item_id":"c9600000-0000-4000-8000-000000000004","qty":1}]'::jsonb,
    'c9a00000-0000-4000-8000-000000000001')
$$, 'повтор дозаказа проходит');
SELECT is(
  (SELECT count(*) FROM order_items WHERE order_id = 'c9700000-0000-4000-8000-00000000000a'),
  3::bigint,
  'повтор не добавил строк'
);

-- ── Без закуски горячее уходит сразу, десерт ждёт ──────────
SELECT lives_ok($$
  SELECT append_to_order('c9700000-0000-4000-8000-00000000000b',
    'c9200000-0000-4000-8000-000000000001',
    '[{"menu_item_id":"c9600000-0000-4000-8000-000000000002","qty":1},
      {"menu_item_id":"c9600000-0000-4000-8000-000000000003","qty":2}]'::jsonb)
$$, 'стол без закуски: дозаказ проходит');
SELECT is(
  (SELECT array_agg(name ORDER BY name) FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000b' AND held),
  ARRAY['Cake'],
  'нет более раннего курса — горячее не ждёт, десерт ждёт горячее'
);

-- ── Поздний дозаказ ждёт, если ранний курс уже в счёте ─────
SELECT lives_ok($$
  SELECT append_to_order('c9700000-0000-4000-8000-00000000000a',
    'c9200000-0000-4000-8000-000000000001',
    '[{"menu_item_id":"c9600000-0000-4000-8000-000000000003","qty":1}]'::jsonb)
$$, 'десерт позже проходит');
SELECT ok(
  (SELECT held FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000a' AND name = 'Cake' AND course = 3),
  'десерт ждёт: закуска уже в счёте'
);

-- ── Официант меняет курс строки ────────────────────────────
SELECT lives_ok($$
  SELECT append_to_order('c9700000-0000-4000-8000-00000000000a',
    'c9200000-0000-4000-8000-000000000001',
    '[{"menu_item_id":"c9600000-0000-4000-8000-000000000002","qty":1,"course":null,
       "id":"c9b00000-0000-4000-8000-000000000001"},
      {"menu_item_id":"c9600000-0000-4000-8000-000000000003","qty":1,"course":1,
       "id":"c9b00000-0000-4000-8000-000000000002"},
      {"menu_item_id":"c9600000-0000-4000-8000-000000000002","qty":1,
       "id":"c9b00000-0000-4000-8000-000000000003"}]'::jsonb)
$$, 'дозаказ с ручными курсами и id строк с кассы проходит');
SELECT ok(
  (SELECT course IS NULL AND NOT held FROM order_items
   WHERE id = 'c9b00000-0000-4000-8000-000000000001'),
  '«без курса» перебивает каталог: горячее уходит сразу'
);
SELECT ok(
  (SELECT course = 1 AND NOT held FROM order_items
   WHERE id = 'c9b00000-0000-4000-8000-000000000002'),
  'десерт как закуска уходит сразу'
);
SELECT ok(
  (SELECT held FROM order_items WHERE id = 'c9b00000-0000-4000-8000-000000000003'),
  'строка создана с id кассы и придержана по каталогу'
);

SELECT throws_ok($$
  SELECT append_to_order('c9700000-0000-4000-8000-00000000000a',
    'c9200000-0000-4000-8000-000000000001',
    '[{"menu_item_id":"c9600000-0000-4000-8000-000000000002","qty":1,"course":5}]'::jsonb)
$$, 'P0001', 'invalid course', 'курс вне 1–3 отклоняется');

-- ── Заказ без стола не придерживается ──────────────────────
SELECT lives_ok($$
  SELECT append_to_order('c9700000-0000-4000-8000-00000000000c',
    'c9200000-0000-4000-8000-000000000001',
    '[{"menu_item_id":"c9600000-0000-4000-8000-000000000001","qty":1},
      {"menu_item_id":"c9600000-0000-4000-8000-000000000002","qty":1}]'::jsonb)
$$, 'дозаказ без стола проходит');
SELECT is(
  (SELECT count(*) FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000c' AND held),
  0::bigint,
  'без стола курсы не держат кухню'
);

-- ── «Всё готово» не трогает придержанное ───────────────────
SELECT lives_ok($$SELECT mark_order_ready('c9700000-0000-4000-8000-00000000000a')$$,
  'кухня отмечает счёт готовым');
SELECT is(
  (SELECT count(*) FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000a' AND held AND prep_status = 'ready'),
  0::bigint,
  'придержанное не стало готовым'
);
SELECT is(
  (SELECT count(*) FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000a' AND NOT held AND prep_status = 'pending'),
  0::bigint,
  'отправленное отмечено готовым'
);

-- ── Fire ───────────────────────────────────────────────────
SELECT is(
  (SELECT json_array_length(fire_order_items(
     ARRAY['c9b00000-0000-4000-8000-000000000003'::uuid,
           (SELECT id FROM order_items
            WHERE order_id = 'c9700000-0000-4000-8000-00000000000a' AND name = 'Cake' AND course = 3)],
     'c9200000-0000-4000-8000-000000000001') -> 'fired')),
  2,
  'Fire отправляет выбранные строки'
);
SELECT ok(
  (SELECT NOT held AND fired_at IS NOT NULL
          AND fired_by = 'c9200000-0000-4000-8000-000000000001'
          AND prep_status = 'pending'
   FROM order_items WHERE id = 'c9b00000-0000-4000-8000-000000000003'),
  'отправленная строка видна кухне, помнит кто и когда'
);
SELECT is(
  (SELECT count(*) FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000a' AND held),
  1::bigint,
  'не выбранное горячее по-прежнему ждёт'
);
SELECT is(
  (SELECT json_array_length(fire_order_items(
     ARRAY['c9b00000-0000-4000-8000-000000000003'::uuid],
     'c9200000-0000-4000-8000-000000000001') -> 'fired')),
  0,
  'повтор Fire из офлайн-очереди — no-op'
);
SELECT throws_ok($$
  SELECT fire_order_items(ARRAY['c9b00000-0000-4000-8000-0000000000ff'::uuid],
    'c9200000-0000-4000-8000-000000000001')
$$, 'P0001', 'item not found', 'неизвестная строка — ошибка, а не тихий пропуск');
SELECT ok(
  NOT has_function_privilege('anon', 'fire_order_items(uuid[],uuid,uuid)', 'EXECUTE'),
  'anon не вызывает Fire'
);

-- ── Раздельная оплата уносит удержание ─────────────────────
SELECT is(
  (SELECT (split_order('c9700000-0000-4000-8000-00000000000b',
     'c9200000-0000-4000-8000-000000000001',
     jsonb_build_array(jsonb_build_object(
       'item_id', (SELECT id FROM order_items
                   WHERE order_id = 'c9700000-0000-4000-8000-00000000000b' AND name = 'Cake'),
       'qty', 1))) ->> 'new_total')::int),
  2500,
  'половина десерта уходит в отдельный счёт'
);
SELECT ok(
  (SELECT held AND course = 3 FROM order_items
   WHERE name = 'Cake' AND order_id = (
     SELECT id FROM orders WHERE daily_number = 2 AND table_id IS NULL
       AND org_id = 'c9000000-0000-4000-8000-000000000001')),
  'перенесённая часть осталась придержанной и с курсом'
);

-- ── Оплата освобождает придержанное ────────────────────────
SELECT lives_ok(
  format($f$SELECT pay_order(%L, %L::jsonb, 0, %L, NULL)$f$,
    'c9700000-0000-4000-8000-00000000000a',
    json_build_array(json_build_object('method', 'cash', 'amount',
      (SELECT total FROM orders WHERE id = 'c9700000-0000-4000-8000-00000000000a')))::text,
    'c9c00000-0000-4000-8000-000000000001'),
  'оплата счёта с придержанным проходит'
);
SELECT is(
  (SELECT count(*) FROM order_items
   WHERE order_id = 'c9700000-0000-4000-8000-00000000000a' AND held),
  0::bigint,
  'оплаченное блюдо уходит на кухню'
);
SELECT is(
  (SELECT status FROM orders WHERE id = 'c9700000-0000-4000-8000-00000000000a'),
  'paid',
  'заказ ждёт кухню: освобождённое ещё не готово'
);

-- ── Курс по умолчанию в карточке блюда ─────────────────────
INSERT INTO auth.users (id) VALUES ('c9d00000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('c9e00000-0000-4000-8000-000000000001',
   'c9000000-0000-4000-8000-000000000001', 'c9d00000-0000-4000-8000-000000000001',
   'owner', TRUE);
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"c9d00000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"c9000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT save_menu_item(
  '{"name":"Water","category_id":"c9500000-0000-4000-8000-000000000001",
    "price":1000,"course":2}'::jsonb,
  '[]'::jsonb, '[]'::jsonb, 'c9600000-0000-4000-8000-000000000004');
SELECT save_menu_item(
  '{"name":"Water","category_id":"c9500000-0000-4000-8000-000000000001",
    "price":1100}'::jsonb,
  '[]'::jsonb, '[]'::jsonb, 'c9600000-0000-4000-8000-000000000004');
SELECT is(
  (SELECT course FROM menu_items WHERE id = 'c9600000-0000-4000-8000-000000000004'),
  2::smallint,
  'курс записан и не стёрт правкой без ключа course'
);
SELECT throws_ok($$
  SELECT save_menu_item(
    '{"name":"Water","category_id":"c9500000-0000-4000-8000-000000000001",
      "price":1000,"course":4}'::jsonb,
    '[]'::jsonb, '[]'::jsonb, 'c9600000-0000-4000-8000-000000000004')
$$, 'P0001', 'invalid course', 'курс вне 1–3 в карточке отклоняется');

SELECT * FROM finish();
ROLLBACK;
