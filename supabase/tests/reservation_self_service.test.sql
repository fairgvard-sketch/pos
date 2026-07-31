-- pgTAP: постоянная ссылка на бронь, перенос и отмена по отсечке (118).
--
-- Доступ гостя к брони до 118 держался на client_uuid в localStorage
-- одного браузера, а перенести время было нельзя вовсе. Здесь проверяется
-- то, на чём стоит самообслуживание: секрет ссылки, серверный вердикт
-- «можно ли ещё», и что неудачный перенос НЕ отнимает у гостя уже
-- имеющуюся бронь.

BEGIN;
SELECT plan(30);

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'pgTAP reserve self-service');

INSERT INTO locations (id, org_id, name, timezone, receipt_address, receipt_phone) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'Self loc', 'Asia/Jerusalem', 'Dizengoff 1', '036000000');

INSERT INTO organization_products (org_id, product) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'reservations');

INSERT INTO table_zones (id, org_id, location_id, name) VALUES
  ('e4000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', 'Зал');

INSERT INTO tables (id, org_id, location_id, label, zone_id, seats, sort_order) VALUES
  ('e2000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', '1', 'e4000000-0000-4000-8000-000000000001', 2, 1);

-- Открыто круглосуточно всю неделю: тест про самообслуживание, а не про часы.
CREATE FUNCTION pg_temp.settings(p_extra JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object('reservations',
    jsonb_build_object(
      'enabled', TRUE,
      'schedule', jsonb_build_object(
        'weekly', (SELECT jsonb_object_agg(i::TEXT, '[["00:00","23:59"]]'::jsonb)
                   FROM generate_series(0, 6) i),
        'exceptions', '{}'::jsonb, 'lead_min', 30, 'horizon_days', 365)
    ) || p_extra)
$$;

/** Бронь напрямую, минуя submit: фиксируем нужный статус и время. */
CREATE FUNCTION pg_temp.book(p_client UUID, p_at TIMESTAMPTZ, p_status TEXT,
                             p_table UUID DEFAULT 'e2000000-0000-4000-8000-000000000001')
RETURNS UUID LANGUAGE sql AS $$
  INSERT INTO reservations (
    org_id, location_id, client_uuid, customer_name, customer_phone,
    party_size, reserved_at, duration_min, table_id, status)
  VALUES (
    'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
    p_client, 'Гость', '0501234567', 2, p_at, 90,
    CASE WHEN p_status IN ('new', 'confirmed') THEN p_table ELSE NULL END, p_status)
  RETURNING public_token
$$;

CREATE FUNCTION pg_temp.at_in(p_interval INTERVAL) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$ SELECT NOW() + p_interval $$;

CREATE FUNCTION pg_temp.status_of(p_key UUID) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT status FROM reservations WHERE public_token = p_key OR client_uuid = p_key
$$;

CREATE FUNCTION pg_temp.time_of(p_key UUID) RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT reserved_at FROM reservations WHERE public_token = p_key OR client_uuid = p_key
$$;

UPDATE locations SET settings = pg_temp.settings()
WHERE id = 'e1000000-0000-4000-8000-000000000001';

-- ── 1. Постоянная ссылка ─────────────────────────────────────
SELECT ok(
  (SELECT COUNT(*) FROM reservations WHERE public_token IS NULL) = 0,
  'у каждой брони есть public_token (DEFAULT заполняет и старые строки)'
);

SELECT lives_ok($$ SELECT pg_temp.book(
  'e9000000-0000-4000-8000-000000000001', pg_temp.at_in(INTERVAL '2 days'), 'confirmed') $$,
  'фикстура: подтверждённая бронь через двое суток');

SELECT is(
  (reservation_public_view(
    (SELECT public_token FROM reservations
     WHERE client_uuid = 'e9000000-0000-4000-8000-000000000001'))::jsonb ->> 'status'),
  'confirmed',
  'карточка брони открывается по public_token');

SELECT is(
  (reservation_public_view('e9000000-0000-4000-8000-000000000001')::jsonb ->> 'status'),
  'confirmed',
  'та же карточка открывается по старому client_uuid (совместимость)');

SELECT is(
  (reservation_public_view('e9000000-0000-4000-8000-000000000001')::jsonb -> 'location' ->> 'address'),
  'Dizengoff 1',
  'карточка несёт адрес точки — гостю не нужно возвращаться на витрину');

SELECT is(
  (reservation_public_view('e9000000-0000-4000-8000-000000000001')::jsonb -> 'location' ->> 'phone'),
  '036000000',
  'карточка несёт телефон заведения');

SELECT throws_ok(
  $$ SELECT reservation_public_view('e9000000-0000-4000-8000-0000000000ff') $$,
  'not_found', 'чужой/несуществующий ключ не открывает ничего');

-- ── 2. Отмена и отсечка ──────────────────────────────────────
SELECT ok(
  (reservation_public_view('e9000000-0000-4000-8000-000000000001')::jsonb ->> 'can_cancel')::BOOLEAN,
  'без настроенной отсечки отмена разрешена (поведение до 118)');

-- Отсечка 24 часа: бронь через двое суток ещё отменяема.
UPDATE locations SET settings = pg_temp.settings(
  '{"cancel_cutoff_min":1440,"reschedule_cutoff_min":1440}'::jsonb)
WHERE id = 'e1000000-0000-4000-8000-000000000001';

SELECT ok(
  (reservation_public_view('e9000000-0000-4000-8000-000000000001')::jsonb ->> 'can_cancel')::BOOLEAN,
  'отсечка 24ч: за двое суток отмена ещё разрешена');

-- Бронь через час — уже поздно.
SELECT lives_ok($$ SELECT pg_temp.book(
  'e9000000-0000-4000-8000-000000000002', pg_temp.at_in(INTERVAL '1 hour'), 'confirmed', NULL) $$,
  'фикстура: подтверждённая бронь через час');

SELECT ok(
  NOT (reservation_public_view('e9000000-0000-4000-8000-000000000002')::jsonb ->> 'can_cancel')::BOOLEAN,
  'отсечка 24ч: за час до визита отмена закрыта');
SELECT is(
  (reservation_public_view('e9000000-0000-4000-8000-000000000002')::jsonb ->> 'cancel_block'),
  'too_late',
  'причина отказа отдаётся стабильным кодом, а не пустотой');

SELECT throws_ok(
  $$ SELECT cancel_reservation('e9000000-0000-4000-8000-000000000002') $$,
  'too_late', 'поздняя отмена отклоняется сервером, а не только скрыта в UI');

-- Нерешённую заявку гость снимает всегда: заведение ещё не обязалось.
SELECT lives_ok($$ SELECT pg_temp.book(
  'e9000000-0000-4000-8000-000000000003', pg_temp.at_in(INTERVAL '1 hour'), 'new', NULL) $$,
  'фикстура: неподтверждённая заявка через час');
SELECT lives_ok(
  $$ SELECT cancel_reservation('e9000000-0000-4000-8000-000000000003') $$,
  'заявку в статусе new отсечка не блокирует');
SELECT is(pg_temp.status_of('e9000000-0000-4000-8000-000000000003'), 'cancelled',
  'заявка отменена');
SELECT lives_ok(
  $$ SELECT cancel_reservation('e9000000-0000-4000-8000-000000000003') $$,
  'повторная отмена идемпотентна, а не ошибка');

-- ── 3. Перенос ───────────────────────────────────────────────
UPDATE locations SET settings = pg_temp.settings('{"instant":true}'::jsonb)
WHERE id = 'e1000000-0000-4000-8000-000000000001';

SELECT lives_ok($$
  SELECT reschedule_reservation('e9000000-0000-4000-8000-000000000001',
                                pg_temp.at_in(INTERVAL '3 days'))
$$, 'перенос подтверждённой брони на свободное время проходит');

SELECT is(pg_temp.status_of('e9000000-0000-4000-8000-000000000001'), 'confirmed',
  'instant-режим: после переноса бронь остаётся подтверждённой');
SELECT ok(
  (SELECT reschedule_count = 1 AND previous_reserved_at IS NOT NULL
   FROM reservations WHERE client_uuid = 'e9000000-0000-4000-8000-000000000001'),
  'перенос оставляет след: счётчик и прежнее время');

-- Вне часов работы перенести нельзя.
UPDATE locations SET settings = jsonb_set(
  pg_temp.settings('{"instant":true}'::jsonb),
  '{reservations,schedule,weekly}',
  (SELECT jsonb_object_agg(i::TEXT, '[["08:00","10:00"]]'::jsonb) FROM generate_series(0, 6) i))
WHERE id = 'e1000000-0000-4000-8000-000000000001';

SELECT throws_ok($$
  SELECT reschedule_reservation('e9000000-0000-4000-8000-000000000001',
    (CURRENT_DATE + 4 + TIME '20:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'outside_hours', 'перенос на время вне расписания отклонён');

UPDATE locations SET settings = pg_temp.settings('{"instant":true}'::jsonb)
WHERE id = 'e1000000-0000-4000-8000-000000000001';

-- Занятое время: перенос не проходит И НЕ СТИРАЕТ уже имеющуюся бронь.
SELECT lives_ok($$ SELECT pg_temp.book(
  'e9000000-0000-4000-8000-000000000004', pg_temp.at_in(INTERVAL '5 days'), 'confirmed') $$,
  'фикстура: чужая бронь занимает единственный стол через 5 суток');

CREATE FUNCTION pg_temp.kept_time() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT reserved_at FROM reservations WHERE client_uuid = 'e9000000-0000-4000-8000-000000000001'
$$;

SELECT throws_ok($$
  SELECT reschedule_reservation('e9000000-0000-4000-8000-000000000001',
                                pg_temp.at_in(INTERVAL '5 days'))
$$, 'full_slot', 'перенос на занятое время отклонён');

SELECT ok(
  pg_temp.kept_time() = pg_temp.time_of('e9000000-0000-4000-8000-000000000001')
  AND pg_temp.status_of('e9000000-0000-4000-8000-000000000001') = 'confirmed',
  'неудачный перенос НЕ отнял у гостя уже имеющуюся бронь');

-- Обычный режим: перенос возвращает бронь на подтверждение заведению.
UPDATE locations SET settings = pg_temp.settings()
WHERE id = 'e1000000-0000-4000-8000-000000000001';

SELECT lives_ok($$
  SELECT reschedule_reservation('e9000000-0000-4000-8000-000000000001',
                                pg_temp.at_in(INTERVAL '6 days'))
$$, 'обычный режим: перенос принимается');
SELECT is(pg_temp.status_of('e9000000-0000-4000-8000-000000000001'), 'new',
  'обычный режим: перенесённая бронь ждёт повторного подтверждения');

-- Лимит переносов: третий исчерпывает, четвёртый отклоняется.
SELECT lives_ok($$
  SELECT reschedule_reservation('e9000000-0000-4000-8000-000000000001',
                                pg_temp.at_in(INTERVAL '7 days'))
$$, 'третий перенос ещё проходит');
SELECT throws_ok($$
  SELECT reschedule_reservation('e9000000-0000-4000-8000-000000000001',
                                pg_temp.at_in(INTERVAL '8 days'))
$$, 'reschedule_limit', 'четвёртый перенос отклонён — бронь не ходит по сетке бесконечно');

-- Посаженную на кассе бронь веб не трогает (правило 102).
SELECT lives_ok($$ SELECT pg_temp.book(
  'e9000000-0000-4000-8000-000000000005', pg_temp.at_in(INTERVAL '9 days'), 'confirmed', NULL) $$,
  'фикстура: бронь под посадку');
UPDATE reservations SET order_id = NULL WHERE client_uuid = 'e9000000-0000-4000-8000-000000000005';

SELECT is(
  (reservation_public_view('e9000000-0000-4000-8000-000000000005')::jsonb ->> 'can_reschedule')::TEXT,
  'true',
  'непосаженную бронь переносить можно');

SELECT * FROM finish();
ROLLBACK;
