-- pgTAP: база клиентов лояльности (114).
--
-- Проверяется get_guest_card: состав заказа («что покупал»), отсечение
-- отменённых строк, любимые позиции, журнал начислений; и грант на
-- guests.notes при неприкосновенности балансов. Изоляция по org
-- обеспечивается RLS (SECURITY INVOKER) — проверяется в rls_scope.

BEGIN;
SELECT plan(13);

-- ── Функции существуют и закрыты для anon ──────────────────
SELECT has_function('get_guest_card');
SELECT has_function('get_backoffice_guests');

SELECT ok(
  NOT has_function_privilege('anon', 'get_guest_card(uuid, integer)', 'EXECUTE'),
  'anon не вызывает get_guest_card'
);

SELECT ok(
  has_function_privilege('authenticated', 'get_guest_card(uuid, integer)', 'EXECUTE'),
  'authenticated вызывает get_guest_card'
);

-- ── Колонка заметки и колоночные гранты ────────────────────
SELECT has_column('guests', 'notes');

SELECT ok(
  has_column_privilege('authenticated', 'guests', 'notes', 'UPDATE'),
  'клиент правит заметку гостя'
);

-- Балансы по-прежнему server-only (инвариант 031)
SELECT ok(
  NOT has_column_privilege('authenticated', 'guests', 'points', 'UPDATE'),
  'клиент НЕ правит баллы'
);
SELECT ok(
  NOT has_column_privilege('authenticated', 'guests', 'stamps', 'UPDATE'),
  'клиент НЕ правит штампы'
);

-- ── Фикстура: гость с оплаченным заказом ───────────────────
INSERT INTO orgs (id, name) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'pgTAP guest crm');
INSERT INTO locations (id, org_id, name) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Loc');
INSERT INTO guests (id, org_id, phone, name, points, visits, total_spent) VALUES
  ('d2000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001', '0500000001', 'Тест', 500, 2, 4000);

INSERT INTO staff (id, org_id, name, role, pin_hash) VALUES
  ('d4000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001', 'Бариста', 'barista', 'x');

INSERT INTO orders (id, org_id, location_id, staff_id, client_uuid, daily_number,
                    status, subtotal, vat_rate, total, guest_id)
VALUES ('d3000000-0000-4000-8000-000000000001',
        'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
        'd4000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001',
        1, 'paid', 2000, 18, 2000, 'd2000000-0000-4000-8000-000000000001');

-- Две живые строки + одна отменённая (в состав попасть не должна)
INSERT INTO order_items (org_id, order_id, name, unit_price, qty, line_total, voided_at) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001',
   'Капучино', 1200, 1, 1200, NULL),
  ('d0000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001',
   'Круассан', 800, 1, 800, NULL),
  ('d0000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001',
   'Отменённый', 500, 1, 500, NOW());

INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, points_delta)
VALUES ('d0000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001',
        'd3000000-0000-4000-8000-000000000001', 'earn', 100);

-- ── Карточка отдаёт состав заказа ──────────────────────────
SELECT is(
  jsonb_array_length(
    (get_guest_card('d2000000-0000-4000-8000-000000000001') -> 'orders' -> 0 -> 'items')
  ),
  2,
  'в составе заказа только НЕотменённые позиции'
);

SELECT is(
  (get_guest_card('d2000000-0000-4000-8000-000000000001')
     -> 'orders' -> 0 -> 'items' -> 0 ->> 'name'),
  'Капучино',
  'позиции заказа видны поимённо'
);

-- ── Любимые позиции и журнал ───────────────────────────────
SELECT is(
  jsonb_array_length(get_guest_card('d2000000-0000-4000-8000-000000000001') -> 'favorites'),
  2,
  'любимые позиции посчитаны по оплаченным заказам'
);

SELECT is(
  (get_guest_card('d2000000-0000-4000-8000-000000000001')
     -> 'events' -> 0 ->> 'points_delta')::int,
  100,
  'журнал начислений виден в карточке'
);

-- ── Режим программы в карточке (115) ───────────────────────
-- Бэкофис показывает баланс штампами или деньгами по этому полю
UPDATE locations SET loyalty_mode = 'stamps'
WHERE id = 'd1000000-0000-4000-8000-000000000001';

SELECT is(
  (get_guest_card('d2000000-0000-4000-8000-000000000001') ->> 'loyalty_mode'),
  'stamps',
  'карточка отдаёт режим лояльности точки'
);

SELECT * FROM finish();
ROLLBACK;
