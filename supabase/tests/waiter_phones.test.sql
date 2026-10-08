-- pgTAP: телефон официанта (180).
--
-- Телефон — отдельный Auth-аккаунт без организации: прямым запросом он
-- не видит ни строки, работает только через waiter_*. Официант входит
-- своим PIN, отправляет заказ без ручной цены и только в столы своей
-- точки; заказ и тикет пишутся вместе, тикет печатает ровно одна касса.

BEGIN;
SELECT plan(58);

-- ── Данные ──────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES ('b8000000-0000-4000-8000-000000000001', 'pgTAP waiter');
INSERT INTO organization_products (org_id, product) VALUES ('b8000000-0000-4000-8000-000000000001', 'pos');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('b8100000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001', 'Hall', 'Asia/Jerusalem'),
  ('b8100000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-000000000001', 'Branch', 'Asia/Jerusalem');

-- Официант, владелец, уволенный, сотрудник другого филиала
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash, is_active) VALUES
  ('b8200000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', 'Dana', 'barista', extensions.crypt('1234', extensions.gen_salt('bf')), TRUE),
  ('b8200000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', 'Owner', 'owner', extensions.crypt('9999', extensions.gen_salt('bf')), TRUE),
  ('b8200000-0000-4000-8000-000000000003', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', 'Gone', 'barista', extensions.crypt('5555', extensions.gen_salt('bf')), FALSE),
  ('b8200000-0000-4000-8000-000000000004', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000002', 'Other', 'barista', extensions.crypt('7777', extensions.gen_salt('bf')), TRUE);

INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float) VALUES
  ('b8300000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', 'b8200000-0000-4000-8000-000000000002', 'open', 0);

INSERT INTO tables (id, org_id, location_id, label) VALUES
  ('b8400000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', '1'),
  ('b8400000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', '2'),
  ('b8400000-0000-4000-8000-000000000009', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000002', '9');

INSERT INTO menu_categories (id, org_id, location_id, name, sort_order) VALUES
  ('b8500000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', 'Kitchen', 0);

INSERT INTO menu_items (id, org_id, category_id, name, price, course, is_available, cost) VALUES
  ('b8600000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001',
   'b8500000-0000-4000-8000-000000000001', 'Salad', 3000, 1, TRUE, 900),
  ('b8600000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-000000000001',
   'b8500000-0000-4000-8000-000000000001', 'Steak', 9000, 2, TRUE, 4000),
  ('b8600000-0000-4000-8000-000000000003', 'b8000000-0000-4000-8000-000000000001',
   'b8500000-0000-4000-8000-000000000001', 'Water', 1000, NULL, TRUE, 100),
  ('b8600000-0000-4000-8000-000000000004', 'b8000000-0000-4000-8000-000000000001',
   'b8500000-0000-4000-8000-000000000001', 'Stopped', 2000, NULL, FALSE, 500);

INSERT INTO modifier_groups (id, org_id, name, min_select, max_select) VALUES
  ('b8700000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001', 'Doneness', 0, 1);
INSERT INTO modifiers (id, org_id, group_id, name, price_delta) VALUES
  ('b8710000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001',
   'b8700000-0000-4000-8000-000000000001', 'Medium', 0);
INSERT INTO menu_item_modifier_groups (item_id, group_id, org_id) VALUES
  ('b8600000-0000-4000-8000-000000000002', 'b8700000-0000-4000-8000-000000000001',
   'b8000000-0000-4000-8000-000000000001');

-- Аккаунты: телефон P1, отключённый телефон P2, касса D1
INSERT INTO auth.users (id) VALUES
  ('b8900000-0000-4000-8000-0000000000a1'),
  ('b8900000-0000-4000-8000-0000000000a2'),
  ('b8900000-0000-4000-8000-0000000000d1');

INSERT INTO waiter_devices (id, org_id, location_id, auth_user_id, label, revoked_at) VALUES
  ('b8a00000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', 'b8900000-0000-4000-8000-0000000000a1', 'Phone 1', NULL),
  ('b8a00000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', 'b8900000-0000-4000-8000-0000000000a2', 'Phone 2', NOW());

-- Касса с включённой печатью заказов официантов
INSERT INTO devices (org_id, location_id, name, device_uuid, auth_user_id, settings, last_seen_at) VALUES
  ('b8000000-0000-4000-8000-000000000001', 'b8100000-0000-4000-8000-000000000001', 'T2',
   'b8b00000-0000-4000-8000-000000000001', 'b8900000-0000-4000-8000-0000000000d1',
   '{"printWaiterTickets": true}', NOW());

-- Сессия менеджера на кассе (для кода допуска и отключения)
WITH s AS (
  INSERT INTO staff_sessions (staff_id, org_id, location_id)
  VALUES ('b8200000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-000000000001',
          'b8100000-0000-4000-8000-000000000001')
  RETURNING token
)
SELECT set_config('test.mgr', token::TEXT, TRUE) FROM s;


-- ── Телефон: прямым запросом не видно ничего ─────────────────
SELECT set_config('request.jwt.claims',
  '{"sub":"b8900000-0000-4000-8000-0000000000a1","role":"authenticated"}', TRUE);
SET LOCAL ROLE authenticated;

SELECT is((SELECT count(*) FROM menu_items), 0::BIGINT, 'телефон не читает меню напрямую');
SELECT is((SELECT count(*) FROM tables), 0::BIGINT, 'телефон не читает столы напрямую');
SELECT is((SELECT count(*) FROM print_jobs), 0::BIGINT, 'телефон не читает задания печати');
SELECT throws_ok($$ SELECT count(*) FROM waiter_devices $$, '42501', NULL,
  'таблица телефонов закрыта целиком');
SELECT throws_ok($$ SELECT claim_print_jobs('b8b00000-0000-4000-8000-000000000009') $$,
  'not authenticated', 'телефон не забирает задания печати кассы');
SELECT throws_ok($$ SELECT waiter_pair_bind('X', 'b8900000-0000-4000-8000-0000000000a1') $$,
  '42501', NULL, 'привязка аккаунта — только service_role');
SELECT throws_ok($$ SELECT waiter_hall(NULL) $$, 'staff session required',
  'без PIN-сессии телефон ничего не получает');

-- ── PIN официанта ───────────────────────────────────────────
SELECT is((waiter_unlock('0000') ->> 'ok')::BOOLEAN, FALSE, 'неверный PIN — отказ без исключения');
SELECT is((waiter_unlock('5555') ->> 'ok')::BOOLEAN, FALSE, 'PIN уволенного не работает');
SELECT is((waiter_unlock('7777') ->> 'ok')::BOOLEAN, FALSE, 'PIN сотрудника другого филиала не работает');

SELECT set_config('test.s', waiter_unlock('1234') ->> 'session_token', TRUE);
SELECT isnt(current_setting('test.s'), NULL, 'верный PIN выдаёт сессию');
SELECT is(
  (SELECT current_setting('request.jwt.claims')::JSONB -> 'app_metadata'),
  NULL::JSONB,
  'после вызова claims телефона восстановлены: точки в них нет'
);
SELECT is((SELECT count(*) FROM orders), 0::BIGINT, 'после вызова RLS по-прежнему ничего не отдаёт');

-- ── Чтение ──────────────────────────────────────────────────
SELECT is(json_array_length(waiter_hall(current_setting('test.s')::UUID) -> 'tables'), 2,
  'зал: только столы своей точки');
SELECT is((waiter_hall(current_setting('test.s')::UUID) ->> 'shift_open')::BOOLEAN, TRUE,
  'зал: смена открыта');
SELECT is((waiter_hall(current_setting('test.s')::UUID) ->> 'printer_ready')::BOOLEAN, TRUE,
  'зал: касса с печатью заказов на связи');
SELECT is(json_array_length(waiter_menu(current_setting('test.s')::UUID) -> 'items'), 4,
  'меню: все товары каталога (стоп-лист фильтрует телефон)');
SELECT ok(
  NOT ((waiter_menu(current_setting('test.s')::UUID) -> 'items' -> 0)::JSONB ? 'cost'),
  'меню: без себестоимости'
);
SELECT is((waiter_bill(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000001') -> 'order')::TEXT,
  'null', 'свободный стол: счёта нет');

-- ── Отправка: только каталог, только своя точка ─────────────
SELECT throws_ok($$
  SELECT waiter_send(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000001',
    'b8c00000-0000-4000-8000-000000000001',
    '[{"id":"b8d00000-0000-4000-8000-000000000001","menu_item_id":"b8600000-0000-4000-8000-000000000001","qty":1,"unit_price_override":1}]')
$$, 'waiter_price_forbidden', 'ручная цена с телефона запрещена');
SELECT throws_ok($$
  SELECT waiter_send(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000001',
    'b8c00000-0000-4000-8000-000000000001',
    '[{"id":"b8d00000-0000-4000-8000-000000000001","custom_name":"Free","qty":1}]')
$$, 'waiter_price_forbidden', 'свободная позиция с телефона запрещена');
SELECT throws_ok($$
  SELECT waiter_send(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000001',
    'b8c00000-0000-4000-8000-000000000001',
    '[{"id":"b8d00000-0000-4000-8000-000000000001","menu_item_id":"b8600000-0000-4000-8000-000000000004","qty":1}]')
$$, 'item_unavailable', 'блюдо из стоп-листа не отправляется');
SELECT throws_ok($$
  SELECT waiter_send(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000009',
    'b8c00000-0000-4000-8000-000000000001',
    '[{"id":"b8d00000-0000-4000-8000-000000000001","menu_item_id":"b8600000-0000-4000-8000-000000000001","qty":1}]')
$$, 'table not found', 'стол другого филиала недоступен');

SELECT lives_ok($$
  SELECT waiter_send(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000001',
    'b8c00000-0000-4000-8000-000000000001',
    '[{"id":"b8d00000-0000-4000-8000-000000000001","menu_item_id":"b8600000-0000-4000-8000-000000000001","qty":1},
      {"id":"b8d00000-0000-4000-8000-000000000002","menu_item_id":"b8600000-0000-4000-8000-000000000002","qty":1,
       "modifier_ids":["b8710000-0000-4000-8000-000000000001"],"notes":"no salt"},
      {"id":"b8d00000-0000-4000-8000-000000000003","menu_item_id":"b8600000-0000-4000-8000-000000000003","qty":2}]')
$$, 'заказ на свободный стол уходит');

SELECT is(
  (waiter_send(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000001',
    'b8c00000-0000-4000-8000-000000000001',
    '[{"id":"b8d00000-0000-4000-8000-000000000001","menu_item_id":"b8600000-0000-4000-8000-000000000001","qty":1}]')
   ->> 'replay')::BOOLEAN,
  TRUE, 'повтор того же op_uuid — без новой записи'
);
SELECT is((SELECT count(*) FROM orders), 0::BIGINT, 'после отправки RLS телефона всё так же пуст');

SELECT is(json_array_length(waiter_bill(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000001') -> 'lines'), 3,
  'счёт стола: три строки, повтор не задвоил');

RESET ROLE;

SELECT is(
  (SELECT total FROM orders WHERE table_id = 'b8400000-0000-4000-8000-000000000001' AND status = 'open'),
  14000, 'итог посчитан сервером по каталогу'
);
SELECT is(
  (SELECT staff_id FROM orders WHERE table_id = 'b8400000-0000-4000-8000-000000000001' AND status = 'open'),
  'b8200000-0000-4000-8000-000000000001'::UUID, 'счёт открыт от имени вошедшего официанта'
);
SELECT is(
  (SELECT held FROM order_items WHERE id = 'b8d00000-0000-4000-8000-000000000002'),
  TRUE, 'горячее придержано: на столе есть закуска'
);
SELECT is((SELECT count(*) FROM print_jobs), 1::BIGINT, 'одно задание печати на отправку');
SELECT is(
  (SELECT array_agg(l ->> 'name') FROM print_jobs, jsonb_array_elements(payload -> 'lines') l
   WHERE id = 'b8c00000-0000-4000-8000-000000000001'),
  ARRAY['Salad', 'Water'], 'тикет: только то, что кухня готовит сейчас, в порядке заказа'
);
SELECT is(
  (SELECT payload ->> 'tableLabel' || '/' || (payload ->> 'staffName') || '/' || (payload ->> 'fire')
   FROM print_jobs WHERE id = 'b8c00000-0000-4000-8000-000000000001'),
  '1/Dana/false', 'тикет помнит стол и официанта'
);

-- ── Fire с телефона ─────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT is(
  json_array_length(waiter_fire(current_setting('test.s')::UUID,
    (SELECT (waiter_bill(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000001') -> 'order' ->> 'id')::UUID),
    ARRAY['b8d00000-0000-4000-8000-000000000002']::UUID[],
    'b8c00000-0000-4000-8000-000000000002') -> 'fired'),
  1, 'Fire отпускает горячее'
);
SELECT is(
  (waiter_fire(current_setting('test.s')::UUID,
    (SELECT (waiter_bill(current_setting('test.s')::UUID, 'b8400000-0000-4000-8000-000000000001') -> 'order' ->> 'id')::UUID),
    ARRAY['b8d00000-0000-4000-8000-000000000002']::UUID[],
    'b8c00000-0000-4000-8000-000000000002') ->> 'job_id'),
  'b8c00000-0000-4000-8000-000000000002', 'повтор Fire возвращает тот же тикет'
);
SELECT is(
  json_array_length(waiter_print_status(current_setting('test.s')::UUID,
    ARRAY['b8c00000-0000-4000-8000-000000000001', 'b8c00000-0000-4000-8000-000000000002']::UUID[])),
  2, 'телефон видит статус своих тикетов'
);
RESET ROLE;

SELECT is(
  (SELECT payload ->> 'fire' || '/' || (payload -> 'lines' -> 0 ->> 'name') || '/' || (payload -> 'lines' -> 0 ->> 'notes')
   FROM print_jobs WHERE id = 'b8c00000-0000-4000-8000-000000000002'),
  'true/Steak/no salt', 'тикет FIRE: отпущенное блюдо с заметкой'
);
SELECT is((SELECT count(*) FROM print_jobs), 2::BIGINT, 'повтор Fire не создал второй тикет');

-- ── Отключённый телефон и касса вместо телефона ─────────────
SELECT set_config('request.jwt.claims',
  '{"sub":"b8900000-0000-4000-8000-0000000000a2","role":"authenticated"}', TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT waiter_unlock('1234') $$, 'waiter_device_revoked',
  'отключённый телефон не входит');
RESET ROLE;

SELECT set_config('request.jwt.claims',
  '{"sub":"b8900000-0000-4000-8000-0000000000d1","role":"authenticated","app_metadata":{"org_id":"b8000000-0000-4000-8000-000000000001","location_id":"b8100000-0000-4000-8000-000000000001"}}',
  TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT waiter_hall(current_setting('test.s')::UUID) $$, 'waiter_device_revoked',
  'касса не может выдать себя за телефон');

-- ── Касса печатает: ровно один раз ──────────────────────────
SELECT is((SELECT count(*) FROM print_jobs), 2::BIGINT, 'касса точки видит задания своей точки');
SELECT is(json_array_length(claim_print_jobs('b8b00000-0000-4000-8000-000000000001')), 2,
  'касса забирает оба задания');
SELECT is(json_array_length(claim_print_jobs('b8b00000-0000-4000-8000-000000000002')), 0,
  'вторая касса не получает уже забранное');
SELECT lives_ok($$ SELECT finish_print_job('b8c00000-0000-4000-8000-000000000001', TRUE) $$,
  'касса отчиталась о печати');
SELECT lives_ok($$ SELECT finish_print_job('b8c00000-0000-4000-8000-000000000002', FALSE, 'no-paper') $$,
  'касса отчиталась об ошибке');
SELECT lives_ok($$ SELECT finish_print_job('b8c00000-0000-4000-8000-000000000002', TRUE) $$,
  'повтор печати после ошибки');
RESET ROLE;

SELECT is(
  (SELECT array_agg(status ORDER BY id) FROM print_jobs),
  ARRAY['printed', 'printed'], 'оба тикета напечатаны'
);

-- Залежавшееся и прерванное не печатается вслепую
INSERT INTO print_jobs (id, org_id, location_id, kind, payload, status, created_at) VALUES
  ('b8c00000-0000-4000-8000-0000000000e1', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', 'kitchen', '{}', 'pending', NOW() - INTERVAL '31 minutes');
INSERT INTO print_jobs (id, org_id, location_id, kind, payload, status, claimed_at) VALUES
  ('b8c00000-0000-4000-8000-0000000000e2', 'b8000000-0000-4000-8000-000000000001',
   'b8100000-0000-4000-8000-000000000001', 'kitchen', '{}', 'printing', NOW() - INTERVAL '3 minutes');
SET LOCAL ROLE authenticated;
SELECT is(json_array_length(claim_print_jobs('b8b00000-0000-4000-8000-000000000001')), 0,
  'старое и прерванное не выдаётся на печать');
RESET ROLE;
SELECT is(
  (SELECT status || '/' || error FROM print_jobs WHERE id = 'b8c00000-0000-4000-8000-0000000000e1'),
  'expired/expired', 'тикет старше 30 минут — просрочен'
);
SELECT is(
  (SELECT status || '/' || error FROM print_jobs WHERE id = 'b8c00000-0000-4000-8000-0000000000e2'),
  'failed/interrupted', 'прерванная печать — ошибка, без повтора вслепую'
);

-- ── Допуск нового телефона ──────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('test.code',
  create_waiter_pairing_code(NULL, current_setting('test.mgr')::UUID) ->> 'code', TRUE);
RESET ROLE;
SELECT is(length(current_setting('test.code')), 8, 'код допуска из 8 символов');
SELECT is(waiter_pair_check(lower(current_setting('test.code'))) ->> 'location_name', 'Hall',
  'код действителен без учёта регистра');
SELECT throws_ok($$ SELECT waiter_pair_check('AAAAAAAA') $$, 'invalid_code', 'чужой код не подходит');
INSERT INTO auth.users (id) VALUES ('b8900000-0000-4000-8000-0000000000a3');
SELECT lives_ok($$
  SELECT waiter_pair_bind(current_setting('test.code'), 'b8900000-0000-4000-8000-0000000000a3', 'iPhone')
$$, 'телефон привязан кодом');
SELECT throws_ok($$
  SELECT waiter_pair_bind(current_setting('test.code'), 'b8900000-0000-4000-8000-0000000000a2', 'Again')
$$, 'invalid_code', 'код одноразовый');

-- ── Отключение телефона и увольнение официанта ──────────────
SET LOCAL ROLE authenticated;
SELECT lives_ok($$
  SELECT revoke_waiter_device_web('b8a00000-0000-4000-8000-000000000001', current_setting('test.mgr')::UUID)
$$, 'менеджер отключает телефон');
RESET ROLE;
SELECT is((SELECT count(*) FROM auth.users WHERE id = 'b8900000-0000-4000-8000-0000000000a1'), 0::BIGINT,
  'аккаунт отключённого телефона удалён');

SELECT set_config('request.jwt.claims',
  '{"sub":"b8900000-0000-4000-8000-0000000000a3","role":"authenticated"}', TRUE);
UPDATE staff SET is_active = FALSE WHERE id = 'b8200000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT waiter_hall(current_setting('test.s')::UUID) $$, 'staff session invalid',
  'уволенный официант теряет доступ и с другого телефона');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
