-- pgTAP: отчёт по броням для кабинета (125).
--
-- Проверяется то, на чём отчёт легче всего соврать: две оси времени не
-- перепутаны, воронка считается сессиями, загрузка берёт знаменателем
-- расписание, а чужая точка не показывается ни при каком наборе
-- параметров.

BEGIN;
SELECT plan(18);

-- ── Фикстура ─────────────────────────────────────────────────
-- A — точка с Reserve: сутки открыты, два стола по 2 места.
-- B — чужая организация, её данные не должны попасть в отчёт A.
INSERT INTO orgs (id, name) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'pgTAP report A'),
  ('e0000000-0000-4000-8000-000000000002', 'pgTAP report B');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('e1000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001', 'Report loc A', 'Asia/Jerusalem'),
  ('e1000000-0000-4000-8000-000000000002',
   'e0000000-0000-4000-8000-000000000002', 'Report loc B', 'Asia/Jerusalem');

INSERT INTO organization_products (org_id, product) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'reservations'),
  ('e0000000-0000-4000-8000-000000000002', 'reservations');

-- Окно 10:00–22:00 каждый день = 12 часов приёма.
UPDATE locations SET settings = jsonb_build_object('reservations',
  jsonb_build_object('enabled', TRUE, 'schedule', jsonb_build_object(
    'weekly', (SELECT jsonb_object_agg(i::TEXT, '[["10:00","22:00"]]'::jsonb)
               FROM generate_series(0, 6) i),
    'exceptions', '{}'::jsonb)))
WHERE id IN ('e1000000-0000-4000-8000-000000000001',
             'e1000000-0000-4000-8000-000000000002');

INSERT INTO tables (id, org_id, location_id, label, seats, sort_order) VALUES
  ('e2000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', 'A1', 2, 0),
  ('e2000000-0000-4000-8000-000000000002',
   'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', 'A2', 2, 1);

INSERT INTO auth.users (id) VALUES
  ('e4000000-0000-4000-8000-000000000001'),
  ('e4000000-0000-4000-8000-000000000002');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('e5000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'owner', TRUE),
  ('e5000000-0000-4000-8000-000000000002',
   'e0000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-000000000002', 'owner', TRUE);

-- ── Часы работы дня ──────────────────────────────────────────
SELECT is(
  reservation_open_minutes(
    reservation_schedule((SELECT settings FROM locations
                          WHERE id = 'e1000000-0000-4000-8000-000000000001')),
    CURRENT_DATE),
  720, 'окно 10:00–22:00 = 720 минут приёма');
SELECT is(
  reservation_open_minutes('{"weekly":{}}'::jsonb, CURRENT_DATE),
  0, 'неописанный день закрыт, а не круглосуточен');
SELECT is(
  reservation_open_minutes(
    jsonb_build_object('weekly', (SELECT jsonb_object_agg(i::TEXT, '[["20:00","02:00"]]'::jsonb)
                                  FROM generate_series(0, 6) i)),
    CURRENT_DATE),
  360, 'окно через полночь считается как шесть часов, а не отрицательное');

-- ── Данные периода ───────────────────────────────────────────
-- Визит СЕГОДНЯ, оформленный сегодня: 2 гостя на 90 минут.
INSERT INTO reservations (id, org_id, location_id, client_uuid, customer_name,
                          customer_phone, party_size, reserved_at, duration_min,
                          status, auto, source, created_at, table_id)
VALUES
  ('e6000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e7000000-0000-4000-8000-000000000001', 'Пришёл', '0501111111', 2,
   (CURRENT_DATE + TIME '19:00') AT TIME ZONE 'Asia/Jerusalem', 90,
   'confirmed', TRUE, 'qr', NOW(), 'e2000000-0000-4000-8000-000000000001'),
  -- Неявка сегодня же: попадает в визиты и в no_show_rate.
  ('e6000000-0000-4000-8000-000000000002',
   'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e7000000-0000-4000-8000-000000000002', 'Не пришёл', '0502222222', 4,
   (CURRENT_DATE + TIME '20:00') AT TIME ZONE 'Asia/Jerusalem', 90,
   'no_show', FALSE, 'instagram', NOW(), 'e2000000-0000-4000-8000-000000000002'),
  -- Бронь ДО 124: канала нет вовсе.
  ('e6000000-0000-4000-8000-000000000003',
   'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e7000000-0000-4000-8000-000000000003', 'Старая', '0503333333', 2,
   (CURRENT_DATE + TIME '13:00') AT TIME ZONE 'Asia/Jerusalem', 90,
   'confirmed', TRUE, NULL, NOW(), NULL);

-- Чужая организация: тот же день, те же метрики — не должна просочиться.
INSERT INTO reservations (id, org_id, location_id, client_uuid, customer_name,
                          customer_phone, party_size, reserved_at, status)
VALUES ('e6000000-0000-4000-8000-000000000009',
        'e0000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002',
        'e7000000-0000-4000-8000-000000000009', 'Чужой', '0509999999', 8,
        (CURRENT_DATE + TIME '19:00') AT TIME ZONE 'Asia/Jerusalem', 'confirmed');

-- Воронка: одна сессия прошла до конца, вторая упёрлась в отсутствие мест
-- на две разные даты — это ДВЕ строки спроса, но ОДНА сессия.
SELECT track_reserve_event('e1000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000001', 'page_view', 'qr');
SELECT track_reserve_event('e1000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000001', 'form_started', 'qr');
SELECT track_reserve_event('e1000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000001', 'submitted', 'qr', '{}'::jsonb,
  2, CURRENT_DATE, TIME '19:00', NULL, 'e6000000-0000-4000-8000-000000000001');
SELECT track_reserve_event('e1000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002', 'page_view', 'instagram');
SELECT track_reserve_event('e1000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002', 'no_slots', 'instagram', '{}'::jsonb,
  6, CURRENT_DATE + 1);
SELECT track_reserve_event('e1000000-0000-4000-8000-000000000001',
  'e8000000-0000-4000-8000-000000000002', 'no_slots', 'instagram', '{}'::jsonb,
  6, CURRENT_DATE + 2);

INSERT INTO waitlist_entries (org_id, location_id, client_uuid, customer_name,
                              customer_phone, party_size, wanted_date,
                              time_from, time_to, status)
VALUES
  ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e9000000-0000-4000-8000-000000000001', 'Ждёт', '0504444444', 2,
   CURRENT_DATE + 1, TIME '18:00', TIME '21:00', 'waiting'),
  ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e9000000-0000-4000-8000-000000000002', 'Дождался', '0505555555', 2,
   CURRENT_DATE + 1, TIME '18:00', TIME '21:00', 'converted');

-- ── Отчёт под владельцем A ───────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"e4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"e0000000-0000-4000-8000-000000000001"}}',
  true
);

CREATE FUNCTION pg_temp.report() RETURNS JSON LANGUAGE sql STABLE AS $$
  SELECT reserve_analytics_web(NULL, CURRENT_DATE, CURRENT_DATE)
$$;

SELECT is((pg_temp.report() -> 'visits' ->> 'total')::INT, 3,
  'визиты периода — только свои три');
SELECT is((pg_temp.report() -> 'visits' ->> 'no_show')::INT, 1,
  'неявка посчитана');
SELECT is((pg_temp.report() -> 'visits' ->> 'guests')::INT, 4,
  'гости считаются по состоявшимся визитам, неявка в них не входит');
SELECT is((pg_temp.report() -> 'bookings' ->> 'instant')::INT, 2,
  'режим подтверждения различает мгновенные и ручные брони');

-- Загрузка: 2 стола × 2 места × 12 часов = 48 посадко-часов зала;
-- занято (2 + 2 гостя) × 1.5 часа = 6.
SELECT is((pg_temp.report() -> 'occupancy' ->> 'seat_hours_available')::NUMERIC, 48.0,
  'знаменатель загрузки — места × часы работы по расписанию');
SELECT is((pg_temp.report() -> 'occupancy' ->> 'seat_hours_booked')::NUMERIC, 6.0,
  'числитель — гости в зале, а не занятые столы');
SELECT is((pg_temp.report() -> 'occupancy' ->> 'pct')::NUMERIC, 12.5,
  'загрузка в процентах');

-- Воронка: сессиями, а не строками.
SELECT is((pg_temp.report() -> 'funnel' ->> 'page_view')::INT, 2,
  'вершина воронки — две сессии');
SELECT is((pg_temp.report() -> 'funnel' ->> 'submitted')::INT, 1,
  'до заявки дошла одна');
SELECT is((pg_temp.report() -> 'funnel' ->> 'conversion')::NUMERIC, 50.0,
  'конверсия страницы в заявку');
SELECT is((pg_temp.report() -> 'funnel' ->> 'dead_ends')::INT, 1,
  'сессия, упёршаяся в отсутствие мест на две даты, считается ОДИН раз');
SELECT is(
  json_array_length(pg_temp.report() -> 'unmet'), 2,
  'но в спросе она даёт две строки — по одной на дату');

SELECT is((pg_temp.report() -> 'waitlist' ->> 'conversion')::NUMERIC, 50.0,
  'конверсия листа ожидания');

SELECT is(
  (SELECT COUNT(*)::INT FROM json_array_elements(pg_temp.report() -> 'by_source') s
   WHERE s ->> 'source' = 'unknown'),
  1,
  'бронь без канала попадает в unknown, а не в direct');

-- ── Чужая точка недостижима ──────────────────────────────────
SELECT is(
  (SELECT json_array_length(
     reserve_analytics_web(ARRAY['e1000000-0000-4000-8000-000000000002']::UUID[],
                           CURRENT_DATE, CURRENT_DATE) -> 'range' -> 'locations')),
  0,
  'явно запрошенная чужая точка просто не попадает в отчёт');

SELECT * FROM finish();
ROLLBACK;
