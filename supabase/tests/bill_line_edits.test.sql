-- pgTAP: правка отправленных позиций счёта стола (181).
--
-- Убрать позицию — только с PIN менеджера/владельца; неверный PIN ничего
-- не меняет и считается в лимит попыток. Частичная отмена сходится по
-- деньгам и складу, повтор не задваивает. Перенос — на свободный и
-- занятый стол, опустевший счёт закрывается.

BEGIN;
SELECT plan(26);

INSERT INTO orgs (id, name) VALUES ('d1000000-0000-4000-8000-000000000001', 'pgTAP bill edits');
INSERT INTO organization_products (org_id, product) VALUES ('d1000000-0000-4000-8000-000000000001', 'pos');
INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('d1100000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Hall', 'Asia/Jerusalem'),
  ('d1100000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'Branch', 'Asia/Jerusalem');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('d1200000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
   'd1100000-0000-4000-8000-000000000001', 'Barista', 'barista', extensions.crypt('1234', extensions.gen_salt('bf'))),
  ('d1200000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001',
   'd1100000-0000-4000-8000-000000000001', 'Manager', 'manager', extensions.crypt('8888', extensions.gen_salt('bf'))),
  ('d1200000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001',
   'd1100000-0000-4000-8000-000000000002', 'Other manager', 'manager', extensions.crypt('7777', extensions.gen_salt('bf')));

INSERT INTO shifts (org_id, location_id, opened_by, status, opening_float) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001',
   'd1200000-0000-4000-8000-000000000002', 'open', 0);

INSERT INTO tables (id, org_id, location_id, label) VALUES
  ('d1400000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', '1'),
  ('d1400000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', '2'),
  ('d1400000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', '3'),
  ('d1400000-0000-4000-8000-000000000009', 'd1000000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000002', '9');

INSERT INTO menu_categories (id, org_id, location_id, name) VALUES
  ('d1500000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', 'Food');
INSERT INTO menu_items (id, org_id, category_id, name, price, track_inventory, stock) VALUES
  ('d1600000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
   'd1500000-0000-4000-8000-000000000001', 'Burger', 5000, TRUE, 10),
  ('d1600000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001',
   'd1500000-0000-4000-8000-000000000001', 'Fries', 2000, FALSE, NULL);

-- Сессия бариста (кто открывает окно) и JWT кассы точки
WITH s AS (
  INSERT INTO staff_sessions (staff_id, org_id, location_id)
  VALUES ('d1200000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
          'd1100000-0000-4000-8000-000000000001')
  RETURNING token
) SELECT set_config('test.s', token::TEXT, TRUE) FROM s;

SELECT set_config('request.jwt.claims',
  '{"sub":"d1900000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"d1000000-0000-4000-8000-000000000001","location_id":"d1100000-0000-4000-8000-000000000001"}}',
  TRUE);

-- Стол 1: 3 бургера и картошка
SELECT set_config('test.o1',
  (open_or_get_table_order('d1400000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-000000000001',
     NULL, NULL, current_setting('test.s')::UUID) ->> 'order_id'), TRUE);
SELECT lives_ok($$
  SELECT append_to_order(current_setting('test.o1')::UUID, 'd1200000-0000-4000-8000-000000000001',
    '[{"id":"d1700000-0000-4000-8000-000000000001","menu_item_id":"d1600000-0000-4000-8000-000000000001","qty":3},
      {"id":"d1700000-0000-4000-8000-000000000002","menu_item_id":"d1600000-0000-4000-8000-000000000002","qty":1}]'::JSONB,
    'd1800000-0000-4000-8000-000000000001', current_setting('test.s')::UUID)
$$, 'счёт стола 1 отправлен');
SELECT is((SELECT stock FROM menu_items WHERE id = 'd1600000-0000-4000-8000-000000000001'), 7, 'склад: продано 3');

-- ── PIN менеджера ───────────────────────────────────────────
SELECT throws_ok($$
  SELECT void_bill_line('d1700000-0000-4000-8000-000000000001', 1, 'oops', '8888', NULL, 'd1800000-0000-4000-8000-000000000002')
$$, 'staff session required', 'без сессии сотрудника — отказ');
SELECT is(
  (void_bill_line('d1700000-0000-4000-8000-000000000001', 1, 'oops', '1234',
     current_setting('test.s')::UUID, 'd1800000-0000-4000-8000-000000000002') ->> 'error'),
  'manager_pin_invalid', 'PIN бариста не подтверждает отмену');
SELECT is(
  (void_bill_line('d1700000-0000-4000-8000-000000000001', 1, 'oops', '7777',
     current_setting('test.s')::UUID, 'd1800000-0000-4000-8000-000000000002') ->> 'error'),
  'manager_pin_invalid', 'менеджер другого филиала не подтверждает');
SELECT is((SELECT count(*) FROM pin_attempts WHERE org_id = 'd1000000-0000-4000-8000-000000000001'), 2::BIGINT,
  'неверные PIN посчитаны в лимит попыток');
SELECT is((SELECT qty FROM order_items WHERE id = 'd1700000-0000-4000-8000-000000000001'), 3,
  'после неверного PIN ничего не убрано');

-- ── Частичная отмена ────────────────────────────────────────
SELECT is(
  (void_bill_line('d1700000-0000-4000-8000-000000000001', 1, 'Guest changed mind', '8888',
     current_setting('test.s')::UUID, 'd1800000-0000-4000-8000-000000000002') ->> 'ok')::BOOLEAN,
  TRUE, 'PIN менеджера: одна порция убрана');
SELECT is((SELECT qty FROM order_items WHERE id = 'd1700000-0000-4000-8000-000000000001'), 2, 'строка уменьшилась до 2');
SELECT is(
  (SELECT qty || '/' || void_reason || '/' || voided_by || '/' || void_approved_by FROM order_items
   WHERE order_id = current_setting('test.o1')::UUID AND voided_at IS NOT NULL),
  '1/Guest changed mind/d1200000-0000-4000-8000-000000000001/d1200000-0000-4000-8000-000000000002',
  'убранное — отменённая копия: кто, почему и какой менеджер подтвердил');
SELECT is((SELECT total FROM orders WHERE id = current_setting('test.o1')::UUID), 12000, 'итог пересчитан: 2×50 + 20');
SELECT is((SELECT stock FROM menu_items WHERE id = 'd1600000-0000-4000-8000-000000000001'), 8, 'склад вернул одну порцию');

SELECT is(
  (void_bill_line('d1700000-0000-4000-8000-000000000001', 1, 'Guest changed mind', '8888',
     current_setting('test.s')::UUID, 'd1800000-0000-4000-8000-000000000002') ->> 'ok')::BOOLEAN,
  TRUE, 'повтор того же op_uuid возвращает первый результат');
SELECT is((SELECT qty FROM order_items WHERE id = 'd1700000-0000-4000-8000-000000000001'), 2, 'повтор не убрал ещё порцию');
SELECT throws_ok($$
  SELECT void_bill_line('d1700000-0000-4000-8000-000000000001', 5, NULL, '8888',
    current_setting('test.s')::UUID, 'd1800000-0000-4000-8000-000000000003')
$$, 'invalid qty', 'нельзя убрать больше, чем в строке');

-- ── Перенос ─────────────────────────────────────────────────
SELECT throws_ok($$
  SELECT move_bill_lines(ARRAY['d1700000-0000-4000-8000-000000000002']::UUID[], 'd1400000-0000-4000-8000-000000000001',
    current_setting('test.s')::UUID, 'd1800000-0000-4000-8000-000000000010')
$$, 'same table', 'на тот же стол — отказ');
SELECT throws_ok($$
  SELECT move_bill_lines(ARRAY['d1700000-0000-4000-8000-000000000002']::UUID[], 'd1400000-0000-4000-8000-000000000009',
    current_setting('test.s')::UUID, 'd1800000-0000-4000-8000-000000000010')
$$, 'table not found', 'стол другого филиала недоступен');

SELECT lives_ok($$
  SELECT move_bill_lines(ARRAY['d1700000-0000-4000-8000-000000000002']::UUID[], 'd1400000-0000-4000-8000-000000000002',
    current_setting('test.s')::UUID, 'd1800000-0000-4000-8000-000000000011')
$$, 'картошка переехала на свободный стол 2');
SELECT is(
  (SELECT o.table_label || '/' || o.total FROM order_items i JOIN orders o ON o.id = i.order_id
   WHERE i.id = 'd1700000-0000-4000-8000-000000000002'),
  '2/2000', 'на столе 2 открыт счёт с картошкой');
SELECT is((SELECT total FROM orders WHERE id = current_setting('test.o1')::UUID), 10000, 'счёт стола 1 уменьшился');
SELECT is((SELECT stock FROM menu_items WHERE id = 'd1600000-0000-4000-8000-000000000001'), 8, 'перенос склад не трогает');

-- Последняя активная строка уезжает на занятый стол 2 — стол 1 освобождается
SELECT is(
  (move_bill_lines(ARRAY['d1700000-0000-4000-8000-000000000001']::UUID[], 'd1400000-0000-4000-8000-000000000002',
    current_setting('test.s')::UUID, 'd1800000-0000-4000-8000-000000000012') ->> 'source_empty')::BOOLEAN,
  TRUE, 'опустевший счёт отмечен');
SELECT is(
  (SELECT status || '/' || void_reason FROM orders WHERE id = current_setting('test.o1')::UUID),
  'voided/moved to table 2', 'пустой счёт стола 1 закрыт с причиной');
SELECT is(
  (SELECT total FROM orders WHERE table_id = 'd1400000-0000-4000-8000-000000000002' AND status = 'open'),
  12000, 'на столе 2 общий итог: 2 бургера и картошка');
SELECT is((SELECT stock FROM menu_items WHERE id = 'd1600000-0000-4000-8000-000000000001'), 8,
  'закрытие пустого счёта склад не трогает');
SELECT is(
  (SELECT count(*) FROM order_items WHERE order_id = current_setting('test.o1')::UUID AND voided_at IS NOT NULL),
  1::BIGINT, 'отменённая порция осталась в старом счёте как след');

SELECT * FROM finish();
ROLLBACK;
