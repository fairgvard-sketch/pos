-- pgTAP: ресторанная карточка клиента (156) и узнавание гостя (157).
--
-- Проверяется то, ради чего это сделано: карточка обязана быть полезной
-- у точки БЕЗ кассы, узнавание — работать только по полному номеру и не
-- превращать форму брони в перебор клиентской базы.

BEGIN;
SELECT plan(24);

INSERT INTO orgs (id, name) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'pgTAP profile');
INSERT INTO locations (id, org_id, name, timezone, settings) VALUES
  ('d1100000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'Profile loc', 'Asia/Jerusalem',
   '{"reservations":{"duration_min":90}}'::jsonb);
INSERT INTO organization_products (org_id, product) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'reservations');
INSERT INTO auth.users (id) VALUES ('d1400000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('d1500000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000001',
   'owner', TRUE);
INSERT INTO table_zones (id, org_id, location_id, name, sort_order, is_active) VALUES
  ('d1600000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001',
   'd1100000-0000-4000-8000-000000000001', 'Терраса', 0, TRUE);

INSERT INTO guests (id, org_id, phone, name, notes) VALUES
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
   '0521111111', 'Мири Леви', 'Аллергия на орехи — предупредить кухню'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001',
   '0522222222', 'Слитый', NULL),
  ('d2000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001',
   '0523333333', 'Стёртый', NULL);

-- Три состоявшихся визита по пятницам в 19:00 (время точки) на четверых
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id, zone_id
)
SELECT 'd1000000-0000-4000-8000-000000000001',
       'd1100000-0000-4000-8000-000000000001',
       gen_random_uuid(), 'Мири Леви', '0521111111', 4,
       -- Пятница 19:00 в Иерусалиме, три недели подряд в прошлом
       (('2026-07-03'::DATE - (7 * i)) + TIME '19:00') AT TIME ZONE 'Asia/Jerusalem',
       'completed', 'd2000000-0000-4000-8000-000000000001',
       'd1600000-0000-4000-8000-000000000001'
FROM generate_series(0, 2) AS i;

-- И одна будущая бронь
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id
) VALUES (
  'd1000000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001',
  gen_random_uuid(), 'Мири Леви', '0521111111', 4,
  NOW() + INTERVAL '3 days', 'confirmed', 'd2000000-0000-4000-8000-000000000001');

-- Слитый профиль указывает на Мири
UPDATE guests SET merged_into = 'd2000000-0000-4000-8000-000000000001', merged_at = NOW()
WHERE id = 'd2000000-0000-4000-8000-000000000002';

-- Стёртый профиль
UPDATE guests SET anonymized_at = NOW(), name = NULL
WHERE id = 'd2000000-0000-4000-8000-000000000003';

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d1400000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"d1000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Карточка клиента (156) ───────────────────────────────────
SELECT isnt(
  (SELECT get_guest_card('d2000000-0000-4000-8000-000000000001') -> 'next_visit'),
  'null'::jsonb, 'следующая бронь — первое, что спрашивает хостес');

SELECT is(
  (SELECT (get_guest_card('d2000000-0000-4000-8000-000000000001')
           -> 'next_visit' ->> 'party_size')::INTEGER),
  4, 'в следующей броне названо число гостей');

SELECT is(
  (SELECT get_guest_card('d2000000-0000-4000-8000-000000000001')
          -> 'next_visit' ->> 'location_name'),
  'Profile loc', 'и точка — сеть без имени точки бесполезна');

SELECT is(
  (SELECT (get_guest_card('d2000000-0000-4000-8000-000000000001')
           -> 'usual' ->> 'hour')::INTEGER),
  19, 'привычный час считается в часах ТОЧКИ, а не в UTC');

SELECT is(
  (SELECT (get_guest_card('d2000000-0000-4000-8000-000000000001')
           -> 'usual' ->> 'dow')::INTEGER),
  5, 'привычный день недели — пятница, а не сдвинутый четверг');

SELECT is(
  (SELECT (get_guest_card('d2000000-0000-4000-8000-000000000001')
           -> 'usual' ->> 'party')::NUMERIC),
  4.0, 'привычный размер компании назван');

SELECT is(
  (SELECT jsonb_array_length(get_guest_card('d2000000-0000-4000-8000-000000000001')
                             -> 'visit_history')),
  4, 'визиты списком — «три раза» должно быть проверяемо глазами');

SELECT is(
  (SELECT get_guest_card('d2000000-0000-4000-8000-000000000001')
          -> 'visit_history' -> 0 ->> 'zone_name'),
  NULL, 'у будущей брони без зоны зона не выдумывается');

SELECT ok(
  (SELECT get_guest_card('d2000000-0000-4000-8000-000000000001')
          -> 'segments' @> '["regular"]'::jsonb
      OR get_guest_card('d2000000-0000-4000-8000-000000000001')
          -> 'segments' @> '["returning"]'::jsonb),
  'сегмент в карточке тот же, что в списке — считает одна функция');

SELECT is(
  (SELECT (get_guest_card('d2000000-0000-4000-8000-000000000001')
           -> 'why_segment' ->> 'from_bookings')::INTEGER),
  3, 'доказательство метки приехало вместе с ней');

-- Точка без кассы: денежная часть пуста, ресторанная полна
SELECT is(
  (SELECT jsonb_array_length(get_guest_card('d2000000-0000-4000-8000-000000000001')
                             -> 'orders')),
  0, 'заказов нет — кассы у точки нет');

SELECT is(
  (SELECT (get_guest_card('d2000000-0000-4000-8000-000000000001')
           -> 'why_segment' ->> 'spend')::INTEGER),
  0, 'трат нет, и это «не измеряли», а не выдумка');

-- ── Узнавание гостя (157) ────────────────────────────────────
SELECT isnt(
  (SELECT lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '0521111111')),
  NULL, 'полный номер узнаёт гостя');

SELECT is(
  (SELECT lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '0521111111') ->> 'guest_id'),
  'd2000000-0000-4000-8000-000000000001',
  'узнавание отдаёт канонический профиль — дубля не заводится');

SELECT is(
  (SELECT (lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '0521111111') ->> 'visits')::INTEGER),
  3, 'хостес видит, сколько раз человек был');

SELECT is(
  (SELECT (lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '0521111111') ->> 'usual_party')::NUMERIC),
  4.0, 'обычная компания подставляется, а не переспрашивается');

SELECT is(
  (SELECT lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '0521111111') ->> 'usual_zone'),
  'Терраса', 'привычная зона названа');

SELECT is(
  (SELECT lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '0521111111') ->> 'note'),
  'Аллергия на орехи — предупредить кухню',
  'одна внутренняя заметка — то, что смене надо знать сейчас');

-- Форматирование номера не мешает узнаванию
SELECT is(
  (SELECT lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '052-111-1111') ->> 'guest_id'),
  'd2000000-0000-4000-8000-000000000001',
  'разделители в номере не мешают: нормализует сервер');

-- ── Перебором базу не достать ────────────────────────────────
SELECT is(
  (SELECT lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '052')),
  NULL, 'короткий ввод не отдаёт ничего — иначе это перебор базы');

SELECT is(
  (SELECT lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '05211111')),
  NULL, 'префикс полного номера тоже не отдаёт ничего');

-- ── Слияние и стирание уважаются ─────────────────────────────
SELECT is(
  (SELECT lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '0522222222') ->> 'guest_id'),
  'd2000000-0000-4000-8000-000000000001',
  'старый номер слитого профиля ведёт к оставшемуся');

SELECT is(
  (SELECT lookup_guest_by_phone_web(
     'd1100000-0000-4000-8000-000000000001', '0523333333')),
  NULL, 'стёртый по просьбе клиента профиль не «узнаётся»');

-- ── Право кабинета обязательно ───────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d1400000-0000-4000-8000-000000000009","role":"authenticated","app_metadata":{"org_id":"d1000000-0000-4000-8000-000000000001","location_id":"d1100000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$SELECT lookup_guest_by_phone_web(
      'd1100000-0000-4000-8000-000000000001', '0521111111')$$,
  'backoffice access denied',
  'без права кабинета узнавание закрыто');

SELECT * FROM finish();
ROLLBACK;
