-- pgTAP: история визита (154).
--
-- Проверяется то, ради чего таблица и заведена: переход называется
-- своим именем и переживает следующий переход, история не переписывается
-- и не выдумывается задним числом, а граница арендатора держится.

BEGIN;
SELECT plan(17);

INSERT INTO orgs (id, name) VALUES
  ('a9000000-0000-4000-8000-000000000001', 'pgTAP visit events');
INSERT INTO locations (id, org_id, name, timezone, settings) VALUES
  ('a9100000-0000-4000-8000-000000000001',
   'a9000000-0000-4000-8000-000000000001', 'Events loc', 'Asia/Jerusalem',
   '{"reservations":{"duration_min":90,"buffer_min":0}}'::jsonb);
INSERT INTO organization_products (org_id, product) VALUES
  ('a9000000-0000-4000-8000-000000000001', 'reservations');
INSERT INTO auth.users (id) VALUES ('a9400000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, display_name, is_active) VALUES
  ('a9500000-0000-4000-8000-000000000001',
   'a9000000-0000-4000-8000-000000000001', 'a9400000-0000-4000-8000-000000000001',
   'owner', 'Дана Хостес', TRUE);
INSERT INTO tables (id, org_id, location_id, label, seats, sort_order) VALUES
  ('a9200000-0000-4000-8000-000000000001',
   'a9000000-0000-4000-8000-000000000001',
   'a9100000-0000-4000-8000-000000000001', '1', 4, 0),
  ('a9200000-0000-4000-8000-000000000002',
   'a9000000-0000-4000-8000-000000000001',
   'a9100000-0000-4000-8000-000000000001', '2', 4, 1);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a9400000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"a9000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT create_reservation_web(
  'a9100000-0000-4000-8000-000000000001', 'Мири Леви', '0521111111', 2,
  NOW() + INTERVAL '3 hours');

CREATE TEMP TABLE v AS
SELECT id FROM reservations WHERE customer_name = 'Мири Леви';

-- ── 1. Заведение визита событием НЕ является ─────────────────
-- Оно уже записано в самой брони (created_at + created_via, 136), и
-- вторая копия того же факта неизбежно разошлась бы с первой.
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservation_events
   WHERE reservation_id = (SELECT id FROM v)),
  0, 'создание визита не дублируется событием');

-- ── 2. Посадка записана и названа ────────────────────────────
SELECT mark_reservation_arrived_web(
  'a9100000-0000-4000-8000-000000000001', (SELECT id FROM v));

SELECT is(
  (SELECT type FROM reservation_events WHERE reservation_id = (SELECT id FROM v)),
  'seated', 'посадка записана отдельным событием');

SELECT is(
  (SELECT actor_member FROM reservation_events WHERE reservation_id = (SELECT id FROM v)),
  'a9500000-0000-4000-8000-000000000001'::UUID,
  'записано, КТО посадил');

-- ── 3. Перенос несёт прежнее время ───────────────────────────
SELECT update_reservation_web(
  'a9100000-0000-4000-8000-000000000001', (SELECT id FROM v),
  NOW() + INTERVAL '5 hours');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservation_events
   WHERE reservation_id = (SELECT id FROM v) AND type = 'moved'),
  1, 'перенос записан');

SELECT ok(
  (SELECT detail ? 'from' AND detail ? 'to' FROM reservation_events
   WHERE reservation_id = (SELECT id FROM v) AND type = 'moved'),
  'прежнее время — часть факта, иначе «перенесена» ничего не говорит');

-- ── 4. Пересадка за другой стол ──────────────────────────────
SELECT set_reservation_tables_web(
  'a9100000-0000-4000-8000-000000000001', (SELECT id FROM v),
  ARRAY['a9200000-0000-4000-8000-000000000002']::UUID[]);

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservation_events
   WHERE reservation_id = (SELECT id FROM v) AND type = 'tables'),
  1, 'пересадка записана');

-- ── 5. Переход переживает следующий переход ──────────────────
-- Это и есть причина таблицы: `decided_at` перезаписывался, и «когда
-- подтвердили» после завершения визита ответа не имело.
SELECT set_reservation_status_web(
  'a9100000-0000-4000-8000-000000000001', (SELECT id FROM v), 'completed');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservation_events
   WHERE reservation_id = (SELECT id FROM v) AND type = 'seated'),
  1, 'посадка не стёрлась завершением визита');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservation_events
   WHERE reservation_id = (SELECT id FROM v) AND type = 'completed'),
  1, 'завершение записано');

SELECT ok(
  (SELECT COUNT(*)::INTEGER FROM reservation_events
   WHERE reservation_id = (SELECT id FROM v)) >= 4,
  'вся цепочка перехода осталась на месте');

-- ── 6. Причина отмены сохраняется ────────────────────────────
-- Ручная бронь кабинета сразу `confirmed` (127), а из `confirmed`
-- веб-стол ведёт в `cancelled` — переход `rejected` есть только у
-- необработанной заявки (102).
SELECT create_reservation_web(
  'a9100000-0000-4000-8000-000000000001', 'Отказ', '0522222222', 2,
  NOW() + INTERVAL '8 hours');

SELECT set_reservation_status_web(
  'a9100000-0000-4000-8000-000000000001',
  (SELECT id FROM reservations WHERE customer_name = 'Отказ'),
  'cancelled', 'Закрыто на частное мероприятие');

SELECT is(
  (SELECT detail ->> 'reason' FROM reservation_events
   WHERE reservation_id = (SELECT id FROM reservations WHERE customer_name = 'Отказ')
     AND type = 'cancelled'),
  'Закрыто на частное мероприятие',
  'причина — часть записи, а не только текущее поле брони');

-- ── 7. Карточка визита отдаёт историю с именем ───────────────
SELECT is(
  (SELECT jsonb_array_length(get_visit_web(
     'a9100000-0000-4000-8000-000000000001', (SELECT id FROM v)) -> 'events')),
  (SELECT COUNT(*)::INTEGER FROM reservation_events WHERE reservation_id = (SELECT id FROM v)),
  'карточка отдаёт все записанные переходы');

SELECT is(
  (SELECT get_visit_web(
     'a9100000-0000-4000-8000-000000000001', (SELECT id FROM v))
   -> 'events' -> 0 ->> 'actor_name'),
  'Дана Хостес', 'кабинет показывает имя, а не uuid');

SELECT ok(
  (SELECT (get_visit_web(
     'a9100000-0000-4000-8000-000000000001', (SELECT id FROM v))
   -> 'events' -> 0 ->> 'at') IS NOT NULL),
  'у события есть момент');

-- ── 8. История append-only ───────────────────────────────────
SELECT throws_ok(
  $$UPDATE reservation_events SET type = 'confirmed'$$,
  NULL,
  'переписать историю нельзя');

SELECT throws_ok(
  $$DELETE FROM reservation_events$$,
  NULL,
  'удалить историю нельзя');

SELECT throws_ok(
  $$INSERT INTO reservation_events (org_id, location_id, reservation_id, type)
    VALUES ('a9000000-0000-4000-8000-000000000001',
            'a9100000-0000-4000-8000-000000000001',
            (SELECT id FROM v), 'confirmed')$$,
  NULL,
  'дописать событие снаружи нельзя — пишет только триггер');

-- ── 9. Граница арендатора ────────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a9400000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"a9000000-0000-4000-8000-000000000009"}}',
  true
);

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservation_events),
  0, 'чужая организация истории визитов не видит');

SELECT * FROM finish();
ROLLBACK;
