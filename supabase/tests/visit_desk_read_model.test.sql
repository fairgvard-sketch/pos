-- pgTAP: каноническая read-модель визита (152).
--
-- Проверяется то, ради чего она сделана: один ответ вместо четырёх
-- выборок, контекст гостя без N+1, сводка POS-заказа без права его
-- трогать — и граница арендатора, которую read-модель обязана держать
-- так же строго, как пишущие RPC.

BEGIN;
SELECT plan(31);

-- ── Своя организация ─────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'pgTAP desk model');
INSERT INTO locations (id, org_id, name, timezone, settings) VALUES
  ('e1000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001', 'Model loc', 'Asia/Jerusalem',
   '{"reservations":{"duration_min":90,"buffer_min":0,
                     "schedule":{"weekly":{"0":[["09:00","23:00"]]}}}}'::jsonb);
INSERT INTO organization_products (org_id, product) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'reservations');
INSERT INTO auth.users (id) VALUES ('e4000000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('e5000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001',
   'owner', TRUE);
INSERT INTO table_zones (id, org_id, location_id, name, sort_order, is_active) VALUES
  ('e6000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', 'Терраса', 0, TRUE);
INSERT INTO tables (id, org_id, location_id, label, seats, sort_order, zone_id, is_active, status) VALUES
  ('e2000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', '1', 2, 0,
   'e6000000-0000-4000-8000-000000000001', TRUE, 'free'),
  -- Выключенный стол: он ОБЯЗАН приехать с признаком, а не исчезнуть
  ('e2000000-0000-4000-8000-000000000002',
   'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', '2', 6, 1, NULL, FALSE, 'disabled'),
  -- Рабочий стол на компанию: иначе подбор упрётся в выключенный и
  -- фикстура проверяла бы отказ вместо read-модели
  ('e2000000-0000-4000-8000-000000000003',
   'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', '3', 6, 2,
   'e6000000-0000-4000-8000-000000000001', TRUE, 'free');

-- ── Чужая организация: та же форма данных ────────────────────
INSERT INTO orgs (id, name) VALUES
  ('e0000000-0000-4000-8000-000000000002', 'pgTAP stranger');
INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('e1000000-0000-4000-8000-000000000002',
   'e0000000-0000-4000-8000-000000000002', 'Stranger loc', 'Asia/Jerusalem');
INSERT INTO organization_products (org_id, product) VALUES
  ('e0000000-0000-4000-8000-000000000002', 'reservations');

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"e4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"e0000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Данные заводим тем же путём, что и продукт ───────────────
SELECT create_reservation_web(
  'e1000000-0000-4000-8000-000000000001', 'Мири Леви', '0521111111', 2,
  NOW() + INTERVAL '2 hours');
SELECT create_reservation_web(
  'e1000000-0000-4000-8000-000000000001', 'Дан Коэн', '0522222222', 4,
  NOW() + INTERVAL '5 hours');

-- ── 1. Один ответ вместо четырёх выборок ─────────────────────
SELECT lives_ok(
  $$SELECT get_reservation_desk_web(
      'e1000000-0000-4000-8000-000000000001',
      NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day')$$,
  'стол хостес отдаётся одним вызовом');

SELECT is(
  (SELECT jsonb_array_length(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'visits')),
  2, 'визиты окна пришли');

SELECT is(
  (SELECT jsonb_array_length(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'tables')),
  3, 'столы приехали тем же ответом');

SELECT is(
  (SELECT jsonb_array_length(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'zones')),
  1, 'зоны приехали тем же ответом');

SELECT is(
  (SELECT get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') ->> 'timezone'),
  'Asia/Jerusalem', 'часовой пояс точки — часть ответа');

SELECT isnt(
  (SELECT get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'schedule'),
  NULL, 'расписание точки — часть ответа, а не отдельный запрос');

-- ── 2. Выключенный стол виден и помечен ──────────────────────
SELECT is(
  (SELECT (t ->> 'blocked')::BOOLEAN
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'tables') t
   WHERE t ->> 'label' = '2'),
  TRUE, 'выключенный стол остаётся в ответе с признаком blocked');

SELECT is(
  (SELECT (t ->> 'blocked')::BOOLEAN
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'tables') t
   WHERE t ->> 'label' = '1'),
  FALSE, 'рабочий стол не помечен выключенным');

SELECT is(
  (SELECT t ->> 'zone_name'
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'tables') t
   WHERE t ->> 'label' = '1'),
  'Терраса', 'зона стола названа словом, а не одним id');

-- ── 3. Столы визита приходят связью, основной первым ─────────
SELECT set_reservation_tables_web(
  'e1000000-0000-4000-8000-000000000001',
  (SELECT id FROM reservations WHERE customer_name = 'Мири Леви'),
  ARRAY['e2000000-0000-4000-8000-000000000001']::UUID[]);

SELECT is(
  (SELECT jsonb_array_length(v -> 'table_ids')
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'visits') v
   WHERE v ->> 'customer_name' = 'Мири Леви'),
  1, 'столы визита приходят строками связи 119');

-- ── 4. Контекст гостя без N+1 ────────────────────────────────
SELECT isnt(
  (SELECT v -> 'guest'
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'visits') v
   WHERE v ->> 'customer_name' = 'Мири Леви'),
  'null'::jsonb, 'у визита с телефоном есть контекст гостя');

SELECT is(
  (SELECT (v -> 'guest' ->> 'upcoming')::INTEGER
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'visits') v
   WHERE v ->> 'customer_name' = 'Мири Леви'),
  1, 'предстоящий визит посчитан');

SELECT is(
  (SELECT (v -> 'guest' ->> 'no_shows')::INTEGER
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'visits') v
   WHERE v ->> 'customer_name' = 'Мири Леви'),
  0, 'неявок у нового гостя нет');

-- Заметка и метки гостя в списочную модель НЕ попадают
SELECT ok(
  (SELECT NOT (v -> 'guest' ? 'notes')
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'visits') v
   WHERE v ->> 'customer_name' = 'Мири Леви'),
  'внутренняя заметка гостя не рассылается списком');

SELECT ok(
  (SELECT NOT (v -> 'guest' ? 'tags')
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'visits') v
   WHERE v ->> 'customer_name' = 'Мири Леви'),
  'внутренние метки гостя не рассылаются списком');

-- ── 5. Неявка меняет контекст, а не выдумывается ─────────────
SELECT set_reservation_status_web(
  'e1000000-0000-4000-8000-000000000001',
  (SELECT id FROM reservations WHERE customer_name = 'Дан Коэн'),
  'no_show');

SELECT create_reservation_web(
  'e1000000-0000-4000-8000-000000000001', 'Дан Коэн', '0522222222', 4,
  NOW() + INTERVAL '9 hours');

SELECT is(
  (SELECT DISTINCT (v -> 'guest' ->> 'no_shows')::INTEGER
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'visits') v
   WHERE v ->> 'customer_name' = 'Дан Коэн'),
  1, 'неявка попадает в контекст гостя на всех его визитах');

-- ── 6. Тестовая бронь не делает гостя постоянным ─────────────
SELECT create_test_reservation_web(
  'e1000000-0000-4000-8000-000000000001', NOW() + INTERVAL '11 hours', 2);

SELECT ok(
  (SELECT COALESCE(SUM((v -> 'guest' ->> 'visits')::INTEGER), 0) = 0
   FROM jsonb_array_elements(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') -> 'visits') v
   WHERE (v ->> 'is_test')::BOOLEAN),
  'тестовая бронь не засчитывается как состоявшийся визит');

-- ── 7. Окно и потолок честные ────────────────────────────────
SELECT is(
  (SELECT jsonb_array_length(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() + INTERVAL '20 days', NOW() + INTERVAL '21 days') -> 'visits')),
  0, 'вне окна визитов нет');

SELECT is(
  (SELECT (get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 1) ->> 'capped')::BOOLEAN),
  TRUE, 'упёрлись в потолок — вызывающий об этом знает');

SELECT is(
  (SELECT jsonb_array_length(get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 1) -> 'visits')),
  1, 'потолок соблюдён');

SELECT is(
  (SELECT (get_reservation_desk_web(
     'e1000000-0000-4000-8000-000000000001',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') ->> 'capped')::BOOLEAN),
  FALSE, 'в пределах потолка ответ не помечен обрезанным');

SELECT throws_ok(
  $$SELECT get_reservation_desk_web(
      'e1000000-0000-4000-8000-000000000001',
      NOW() + INTERVAL '1 day', NOW() - INTERVAL '1 day')$$,
  'invalid_range',
  'перевёрнутое окно отклоняется');

SELECT throws_ok(
  $$SELECT get_reservation_desk_web(
      'e1000000-0000-4000-8000-000000000001',
      NOW() - INTERVAL '500 days', NOW())$$,
  'range_too_wide',
  'синхронный ответ не превращается в выгрузку года');

-- ── 8. Карточка визита ───────────────────────────────────────
SELECT lives_ok(
  $$SELECT get_visit_web(
      'e1000000-0000-4000-8000-000000000001',
      (SELECT id FROM reservations WHERE customer_name = 'Мири Леви'))$$,
  'карточка визита открывается одним вызовом');

SELECT is(
  (SELECT get_visit_web(
     'e1000000-0000-4000-8000-000000000001',
     (SELECT id FROM reservations WHERE customer_name = 'Мири Леви'))
   -> 'guest' ->> 'phone'),
  '0521111111', 'карточка знает профиль гостя');

SELECT ok(
  (SELECT get_visit_web(
     'e1000000-0000-4000-8000-000000000001',
     (SELECT id FROM reservations WHERE customer_name = 'Мири Леви'))
   -> 'guest' ? 'notes'),
  'заметка гостя доступна в открытой карточке');

SELECT isnt(
  (SELECT get_visit_web(
     'e1000000-0000-4000-8000-000000000001',
     (SELECT id FROM reservations WHERE customer_name = 'Мири Леви'))
   -> 'guest' -> 'stats'),
  NULL, 'полная статистика броней приходит той же карточкой');

-- ── 9. Standalone Reserve: денежной части нет, а не ноль-ложь ─
-- Ключ есть и он пуст. Не «сумма 0»: ноль означал бы заказ, в котором
-- ничего не пробили, а здесь заказа нет вовсе.
SELECT is(
  (SELECT get_visit_web(
     'e1000000-0000-4000-8000-000000000001',
     (SELECT id FROM reservations WHERE customer_name = 'Мири Леви'))
   -> 'order'),
  'null'::jsonb, 'у визита без POS-заказа сводки заказа нет');

-- ── 10. Граница арендатора ───────────────────────────────────
SELECT throws_ok(
  $$SELECT get_reservation_desk_web(
      'e1000000-0000-4000-8000-000000000002',
      NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day')$$,
  NULL,
  'чужая точка не отдаётся read-моделью');

SELECT throws_ok(
  $$SELECT get_visit_web(
      'e1000000-0000-4000-8000-000000000002',
      (SELECT id FROM reservations WHERE customer_name = 'Мири Леви'))$$,
  NULL,
  'карточка визита в чужой точке не отдаётся');

-- Устройство кассы (JWT без бэкофисной роли) веб-моделью не пользуется
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"e4000000-0000-4000-8000-000000000009","role":"authenticated","app_metadata":{"org_id":"e0000000-0000-4000-8000-000000000001","location_id":"e1000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$SELECT get_reservation_desk_web(
      'e1000000-0000-4000-8000-000000000001',
      NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day')$$,
  'backoffice access denied',
  'без членства в кабинете read-модель закрыта');

SELECT * FROM finish();
ROLLBACK;
