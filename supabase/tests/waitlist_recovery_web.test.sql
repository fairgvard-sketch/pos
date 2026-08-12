-- pgTAP: подбор из листа ожидания на освободившийся слот (153).
--
-- Проверяется то, ради чего петля и достраивалась: освободившийся стол
-- обязан находить ждущего гостя, но только того, кого действительно
-- есть куда посадить — и только тому, у кого есть право кабинета.

BEGIN;
SELECT plan(14);

INSERT INTO orgs (id, name) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'pgTAP waitlist recovery');
INSERT INTO locations (id, org_id, name, timezone, settings) VALUES
  ('f1000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', 'Recovery loc', 'Asia/Jerusalem',
   '{"reservations":{"duration_min":90,"buffer_min":0,"waitlist":true}}'::jsonb);
INSERT INTO organization_products (org_id, product) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'reservations');
INSERT INTO auth.users (id) VALUES ('f4000000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('f5000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001',
   'owner', TRUE);
INSERT INTO table_zones (id, org_id, location_id, name, sort_order, is_active) VALUES
  ('f6000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', 'Терраса', 0, TRUE);
-- Один стол на двоих: он и есть то место, которое освобождается
INSERT INTO tables (id, org_id, location_id, label, seats, sort_order, zone_id) VALUES
  ('f2000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', '1', 2, 0,
   'f6000000-0000-4000-8000-000000000001');

-- Очередь заводится ДО смены роли: прямая запись в waitlist_entries
-- закрыта для `authenticated` (писать можно только через RPC), а тесту
-- нужны конкретные окна времени, которых `add_waitlist_entry_web` не
-- принимает.
-- Ждущий на двоих в окне 18:00–21:00 сегодня по времени точки
INSERT INTO waitlist_entries (
  id, org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, wanted_date, time_from, time_to, zone_ids, quoted_min, status
) VALUES (
  'f7000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  gen_random_uuid(), 'Ждущая пара', '0521111111', 2,
  (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE,
  '18:00', '21:00', ARRAY['f6000000-0000-4000-8000-000000000001']::UUID[], 20, 'waiting'
),
-- Компания на шестерых: посадить её некуда, и в подборе её быть не должно
(
  'f7000000-0000-4000-8000-000000000002',
  'f0000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  gen_random_uuid(), 'Большая компания', '0522222222', 6,
  (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE,
  '18:00', '21:00', '{}'::UUID[], NULL, 'waiting'
),
-- Ждущий на другое окно: 12:00–13:00, вечерний слот ему не подходит
(
  'f7000000-0000-4000-8000-000000000003',
  'f0000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  gen_random_uuid(), 'Обеденный гость', '0523333333', 2,
  (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE,
  '12:00', '13:00', '{}'::UUID[], NULL, 'waiting'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"f0000000-0000-4000-8000-000000000001"}}',
  true
);

-- Момент 19:00 сегодня в зоне точки
CREATE TEMP TABLE slot AS
SELECT (((NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE + TIME '19:00')
        AT TIME ZONE 'Asia/Jerusalem') AS at;

-- ── 1. Подбор находит того, кого есть куда посадить ──────────
SELECT is(
  (SELECT jsonb_array_length(waitlist_matches_web(
     'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot)))),
  1, 'на освободившийся слот найден ровно один подходящий гость');

SELECT is(
  (SELECT waitlist_matches_web(
     'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot)) -> 0 ->> 'customer_name'),
  'Ждущая пара', 'найден именно тот, кто помещается и ждёт это время');

-- ── 2. Кого посадить некуда — не показываем ──────────────────
SELECT ok(
  (SELECT NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(waitlist_matches_web(
       'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot))) m
     WHERE m ->> 'customer_name' = 'Большая компания')),
  'компанию, которую некуда посадить, подбор не предлагает');

SELECT ok(
  (SELECT NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(waitlist_matches_web(
       'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot))) m
     WHERE m ->> 'customer_name' = 'Обеденный гость')),
  'гость, ждущий другое окно, в вечерний слот не попадает');

-- ── 3. Видно, ПОЧЕМУ кандидат подходит ───────────────────────
SELECT is(
  (SELECT (waitlist_matches_web(
     'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot)) -> 0 ->> 'party_size')::INTEGER),
  2, 'размер компании назван');

SELECT is(
  (SELECT waitlist_matches_web(
     'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot)) -> 0 ->> 'time_from'),
  '18:00:00', 'приемлемое окно названо — по нему хостес решает, кому звонить');

SELECT is(
  (SELECT waitlist_matches_web(
     'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot)) -> 0 ->> 'time_to'),
  '21:00:00', 'конец окна тоже назван');

SELECT is(
  (SELECT (waitlist_matches_web(
     'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot)) -> 0 ->> 'quoted_min')::INTEGER),
  20, 'обещанное ожидание видно: спор через полчаса опирается на запись');

SELECT is(
  (SELECT waitlist_matches_web(
     'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot)) -> 0 -> 'zone_names' ->> 0),
  'Терраса', 'зона названа словом, а не списком uuid');

-- ── 4. Занятый стол снимает кандидата ────────────────────────
SELECT create_reservation_web(
  'f1000000-0000-4000-8000-000000000001', 'Занял стол', '0529999999', 2,
  (SELECT at FROM slot));

SELECT is(
  (SELECT jsonb_array_length(waitlist_matches_web(
     'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot)))),
  0, 'пока стол занят, звать некого — подбор честно пуст');

-- ── 5. Освобождение возвращает кандидата ─────────────────────
SELECT set_reservation_status_web(
  'f1000000-0000-4000-8000-000000000001',
  (SELECT id FROM reservations WHERE customer_name = 'Занял стол'),
  'cancelled');

SELECT is(
  (SELECT jsonb_array_length(waitlist_matches_web(
     'f1000000-0000-4000-8000-000000000001', (SELECT at FROM slot)))),
  1, 'отменённая бронь освобождает слот и возвращает ждущего в подбор');

-- ── 6. Предложение стол НЕ держит (правило 122) ──────────────
SELECT offer_waitlist_slot('f7000000-0000-4000-8000-000000000001', (SELECT at FROM slot), 30);

SELECT is(
  (SELECT status FROM waitlist_entries WHERE id = 'f7000000-0000-4000-8000-000000000001'),
  'offered', 'предложение отправлено');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservations
   WHERE location_id = 'f1000000-0000-4000-8000-000000000001'
     AND status IN ('new', 'confirmed')),
  0, 'предложение не создало брони — стол свободен до согласия гостя');

-- ── 7. Право кабинета обязательно ────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f4000000-0000-4000-8000-000000000009","role":"authenticated","app_metadata":{"org_id":"f0000000-0000-4000-8000-000000000001","location_id":"f1000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$SELECT waitlist_matches_web(
      'f1000000-0000-4000-8000-000000000001', NOW() + INTERVAL '2 hours')$$,
  'backoffice access denied',
  'без членства в кабинете подбор закрыт');

SELECT * FROM finish();
ROLLBACK;
