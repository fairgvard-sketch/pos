-- pgTAP: ручная бронь, walk-in и правка визита из кабинета (127).
--
-- Проверяется то, ради чего это сделано: хостес заводит гостя без кассы,
-- а доступность считает СЕРВЕР — перенос на занятое время и посадка
-- поверх чужого визита должны падать, а не создавать двойную посадку.

BEGIN;
SELECT plan(20);

INSERT INTO orgs (id, name) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'pgTAP host desk');
INSERT INTO locations (id, org_id, name, timezone, settings) VALUES
  ('c1000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001', 'Desk loc', 'Asia/Jerusalem',
   '{"reservations":{"duration_min":90,"buffer_min":0}}'::jsonb);
INSERT INTO organization_products (org_id, product) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'reservations');
INSERT INTO auth.users (id) VALUES ('c4000000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('c5000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001',
   'owner', TRUE);
INSERT INTO tables (id, org_id, location_id, label, seats, sort_order) VALUES
  ('c2000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001', '1', 2, 0),
  ('c2000000-0000-4000-8000-000000000002',
   'c0000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001', '2', 6, 1);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"c4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"c0000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Ручная бронь ─────────────────────────────────────────────
SELECT lives_ok(
  $$SELECT create_reservation_web(
      'c1000000-0000-4000-8000-000000000001', 'Дана', '0521234567', 2,
      NOW() + INTERVAL '3 hours')$$,
  'телефонная бронь заводится из кабинета');

SELECT is(
  (SELECT count(*)::INTEGER FROM reservations
   WHERE location_id = 'c1000000-0000-4000-8000-000000000001'),
  1, 'визит записан');

SELECT is(
  (SELECT status FROM reservations LIMIT 1),
  'confirmed', 'ручная бронь сразу подтверждена — хостес уже согласовал её с гостем');

/*
 * До 136 эта проверка требовала source='backoffice'. Так и было — и
 * это была ошибка: `source` хранит КАНАЛ ПРИВОДА гостя (124), рядом с
 * instagram и qr, а «backoffice» каналом не является. Путь переехал в
 * `created_via` (136), а канал у телефонного звонка честно пустой.
 */
SELECT is(
  (SELECT created_via FROM reservations LIMIT 1),
  'backoffice', 'путь отделяет ручные визиты от гостевых');

SELECT is(
  (SELECT source FROM reservations LIMIT 1),
  NULL, 'канал привода не засоряется словом «backoffice»');

SELECT isnt(
  (SELECT table_id FROM reservations LIMIT 1),
  NULL, 'стол подобран сервером');

SELECT is(
  (SELECT auto FROM reservations LIMIT 1),
  FALSE, 'ручная бронь не считается автоподтверждённой');

SELECT throws_ok(
  $$SELECT create_reservation_web(
      'c1000000-0000-4000-8000-000000000001', '  ', '0500000000', 2)$$,
  'name_required',
  'бронь без имени не заводится');

-- ── Walk-in ──────────────────────────────────────────────────
SELECT lives_ok(
  $$SELECT create_reservation_web(
      'c1000000-0000-4000-8000-000000000001', 'Гость с улицы', '', 4,
      NULL, NULL, NULL, TRUE)$$,
  'walk-in заводится без времени и телефона');

SELECT isnt(
  (SELECT arrived_at FROM reservations WHERE customer_name = 'Гость с улицы'),
  NULL, 'walk-in сразу отмечен пришедшим — стол занят, а не ждёт посадки');

-- ── Занятость проверяет сервер ───────────────────────────────
-- Оба стола заняты walk-in и телефонной бронью на разные окна;
-- явный занятый стол на то же время принять нельзя.
SELECT throws_ok(
  format(
    $$SELECT create_reservation_web(
        'c1000000-0000-4000-8000-000000000001', 'Второй на тот же стол', '0500000001', 2,
        %L, NULL, ARRAY['c2000000-0000-4000-8000-000000000002'::UUID])$$,
    (SELECT reserved_at FROM reservations WHERE customer_name = 'Гость с улицы')),
  'table_busy',
  'посадить поверх занятого стола нельзя');

-- ── Правка визита ────────────────────────────────────────────
-- Ищем по неизменяемому признаку: имя тест сам же и переименовывает,
-- walk-in отличается размером компании, а «занявший стол» появится
-- позже и исключён явно.
CREATE FUNCTION pg_temp.dana() RETURNS UUID LANGUAGE sql AS $$
  SELECT id FROM reservations
  WHERE party_size = 2 AND customer_name <> 'Занявший стол 1'
  ORDER BY reserved_at LIMIT 1
$$;

SELECT lives_ok(
  format($$SELECT update_reservation_guest_web(
      'c1000000-0000-4000-8000-000000000001', %L, 'Дана Леви', '0529999999')$$,
    pg_temp.dana()),
  'имя и телефон правятся');

SELECT lives_ok(
  format($$SELECT update_reservation_web(
      'c1000000-0000-4000-8000-000000000001', %L, NULL, NULL, 'у окна')$$,
    pg_temp.dana()),
  'заметка правится существующей функцией 120');

SELECT is(
  (SELECT customer_name FROM reservations WHERE id = pg_temp.dana()),
  'Дана Леви', 'имя обновлено');
SELECT is(
  (SELECT customer_phone FROM reservations WHERE id = pg_temp.dana()),
  '0529999999', 'телефон нормализован и обновлён');
SELECT is(
  (SELECT note FROM reservations WHERE id = pg_temp.dana()),
  'у окна', 'заметка сохранена');

-- Перенос на свободное время
SELECT lives_ok(
  format($$SELECT update_reservation_web(
      'c1000000-0000-4000-8000-000000000001', %L, NOW() + INTERVAL '8 hours')$$,
    pg_temp.dana()),
  'перенос на свободное время проходит');

-- Перенос на время, когда её собственный стол занят другим визитом.
-- Именно этот случай и создаёт двойную посадку, если не проверять сервером.
SELECT create_reservation_web(
  'c1000000-0000-4000-8000-000000000001', 'Занявший стол 1', '0500000003', 2,
  NOW() + INTERVAL '5 hours', NULL,
  ARRAY['c2000000-0000-4000-8000-000000000001'::UUID]);

SELECT throws_ok(
  format($$SELECT update_reservation_web(
      'c1000000-0000-4000-8000-000000000001', %L, %L)$$,
    pg_temp.dana(),
    (SELECT reserved_at FROM reservations WHERE customer_name = 'Занявший стол 1')),
  'table_busy',
  'перенос на время, когда стол визита занят, не проходит');

-- Закрытый визит не редактируется
RESET ROLE;
UPDATE reservations SET status = 'completed' WHERE id = pg_temp.dana();
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"c4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"c0000000-0000-4000-8000-000000000001"}}',
  true
);
SELECT throws_ok(
  format($$SELECT update_reservation_guest_web(
      'c1000000-0000-4000-8000-000000000001', %L, 'Поздно')$$, pg_temp.dana()),
  'not_active',
  'закрытый визит не правится');

-- ── Чужая организация ────────────────────────────────────────
SELECT set_config('request.jwt.claims',
  '{"sub":"c4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"c0000000-0000-4000-8000-0000000000ff"}}',
  true);
SELECT throws_ok(
  $$SELECT create_reservation_web(
      'c1000000-0000-4000-8000-000000000001', 'Чужой', '0500000002', 2)$$,
  'backoffice access denied',
  'чужая организация не заводит брони в этой точке');

SELECT * FROM finish();
ROLLBACK;
