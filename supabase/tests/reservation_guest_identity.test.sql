-- pgTAP: структурное имя гостя и почта в публичной брони (163).
--
-- Главное, что здесь проверяется, — СОВМЕСТИМОСТЬ. Новые колонки не имеют
-- права сломать ни одного существующего потребителя: `customer_name`
-- заполняется всегда, старый вызов без новых параметров работает как
-- раньше, привязка к профилю гостя по телефону (121) не меняется, а
-- наружу почта не выходит.

BEGIN;
SELECT plan(23);

INSERT INTO orgs (id, name) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'pgTAP identity');
INSERT INTO locations (id, org_id, name, timezone, settings) VALUES
  ('e1000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001', 'Identity loc', 'Asia/Jerusalem',
   jsonb_build_object('reservations', jsonb_build_object(
     'enabled', TRUE,
     'instant', FALSE,
     'max_party', 20,
     'schedule', jsonb_build_object(
       'weekly', jsonb_build_object(
         '0', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '1', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '2', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '3', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '4', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '5', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '6', jsonb_build_array(jsonb_build_array('00:00', '23:45'))),
       'lead_min', 0,
       'horizon_days', 30))));
INSERT INTO organization_products (org_id, product) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'reservations');

-- ── Нормализация почты ───────────────────────────────────────

SELECT is(normalize_guest_email('  Guest@Example.COM '), 'guest@example.com',
          'почта приводится к нижнему регистру и обрезается');
SELECT is(normalize_guest_email(''), NULL, 'пустая строка — это «не указана», а не ошибка');
SELECT is(normalize_guest_email(NULL), NULL, 'NULL остаётся NULL');
SELECT throws_ok($$ SELECT normalize_guest_email('guest@example') $$,
                 'invalid_email', 'домен без точки отклонён');
SELECT throws_ok($$ SELECT normalize_guest_email('a@b@c.com') $$,
                 'invalid_email', 'две собаки отклонены');
SELECT throws_ok($$ SELECT normalize_guest_email('guest example@mail.com') $$,
                 'invalid_email', 'пробел внутри адреса отклонён');
SELECT throws_ok(
  format($$ SELECT normalize_guest_email(%L) $$, repeat('a', 250) || '@b.com'),
  'invalid_email', 'адрес длиннее 254 символов отклонён');

-- ── Новый клиент: структурное имя + почта ────────────────────

SELECT lives_ok($$
  SELECT submit_reservation(
    'e1000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    NULL, '0541234567', 2, NOW() + INTERVAL '2 hours',
    NULL, NULL, NULL,
    'וולד', 'אנוטוב', 'Guest@Example.com')
$$, 'заявка со структурным именем принимается');

SELECT is(
  (SELECT customer_first_name FROM reservations
   WHERE client_uuid = 'e2000000-0000-4000-8000-000000000001'),
  'וולד', 'имя сохранено отдельной колонкой');
SELECT is(
  (SELECT customer_last_name FROM reservations
   WHERE client_uuid = 'e2000000-0000-4000-8000-000000000001'),
  'אנוטוב', 'фамилия сохранена отдельной колонкой');
SELECT is(
  (SELECT customer_email FROM reservations
   WHERE client_uuid = 'e2000000-0000-4000-8000-000000000001'),
  'guest@example.com', 'почта нормализована на сервере');
-- Совместимость: по этой колонке живут касса, карточка гостя и выгрузки
SELECT is(
  (SELECT customer_name FROM reservations
   WHERE client_uuid = 'e2000000-0000-4000-8000-000000000001'),
  'וולד אנוטוב', 'customer_name собран сервером из частей');

-- Привязка к профилю (121) идёт по телефону и не изменилась
SELECT isnt(
  (SELECT guest_id FROM reservations
   WHERE client_uuid = 'e2000000-0000-4000-8000-000000000001'),
  NULL, 'бронь по-прежнему привязана к профилю гостя по телефону');

-- ── Старый клиент: только p_name ─────────────────────────────

SELECT lives_ok($$
  SELECT submit_reservation(
    'e1000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000002',
    'Старый Клиент', '0549999999', 2, NOW() + INTERVAL '3 hours')
$$, 'клиент, выложенный до 163, продолжает работать');

SELECT is(
  (SELECT customer_name FROM reservations
   WHERE client_uuid = 'e2000000-0000-4000-8000-000000000002'),
  'Старый Клиент', 'имя старого клиента сохранено как прежде');
SELECT is(
  (SELECT customer_first_name FROM reservations
   WHERE client_uuid = 'e2000000-0000-4000-8000-000000000002'),
  NULL, 'структурных частей у старой заявки нет — и это допустимо');
SELECT is(
  (SELECT customer_email FROM reservations
   WHERE client_uuid = 'e2000000-0000-4000-8000-000000000002'),
  NULL, 'почта пока не обязательна: заявка без неё принимается');

-- ── Отказы ───────────────────────────────────────────────────

SELECT throws_ok($$
  SELECT submit_reservation(
    'e1000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000003',
    NULL, '0541111111', 2, NOW() + INTERVAL '4 hours',
    NULL, NULL, NULL, 'Имя', 'Фамилия', 'сломанный адрес')
$$, 'invalid_email', 'битая почта отклоняется сервером');

SELECT throws_ok($$
  SELECT submit_reservation(
    'e1000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000004',
    NULL, '0542222222', 2, NOW() + INTERVAL '4 hours',
    NULL, NULL, NULL, NULL, NULL, 'guest@example.com')
$$, 'invalid_name', 'без имени вовсе заявка не проходит');

-- Клиент не может подменить сумму или статус: их тут просто нет,
-- а идемпотентность по client_uuid остаётся прежней.
SELECT is(
  (SELECT (submit_reservation(
     'e1000000-0000-4000-8000-000000000001',
     'e2000000-0000-4000-8000-000000000001',
     NULL, '0541234567', 2, NOW() + INTERVAL '2 hours',
     NULL, NULL, NULL, 'вольд', 'анотов', 'other@example.com') ->> 'duplicate')::BOOLEAN),
  TRUE, 'повтор того же client_uuid остаётся идемпотентным');
SELECT is(
  (SELECT customer_email FROM reservations
   WHERE client_uuid = 'e2000000-0000-4000-8000-000000000001'),
  'guest@example.com', 'повтор не переписывает уже сохранённые контакты');

-- ── Наружу контакты не выходят ───────────────────────────────

SELECT ok(
  NOT (reservation_public_view(
        (SELECT public_token FROM reservations
         WHERE client_uuid = 'e2000000-0000-4000-8000-000000000001'))::JSONB
       ? 'customer_email'),
  'публичная карточка брони не отдаёт почту');
SELECT ok(
  NOT (reservation_public_view(
        (SELECT public_token FROM reservations
         WHERE client_uuid = 'e2000000-0000-4000-8000-000000000001'))::JSONB
       ? 'customer_phone'),
  'публичная карточка брони не отдаёт телефон');

SELECT * FROM finish();
ROLLBACK;
