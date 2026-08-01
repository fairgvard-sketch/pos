-- pgTAP: очередь уведомлений без провайдера и лист ожидания (122).
--
-- Главное, что здесь доказывается:
--   * очередь НЕ имитирует отправку — без провайдера запись честно
--     помечается skipped/no_provider, и заведение не думает, что гостя
--     предупредили;
--   * повторное событие не создаёт второго сообщения;
--   * предложение из листа ожидания не даёт прав на стол: слот
--     перепроверяется в момент согласия, истёкшее не действует.

BEGIN;
SELECT plan(28);

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'pgTAP waitlist');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'WL loc', 'Asia/Jerusalem');

INSERT INTO organization_products (org_id, product) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'reservations');

INSERT INTO table_zones (id, org_id, location_id, name) VALUES
  ('b4000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'Зал');

-- Один стол на двоих: он и создаёт дефицит, ради которого нужен лист.
INSERT INTO tables (id, org_id, location_id, label, zone_id, seats, sort_order) VALUES
  ('b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', '1', 'b4000000-0000-4000-8000-000000000001', 2, 1);

UPDATE locations SET settings = jsonb_build_object('reservations',
  jsonb_build_object('enabled', TRUE, 'instant', TRUE, 'waitlist', TRUE,
    -- Окно просьб подтвердить — 48 часов, а не продуктовые 24: бронь
    -- фикстуры стоит на ЗАВТРА 19:00, то есть от 19 до 44 часов вперёд
    -- в зависимости от часа прогона. С 24 часами тест проходил только
    -- вечером, а утром request_reservation_confirmations честно
    -- возвращал 0 — падал тест, а не код.
    'duration_min', 90, 'buffer_min', 0, 'confirm_window_h', 48,
    'schedule', jsonb_build_object(
      'weekly', (SELECT jsonb_object_agg(i::TEXT, '[["00:00","23:59"]]'::jsonb)
                 FROM generate_series(0, 6) i),
      'exceptions', '{}'::jsonb, 'lead_min', 30, 'horizon_days', 365)))
WHERE id = 'b1000000-0000-4000-8000-000000000001';

CREATE FUNCTION pg_temp.as_org() RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    json_build_object('app_metadata', json_build_object(
      'org_id', 'b0000000-0000-4000-8000-000000000001',
      'location_id', 'b1000000-0000-4000-8000-000000000001'))::text, TRUE)
$$;
SELECT pg_temp.as_org();

-- Завтра в 19:00 по времени точки — момент, вокруг которого всё крутится.
CREATE FUNCTION pg_temp.slot() RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT ((NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE + 1 + TIME '19:00')
         AT TIME ZONE 'Asia/Jerusalem'
$$;
CREATE FUNCTION pg_temp.slot_date() RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE + 1
$$;

-- ── 1. Провайдера нет — отправка не имитируется ──────────────
SELECT ok(NOT notification_provider_ready('email'),
  'адаптер доставки выключен: провайдера в проекте нет');

SELECT lives_ok($$
  SELECT submit_reservation(
    'b1000000-0000-4000-8000-000000000001',
    'b9000000-0000-4000-8000-000000000001',
    'Первый', '0501111111', 2, pg_temp.slot())
$$, 'бронь занимает единственный стол');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM notification_outbox WHERE kind = 'reservation_confirmed'),
  1, 'подтверждение брони поставило событие в очередь');

SELECT is(
  (SELECT status FROM notification_outbox WHERE kind = 'reservation_confirmed' LIMIT 1),
  'skipped', 'без провайдера статус skipped, а не sent — отправку не выдумываем');

SELECT is(
  (SELECT last_error FROM notification_outbox WHERE kind = 'reservation_confirmed' LIMIT 1),
  'no_provider', 'причина названа явно');

-- Идемпотентность: тот же ключ не создаёт второго сообщения.
SELECT is(
  enqueue_notification('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001', 'reservation_reminder',
    '0501111111', '{}'::jsonb, 'dupe-key-1'),
  enqueue_notification('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001', 'reservation_reminder',
    '0501111111', '{}'::jsonb, 'dupe-key-1'),
  'повторная постановка того же события возвращает ту же запись');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM notification_outbox WHERE dedupe_key = 'dupe-key-1'),
  1, 'дубля сообщения не появилось');

-- ── 2. Просьба подтвердить приход ────────────────────────────
SELECT is(request_reservation_confirmations('b1000000-0000-4000-8000-000000000001'), 1,
  'бронь внутри окна получила просьбу подтвердить');
SELECT is(request_reservation_confirmations('b1000000-0000-4000-8000-000000000001'), 0,
  'повторный вызов ничего не дублирует');

SELECT isnt(
  (SELECT confirm_requested_at FROM reservations
   WHERE client_uuid = 'b9000000-0000-4000-8000-000000000001'), NULL,
  'на брони отмечено, что просьба отправлена — хостес это видит');

SELECT lives_ok($$
  SELECT confirm_reservation_attendance(
    (SELECT public_token FROM reservations
     WHERE client_uuid = 'b9000000-0000-4000-8000-000000000001'))
$$, 'гость подтверждает приход по своей ссылке');

SELECT isnt(
  (SELECT guest_confirmed_at FROM reservations
   WHERE client_uuid = 'b9000000-0000-4000-8000-000000000001'), NULL,
  'подтверждение гостя записано');

-- ── 3. Лист ожидания ─────────────────────────────────────────
-- Слот занят: свободных столов на 19:00 нет, гостю остаётся лист.
SELECT throws_ok($$
  SELECT submit_reservation(
    'b1000000-0000-4000-8000-000000000001',
    'b9000000-0000-4000-8000-000000000002',
    'Второй', '0502222222', 2, pg_temp.slot())
$$, 'full_slot', 'второму гостю мест нет — это и есть повод для листа');

SELECT lives_ok($$
  SELECT submit_waitlist(
    'b1000000-0000-4000-8000-000000000001',
    'b9000000-0000-4000-8000-000000000003',
    'Второй', '0502222222', 2, pg_temp.slot_date(),
    TIME '18:00', TIME '21:00')
$$, 'гость встаёт в лист ожидания из публичного потока');

SELECT is(
  (SELECT status FROM waitlist_entries WHERE client_uuid = 'b9000000-0000-4000-8000-000000000003'),
  'waiting', 'запись в очереди');

SELECT isnt(
  (SELECT guest_id FROM waitlist_entries WHERE client_uuid = 'b9000000-0000-4000-8000-000000000003'),
  NULL, 'лист ожидания тоже заводит профиль гостя (121)');

-- Повторная отправка того же client_uuid идемпотентна.
SELECT is(
  (submit_waitlist('b1000000-0000-4000-8000-000000000001',
     'b9000000-0000-4000-8000-000000000003', 'Второй', '0502222222', 2,
     pg_temp.slot_date(), TIME '18:00', TIME '21:00')::jsonb ->> 'duplicate'),
  'true', 'повтор заявки не создаёт вторую запись');

-- Пока стол занят, предлагать некого.
SELECT is(jsonb_array_length(
  waitlist_matches('b1000000-0000-4000-8000-000000000001', pg_temp.slot())), 0,
  'занятый слот подходящих не показывает — пустых обещаний нет');

-- Первый гость отменяется — стол освободился.
UPDATE reservations SET status = 'cancelled'
WHERE client_uuid = 'b9000000-0000-4000-8000-000000000001';

SELECT is(jsonb_array_length(
  waitlist_matches('b1000000-0000-4000-8000-000000000001', pg_temp.slot())), 1,
  'освободившийся слот показывает ожидающего гостя');

-- Вне заявленного диапазона гость не предлагается.
SELECT is(jsonb_array_length(waitlist_matches(
  'b1000000-0000-4000-8000-000000000001',
  ((NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE + 1 + TIME '10:00')
    AT TIME ZONE 'Asia/Jerusalem')), 0,
  'время вне диапазона гостя не предлагается');

-- ── 4. Предложение и согласие ────────────────────────────────
CREATE FUNCTION pg_temp.wl() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT id FROM waitlist_entries WHERE client_uuid = 'b9000000-0000-4000-8000-000000000003'
$$;

SELECT lives_ok($$
  SELECT offer_waitlist_slot(pg_temp.wl(), pg_temp.slot(), 30)
$$, 'хостес отправляет предложение на освободившееся время');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM notification_outbox WHERE kind = 'waitlist_offer'),
  1, 'предложение тоже прошло через очередь уведомлений');

-- Предложение НЕ держит стол: пока гость думает, слот доступен другим.
SELECT ok(
  _table_free('b2000000-0000-4000-8000-000000000001', pg_temp.slot(), 90, 0, NULL),
  'предложение не занимает стол — это приглашение, а не бронь');

SELECT lives_ok($$
  SELECT accept_waitlist_offer(
    (SELECT offer_token FROM waitlist_entries WHERE id = pg_temp.wl()))
$$, 'согласие гостя превращает предложение в бронь');

SELECT is(
  (SELECT status FROM waitlist_entries WHERE id = pg_temp.wl()),
  'converted', 'запись листа закрыта как converted');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservations
   WHERE customer_phone = '0502222222' AND status = 'confirmed'),
  1, 'бронь создана и подтверждена');

-- ── 5. Истёкшее предложение не действует ─────────────────────
SELECT lives_ok($$
  SELECT submit_waitlist(
    'b1000000-0000-4000-8000-000000000001',
    'b9000000-0000-4000-8000-000000000004',
    'Третий', '0503333333', 2, pg_temp.slot_date(),
    TIME '18:00', TIME '21:00')
$$, 'фикстура: ещё один ожидающий');

UPDATE waitlist_entries
SET status = 'offered', offer_token = 'b8000000-0000-4000-8000-000000000001',
    offer_at = pg_temp.slot(), offer_expires = NOW() - INTERVAL '1 minute'
WHERE client_uuid = 'b9000000-0000-4000-8000-000000000004';

SELECT throws_ok(
  $$ SELECT accept_waitlist_offer('b8000000-0000-4000-8000-000000000001') $$,
  'offer_expired', 'истёкшее предложение брони не даёт');

SELECT * FROM finish();
ROLLBACK;
