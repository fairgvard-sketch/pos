-- pgTAP: правка и перенос отправленного с телефона официанта (182).
--
-- Убрать позицию — только PIN менеджера/владельца этой точки; неверный
-- PIN ничего не меняет. Отмена и перенос печатаются кассой отдельными
-- видами заданий, которые старая касса не забирает (иначе кухня
-- приготовила бы отменённое). Придержанное кухне не печатается.

BEGIN;
SELECT plan(30);

INSERT INTO orgs (id, name) VALUES ('e1000000-0000-4000-8000-000000000001', 'pgTAP waiter edits');
INSERT INTO organization_products (org_id, product) VALUES ('e1000000-0000-4000-8000-000000000001', 'pos');
INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('e1100000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'Hall', 'Asia/Jerusalem'),
  ('e1100000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'Branch', 'Asia/Jerusalem');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('e1200000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e1100000-0000-4000-8000-000000000001', 'Dana', 'barista', extensions.crypt('1234', extensions.gen_salt('bf'))),
  ('e1200000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001',
   'e1100000-0000-4000-8000-000000000001', 'Manager', 'manager', extensions.crypt('8888', extensions.gen_salt('bf'))),
  ('e1200000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001',
   'e1100000-0000-4000-8000-000000000002', 'Branch manager', 'manager', extensions.crypt('7777', extensions.gen_salt('bf')));

INSERT INTO shifts (org_id, location_id, opened_by, status, opening_float) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000001',
   'e1200000-0000-4000-8000-000000000002', 'open', 0);

INSERT INTO tables (id, org_id, location_id, label) VALUES
  ('e1400000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000001', '1'),
  ('e1400000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000001', '2'),
  ('e1400000-0000-4000-8000-000000000009', 'e1000000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000002', '9');

INSERT INTO menu_categories (id, org_id, location_id, name) VALUES
  ('e1500000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e1100000-0000-4000-8000-000000000001', 'Food');
INSERT INTO menu_items (id, org_id, category_id, name, price, course) VALUES
  ('e1600000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e1500000-0000-4000-8000-000000000001', 'Salad', 3000, 1),
  ('e1600000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001',
   'e1500000-0000-4000-8000-000000000001', 'Steak', 9000, 2),
  ('e1600000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001',
   'e1500000-0000-4000-8000-000000000001', 'Water', 1000, NULL);

INSERT INTO modifier_groups (id, org_id, name, min_select, max_select) VALUES
  ('e1700000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'Extra', 0, 1);
INSERT INTO modifiers (id, org_id, group_id, name, price_delta) VALUES
  ('e1710000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e1700000-0000-4000-8000-000000000001', 'Feta', 500);
INSERT INTO menu_item_modifier_groups (item_id, group_id, org_id) VALUES
  ('e1600000-0000-4000-8000-000000000001', 'e1700000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001');

-- Телефон P1 и касса D1 точки
INSERT INTO auth.users (id) VALUES
  ('e1900000-0000-4000-8000-0000000000a1'),
  ('e1900000-0000-4000-8000-0000000000d1');
INSERT INTO waiter_devices (id, org_id, location_id, auth_user_id, label) VALUES
  ('e1a00000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e1100000-0000-4000-8000-000000000001', 'e1900000-0000-4000-8000-0000000000a1', 'Phone 1');

-- ── Телефон: вход и заказ ───────────────────────────────────
SELECT set_config('request.jwt.claims',
  '{"sub":"e1900000-0000-4000-8000-0000000000a1","role":"authenticated"}', TRUE);
SET LOCAL ROLE authenticated;

SELECT set_config('test.s', waiter_unlock('1234') ->> 'session_token', TRUE);

-- 2 салата с фетой (курс 1), стейк (курс 2 — придержан), вода
SELECT lives_ok($$
  SELECT waiter_send(current_setting('test.s')::UUID, 'e1400000-0000-4000-8000-000000000001',
    'e1c00000-0000-4000-8000-000000000001',
    '[{"id":"e1d00000-0000-4000-8000-000000000001","menu_item_id":"e1600000-0000-4000-8000-000000000001","qty":2,
       "modifier_ids":["e1710000-0000-4000-8000-000000000001"],"course":1},
      {"id":"e1d00000-0000-4000-8000-000000000002","menu_item_id":"e1600000-0000-4000-8000-000000000002","qty":1,"course":2},
      {"id":"e1d00000-0000-4000-8000-000000000003","menu_item_id":"e1600000-0000-4000-8000-000000000003","qty":1}]')
$$, 'заказ стола 1 отправлен с телефона');

-- ── Счёт: данные для «ещё одной такой же» ───────────────────
SELECT is(
  (SELECT l ->> 'menu_item_id' || '/' || (l ->> 'unit_price') || '/' || (l -> 'mods' -> 0 ->> 'id') || '/' || (l -> 'mods' -> 0 ->> 'priceDelta')
   FROM json_array_elements(waiter_bill(current_setting('test.s')::UUID, 'e1400000-0000-4000-8000-000000000001') -> 'lines') l
   WHERE l ->> 'id' = 'e1d00000-0000-4000-8000-000000000001'),
  'e1600000-0000-4000-8000-000000000001/3500/e1710000-0000-4000-8000-000000000001/500',
  'строка счёта несёт товар, цену за штуку и модификаторы с id');

-- ── Зал: огонь на столе только после Fire ───────────────────
SELECT is(
  (SELECT (o ->> 'has_fired') FROM json_array_elements(waiter_hall(current_setting('test.s')::UUID) -> 'open') o
   WHERE o ->> 'table_id' = 'e1400000-0000-4000-8000-000000000001'),
  'false', 'стейк ждёт Fire — огня на столе ещё нет');
SELECT lives_ok($$
  SELECT waiter_send(current_setting('test.s')::UUID, 'e1400000-0000-4000-8000-000000000001',
    'e1c00000-0000-4000-8000-000000000010',
    '[{"id":"e1d00000-0000-4000-8000-000000000010","menu_item_id":"e1600000-0000-4000-8000-000000000002","qty":1,"course":2}]');
  SELECT waiter_fire(current_setting('test.s')::UUID,
    (waiter_bill(current_setting('test.s')::UUID, 'e1400000-0000-4000-8000-000000000001') -> 'order' ->> 'id')::UUID,
    ARRAY['e1d00000-0000-4000-8000-000000000010']::UUID[], 'e1c00000-0000-4000-8000-000000000011')
$$, 'второй стейк отправлен и сразу Fire');
SELECT is(
  (SELECT (o ->> 'has_fired') FROM json_array_elements(waiter_hall(current_setting('test.s')::UUID) -> 'open') o
   WHERE o ->> 'table_id' = 'e1400000-0000-4000-8000-000000000001'),
  'true', 'после Fire на столе огонь');

-- ── Убрать: только PIN менеджера своей точки ────────────────
SELECT is(
  (waiter_void_line(current_setting('test.s')::UUID, 'e1d00000-0000-4000-8000-000000000001', 1, 'oops', '1234',
     'e1c00000-0000-4000-8000-000000000002') ->> 'error'),
  'manager_pin_invalid', 'PIN самого официанта отмену не подтверждает');
SELECT is(
  (waiter_void_line(current_setting('test.s')::UUID, 'e1d00000-0000-4000-8000-000000000001', 1, 'oops', '7777',
     'e1c00000-0000-4000-8000-000000000002') ->> 'error'),
  'manager_pin_invalid', 'менеджер другого филиала не подтверждает');
SELECT is(
  (SELECT current_setting('request.jwt.claims')::JSONB -> 'app_metadata'),
  NULL::JSONB, 'после отказа claims телефона восстановлены');
SELECT throws_ok($$
  SELECT waiter_void_line(current_setting('test.s')::UUID, 'e1d00000-0000-4000-8000-0000000000ff', 1, NULL, '8888',
    'e1c00000-0000-4000-8000-000000000002')
$$, 'item not found', 'чужая или несуществующая строка — отказ');
SELECT throws_ok($$
  SELECT waiter_void_line(NULL, 'e1d00000-0000-4000-8000-000000000001', 1, NULL, '8888',
    'e1c00000-0000-4000-8000-000000000002')
$$, 'staff session required', 'без PIN-сессии официанта — отказ');

SELECT is(
  (waiter_void_line(current_setting('test.s')::UUID, 'e1d00000-0000-4000-8000-000000000001', 1, 'Guest changed mind', '8888',
     'e1c00000-0000-4000-8000-000000000003') ->> 'ok')::BOOLEAN,
  TRUE, 'PIN менеджера: один салат убран');
SELECT is(
  (waiter_void_line(current_setting('test.s')::UUID, 'e1d00000-0000-4000-8000-000000000001', 1, 'Guest changed mind', '8888',
     'e1c00000-0000-4000-8000-000000000003') ->> 'job_id'),
  'e1c00000-0000-4000-8000-000000000003', 'повтор того же op_uuid возвращает тот же тикет');
SELECT is(
  (SELECT current_setting('request.jwt.claims')::JSONB -> 'app_metadata'),
  NULL::JSONB, 'после отмены claims телефона восстановлены');

-- Стейк ещё придержан: кухня его не видела — тикета нет
SELECT is(
  (waiter_void_line(current_setting('test.s')::UUID, 'e1d00000-0000-4000-8000-000000000002', NULL, NULL, '8888',
     'e1c00000-0000-4000-8000-000000000004') ->> 'job_id'),
  NULL, 'отмена придержанного — без тикета');

-- ── Перенос ─────────────────────────────────────────────────
SELECT throws_ok($$
  SELECT waiter_move_lines(current_setting('test.s')::UUID, ARRAY['e1d00000-0000-4000-8000-000000000003']::UUID[],
    'e1400000-0000-4000-8000-000000000009', 'e1c00000-0000-4000-8000-000000000005')
$$, 'table not found', 'стол другого филиала недоступен');
SELECT is(
  (waiter_move_lines(current_setting('test.s')::UUID, ARRAY['e1d00000-0000-4000-8000-000000000003']::UUID[],
     'e1400000-0000-4000-8000-000000000002', 'e1c00000-0000-4000-8000-000000000005') ->> 'to_label'),
  '2', 'вода переехала на стол 2');
SELECT is(json_array_length(waiter_bill(current_setting('test.s')::UUID, 'e1400000-0000-4000-8000-000000000002') -> 'lines'), 1,
  'на столе 2 открыт счёт с водой');
SELECT is((SELECT count(*) FROM orders), 0::BIGINT, 'RLS телефона по-прежнему ничего не отдаёт');

RESET ROLE;

SELECT is(
  (SELECT qty || '/' || void_approved_by FROM order_items
   WHERE order_id = (SELECT order_id FROM order_items WHERE id = 'e1d00000-0000-4000-8000-000000000001')
     AND voided_at IS NOT NULL AND name = 'Salad'),
  '1/e1200000-0000-4000-8000-000000000002', 'убранный салат — отменённая копия с подтвердившим менеджером');
SELECT is((SELECT qty FROM order_items WHERE id = 'e1d00000-0000-4000-8000-000000000001'), 1,
  'повтор не убрал второй салат');
SELECT is(
  (SELECT total FROM orders WHERE table_id = 'e1400000-0000-4000-8000-000000000001' AND status = 'open'),
  12500, 'на столе 1 один салат с фетой и стейк после Fire');

-- ── Задания печати ──────────────────────────────────────────
SELECT is(
  (SELECT string_agg(kind, ',' ORDER BY created_at, kind) FROM print_jobs
   WHERE org_id = 'e1000000-0000-4000-8000-000000000001'),
  'kitchen,kitchen,kitchen_move,kitchen_void', 'заказ, Fire, отмена и перенос — по заданию, придержанное не печатается');
SELECT is(
  (SELECT (payload ->> 'tableLabel') || '/' || (payload -> 'lines' -> 0 ->> 'qty') || '/' || (payload -> 'lines' -> 0 ->> 'name')
          || '/' || (payload -> 'lines' -> 0 -> 'modifiers' ->> 0)
   FROM print_jobs WHERE id = 'e1c00000-0000-4000-8000-000000000003'),
  '1/1/Salad/Feta', 'тикет отмены: стол, сколько убрано, модификаторы');
SELECT ok(
  NOT ((SELECT payload -> 'lines' -> 0 FROM print_jobs WHERE id = 'e1c00000-0000-4000-8000-000000000003') ? 'held'),
  'служебного held в тикете нет');
SELECT is(
  (SELECT (payload ->> 'tableLabel') || '→' || (payload ->> 'movedTo') FROM print_jobs
   WHERE id = 'e1c00000-0000-4000-8000-000000000005'),
  '1→2', 'тикет переноса: откуда и куда');

-- Касса точки забирает задания
SELECT set_config('request.jwt.claims',
  '{"sub":"e1900000-0000-4000-8000-0000000000d1","role":"authenticated","app_metadata":{"org_id":"e1000000-0000-4000-8000-000000000001","location_id":"e1100000-0000-4000-8000-000000000001"}}',
  TRUE);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT string_agg(j ->> 'kind', ',') FROM json_array_elements(claim_print_jobs('e1b00000-0000-4000-8000-000000000001')) j),
  'kitchen,kitchen', 'старая касса забирает только заказ и Fire');
SELECT is(
  (SELECT count(*) FROM print_jobs WHERE status = 'pending'),
  2::BIGINT, 'отмена и перенос ждут обновлённую кассу');
SELECT throws_ok($$ SELECT claim_print_jobs('e1b00000-0000-4000-8000-000000000001', ARRAY[]::TEXT[]) $$,
  'kinds required', 'новая подпись требует список видов');
SELECT is(
  (SELECT string_agg(j ->> 'kind', ',' ORDER BY j ->> 'kind')
   FROM json_array_elements(claim_print_jobs('e1b00000-0000-4000-8000-000000000001',
          ARRAY['kitchen', 'kitchen_void', 'kitchen_move'])) j),
  'kitchen_move,kitchen_void', 'новая касса забирает отмену и перенос');
SELECT is(
  (SELECT count(*) FROM print_jobs WHERE status = 'pending'),
  0::BIGINT, 'очередь пуста');

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
