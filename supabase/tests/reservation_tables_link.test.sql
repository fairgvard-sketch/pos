-- pgTAP: связь брони со столами, анти-овербукинг объединения,
-- посадка гостя и хостес-действия (119).
--
-- Главное, что здесь доказывается: два стола объединённой брони защищены
-- так же, как основной. До 119 занятость держалась на `table_id`, а
-- дополнительные столы лежали в массиве, который gist-исключением не
-- покрыть — две компании могли сесть за один стол без единой ошибки.

BEGIN;
SELECT plan(30);

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'pgTAP reservation tables');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'Link loc', 'Asia/Jerusalem');

INSERT INTO organization_products (org_id, product) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'reservations'),
  ('f0000000-0000-4000-8000-000000000001', 'pos');

INSERT INTO table_zones (id, org_id, location_id, name) VALUES
  ('f4000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', 'Зал'),
  ('f4000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', 'Терраса');

INSERT INTO tables (id, org_id, location_id, label, zone_id, seats, combinable, sort_order) VALUES
  ('f2000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', '1', 'f4000000-0000-4000-8000-000000000001', 2, TRUE, 1),
  ('f2000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', '2', 'f4000000-0000-4000-8000-000000000001', 4, TRUE, 2),
  ('f2000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', '3', 'f4000000-0000-4000-8000-000000000002', 4, TRUE, 3);

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('f3000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', 'Хостес', 'manager', 'x');

UPDATE locations SET settings = jsonb_build_object('reservations',
  jsonb_build_object('enabled', TRUE, 'instant', TRUE, 'combine', TRUE,
    'duration_min', 90, 'buffer_min', 0, 'max_party', 20,
    'schedule', jsonb_build_object(
      'weekly', (SELECT jsonb_object_agg(i::TEXT, '[["00:00","23:59"]]'::jsonb)
                 FROM generate_series(0, 6) i),
      'exceptions', '{}'::jsonb, 'lead_min', 30, 'horizon_days', 365)))
WHERE id = 'f1000000-0000-4000-8000-000000000001';

-- Тесты идут от имени устройства этой организации: RPC читают auth_org_id().
CREATE FUNCTION pg_temp.as_org() RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    json_build_object('app_metadata', json_build_object(
      'org_id', 'f0000000-0000-4000-8000-000000000001',
      'location_id', 'f1000000-0000-4000-8000-000000000001'))::text, TRUE)
$$;

CREATE FUNCTION pg_temp.at_in(p_i INTERVAL) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$ SELECT date_trunc('hour', NOW() + p_i) $$;

CREATE FUNCTION pg_temp.linked(p_res UUID) RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::INTEGER FROM reservation_tables WHERE reservation_id = p_res
$$;

CREATE FUNCTION pg_temp.live_links(p_res UUID) RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::INTEGER FROM reservation_tables WHERE reservation_id = p_res AND is_live
$$;

SELECT pg_temp.as_org();

-- ── 1. Триггер ведёт связь ───────────────────────────────────
INSERT INTO reservations (
  id, org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, duration_min, table_id, hold_table_ids, status)
VALUES (
  'f9000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
  'f9000000-0000-4000-8000-0000000000a1', 'Компания', '0501234567',
  6, pg_temp.at_in(INTERVAL '2 days'), 90,
  'f2000000-0000-4000-8000-000000000002',
  ARRAY['f2000000-0000-4000-8000-000000000001']::UUID[], 'confirmed');

SELECT is(pg_temp.linked('f9000000-0000-4000-8000-000000000001'), 2,
  'объединённая бронь связана с ДВУМЯ столами, а не с одним');
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservation_tables
   WHERE reservation_id = 'f9000000-0000-4000-8000-000000000001' AND is_primary),
  1,
  'ровно один стол помечен основным — в него сажает касса');

-- ── 2. Гонка объединённых столов закрыта ─────────────────────
-- Стол 1 добавлен объединением. До 119 он выглядел свободным, и вторая
-- бронь на него проходила молча.
SELECT throws_ok($$
  INSERT INTO reservations (
    org_id, location_id, client_uuid, customer_name, customer_phone,
    party_size, reserved_at, duration_min, table_id, status)
  VALUES (
    'f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
    'f9000000-0000-4000-8000-0000000000a2', 'Чужой', '0507654321',
    2, pg_temp.at_in(INTERVAL '2 days') + INTERVAL '30 minutes', 90,
    'f2000000-0000-4000-8000-000000000001', 'confirmed')
$$, '23P01', NULL,
  'EXCLUDE: стол, добавленный объединением, нельзя занять второй бронью');

SELECT ok(
  NOT _table_free('f2000000-0000-4000-8000-000000000001',
                  pg_temp.at_in(INTERVAL '2 days') + INTERVAL '30 minutes', 90, 0, NULL),
  '_table_free видит стол объединения занятым');
SELECT ok(
  _table_free('f2000000-0000-4000-8000-000000000003',
              pg_temp.at_in(INTERVAL '2 days') + INTERVAL '30 minutes', 90, 0, NULL),
  'свободный стол другой зоны остаётся свободным');

-- ── 3. Терминальный статус освобождает столы ─────────────────
UPDATE reservations SET status = 'completed'
WHERE id = 'f9000000-0000-4000-8000-000000000001';

SELECT is(pg_temp.live_links('f9000000-0000-4000-8000-000000000001'), 0,
  'completed освобождает все столы брони');
SELECT is(pg_temp.linked('f9000000-0000-4000-8000-000000000001'), 2,
  'но связь сохраняется — таймлайн показывает прошедший визит');
SELECT ok(
  _table_free('f2000000-0000-4000-8000-000000000001',
              pg_temp.at_in(INTERVAL '2 days') + INTERVAL '30 minutes', 90, 0, NULL),
  'после завершения визита стол снова свободен');

UPDATE reservations SET status = 'confirmed'
WHERE id = 'f9000000-0000-4000-8000-000000000001';
SELECT is(pg_temp.live_links('f9000000-0000-4000-8000-000000000001'), 2,
  'возврат в живой статус снова занимает столы');

-- ── 4. Ручная бронь хостес (create_reservation v2) ───────────
-- Банкет на 40 человек: старый потолок в 20 гостей его не пускал.
SELECT lives_ok($$
  SELECT create_reservation(
    'f1000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001',
    'Банкет', '0509999999', 40, pg_temp.at_in(INTERVAL '5 days'),
    'юбилей', NULL, NULL, 240)
$$, 'ручная бронь на 40 гостей проходит (было ограничение 20)');

SELECT throws_ok($$
  SELECT create_reservation(
    'f1000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001',
    'Занято', '0509999999', 2, pg_temp.at_in(INTERVAL '2 days'),
    NULL, 'f2000000-0000-4000-8000-000000000002')
$$, 'table_busy',
  'ручная бронь на занятый стол — дружелюбный table_busy, а не сырой констрейнт');

SELECT lives_ok($$
  SELECT create_reservation(
    'f1000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001',
    'С зоной', '0508888888', 2, pg_temp.at_in(INTERVAL '6 days'),
    NULL, NULL, 'f4000000-0000-4000-8000-000000000002')
$$, 'ручная бронь принимает зону (072 с кассы был недоступен)');

SELECT throws_ok($$
  SELECT create_reservation(
    'f1000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001',
    'Чужая зона', '0508888888', 2, pg_temp.at_in(INTERVAL '6 days'),
    NULL, NULL, 'f4000000-0000-4000-8000-0000000000ff')
$$, 'invalid_zone', 'чужая зона отклоняется');

-- ── 5. Набор столов: объединить / разъединить ────────────────
INSERT INTO reservations (
  id, org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, duration_min, status)
VALUES (
  'f9000000-0000-4000-8000-000000000002',
  'f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
  'f9000000-0000-4000-8000-0000000000a3', 'Без стола', '0501112233',
  6, pg_temp.at_in(INTERVAL '10 days'), 90, 'confirmed');

SELECT is(pg_temp.linked('f9000000-0000-4000-8000-000000000002'), 0,
  'бронь без стола связей не имеет');

SELECT lives_ok($$
  SELECT set_reservation_tables(
    'f9000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000001',
    ARRAY['f2000000-0000-4000-8000-000000000002',
          'f2000000-0000-4000-8000-000000000001']::UUID[])
$$, 'хостес объединяет два стола одним действием');

SELECT is(pg_temp.linked('f9000000-0000-4000-8000-000000000002'), 2,
  'связаны оба стола объединения');
SELECT is(
  (SELECT table_id FROM reservations WHERE id = 'f9000000-0000-4000-8000-000000000002'),
  'f2000000-0000-4000-8000-000000000002'::UUID,
  'первый стол набора стал основным');
SELECT is(
  (SELECT cardinality(hold_table_ids) FROM reservations
   WHERE id = 'f9000000-0000-4000-8000-000000000002'),
  1,
  'остальные ушли в hold_table_ids — старый контракт сохранён');

SELECT lives_ok($$
  SELECT set_reservation_tables(
    'f9000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000001',
    ARRAY['f2000000-0000-4000-8000-000000000002']::UUID[])
$$, 'разъединение оставляет один стол');
SELECT is(pg_temp.linked('f9000000-0000-4000-8000-000000000002'), 1,
  'лишняя связь снята');

SELECT lives_ok($$
  SELECT set_reservation_tables(
    'f9000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000001',
    ARRAY[]::UUID[])
$$, 'пустой набор снимает столы');
SELECT is(pg_temp.linked('f9000000-0000-4000-8000-000000000002'), 0,
  'связей не осталось');

SELECT throws_ok($$
  SELECT set_reservation_tables(
    'f9000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000001',
    ARRAY['f2000000-0000-4000-8000-0000000000ff']::UUID[])
$$, 'invalid table', 'чужой стол отклоняется');

-- ── 6. Правка брони хостес ───────────────────────────────────
SELECT lives_ok($$
  SELECT update_reservation(
    'f9000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000001',
    pg_temp.at_in(INTERVAL '11 days'), 8, 'перенесли и увеличили')
$$, 'хостес меняет время и размер компании');

SELECT is(
  (SELECT party_size FROM reservations WHERE id = 'f9000000-0000-4000-8000-000000000002'),
  8, 'размер компании обновлён');

-- Сдвиг времени на занятый интервал отклоняется: таймлайн не должен
-- показывать двух гостей за одним столом.
SELECT lives_ok($$
  SELECT set_reservation_tables(
    'f9000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000001',
    ARRAY['f2000000-0000-4000-8000-000000000003']::UUID[])
$$, 'фикстура: бронь получает свободный стол 3');

INSERT INTO reservations (
  id, org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, duration_min, table_id, status)
VALUES (
  'f9000000-0000-4000-8000-000000000003',
  'f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
  'f9000000-0000-4000-8000-0000000000a4', 'Сосед', '0504445566',
  2, pg_temp.at_in(INTERVAL '12 days'), 90,
  'f2000000-0000-4000-8000-000000000003', 'confirmed');

SELECT throws_ok($$
  SELECT update_reservation(
    'f9000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000001',
    pg_temp.at_in(INTERVAL '12 days'))
$$, 'table_busy',
  'сдвиг времени на занятый столом интервал отклонён — скрытого конфликта нет');

-- ── 7. Посадка гостя ─────────────────────────────────────────
SELECT lives_ok($$
  SELECT mark_reservation_arrived('f9000000-0000-4000-8000-000000000003',
                                  'f3000000-0000-4000-8000-000000000001')
$$, 'хостес отмечает посадку без POS-заказа');

SELECT ok(
  (SELECT arrived_at IS NOT NULL AND order_id IS NULL
   FROM reservations WHERE id = 'f9000000-0000-4000-8000-000000000003'),
  'посадка отмечена флагом, счёт не открывался (точка без POS)');

SELECT is(pg_temp.live_links('f9000000-0000-4000-8000-000000000003'), 1,
  'посадка не освобождает стол — гость за ним сидит');

SELECT * FROM finish();
ROLLBACK;
