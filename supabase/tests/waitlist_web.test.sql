-- pgTAP: очередь ожидания в кабинете (137).
--
-- До 137 кабинет умел только смотреть лист и отправлять предложение:
-- записать подошедшего гостя было нечем (`submit_waitlist` — service_role),
-- посадить из очереди нельзя вовсе, порядок жёстко по времени записи.
--
-- Проверяется то, на чём стоит живая очередь: запись идемпотентна,
-- посадку решает СЕРВЕР (а не экран, который отстал на минуту),
-- закрытую запись нельзя посадить дважды, ушедший гость остаётся в
-- истории, а перестановка касается только тех, кто ещё ждёт.

BEGIN;
SELECT plan(17);

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'pgTAP waitlist web');

INSERT INTO organization_products (org_id, product) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'reservations');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('a7100000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
   'Queue loc', 'Asia/Jerusalem');

INSERT INTO table_zones (id, org_id, location_id, name) VALUES
  ('a7400000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
   'a7100000-0000-4000-8000-000000000001', 'Зал');

INSERT INTO tables (id, org_id, location_id, label, zone_id, seats, sort_order) VALUES
  ('a7200000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
   'a7100000-0000-4000-8000-000000000001', '1', 'a7400000-0000-4000-8000-000000000001', 2, 1);

UPDATE locations SET settings = jsonb_build_object('reservations', jsonb_build_object(
  'enabled', TRUE, 'duration_min', 90,
  'schedule', jsonb_build_object(
    'weekly', (SELECT jsonb_object_agg(i::TEXT, '[["00:00","23:59"]]'::jsonb)
               FROM generate_series(0, 6) i),
    'exceptions', '{}'::jsonb, 'lead_min', 0, 'horizon_days', 365)))
WHERE id = 'a7100000-0000-4000-8000-000000000001';

-- Владелец кабинета: право даёт членство, а не PIN (модель 123)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                        raw_app_meta_data, created_at, updated_at)
VALUES ('a7900000-0000-4000-8000-000000000001',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'queue-owner@example.com', 'x',
        json_build_object('org_id', 'a7000000-0000-4000-8000-000000000001')::jsonb,
        NOW(), NOW())
ON CONFLICT DO NOTHING;

INSERT INTO organization_members (org_id, auth_user_id, role) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'a7900000-0000-4000-8000-000000000001', 'owner');

CREATE FUNCTION pg_temp.as_owner() RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object(
    'sub', 'a7900000-0000-4000-8000-000000000001',
    'app_metadata', json_build_object('org_id', 'a7000000-0000-4000-8000-000000000001')
  )::text, TRUE)
$$;

CREATE FUNCTION pg_temp.status_of(p_id UUID) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT status FROM waitlist_entries WHERE id = p_id
$$;

SELECT pg_temp.as_owner();

-- ── 1. Запись гостя ──────────────────────────────────────────
SELECT add_waitlist_entry_web(
  'a7100000-0000-4000-8000-000000000001',
  'a7a00000-0000-4000-8000-000000000001',
  'Первый гость', '0501111111', 2, 20
);

SELECT is(
  (SELECT customer_name FROM waitlist_entries
   WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000001'),
  'Первый гость',
  'гостя можно записать в очередь прямо из кабинета'
);

SELECT is(
  (SELECT quoted_min FROM waitlist_entries
   WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000001'),
  20,
  'обещанное ожидание хранится, а не живёт в памяти хостес'
);

SELECT is(
  (SELECT status FROM waitlist_entries
   WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000001'),
  'waiting',
  'новая запись ждёт'
);

-- Повтор после таймаута сети — тем же client_uuid
SELECT add_waitlist_entry_web(
  'a7100000-0000-4000-8000-000000000001',
  'a7a00000-0000-4000-8000-000000000001',
  'Первый гость', '0501111111', 2, 20
);

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM waitlist_entries
   WHERE location_id = 'a7100000-0000-4000-8000-000000000001'),
  1,
  'повтор после таймаута не заводит второго гостя с тем же именем'
);

SELECT throws_ok(
  $$SELECT add_waitlist_entry_web(
      'a7100000-0000-4000-8000-000000000001',
      'a7a00000-0000-4000-8000-000000000002', '  ', '0502222222', 2)$$,
  'name_required',
  'безымянного гостя в очередь не берут — звать будет некого'
);

SELECT throws_ok(
  $$SELECT add_waitlist_entry_web(
      'a7100000-0000-4000-8000-000000000001',
      'a7a00000-0000-4000-8000-000000000003', 'Кто-то', '0503333333', 2, 900)$$,
  'invalid_quote',
  'пятнадцать часов ожидания не обещают'
);

-- ── 2. Посадка ───────────────────────────────────────────────
SELECT lives_ok(
  $$SELECT seat_waitlist_entry_web('a7100000-0000-4000-8000-000000000001',
      (SELECT id FROM waitlist_entries
       WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000001'))$$,
  'гостя из очереди можно посадить'
);

SELECT is(
  (SELECT status FROM waitlist_entries
   WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000001'),
  'converted',
  'запись закрывается: очередь помнит, чем кончилось ожидание'
);

SELECT is(
  (SELECT created_via FROM reservations
   WHERE location_id = 'a7100000-0000-4000-8000-000000000001'),
  'waitlist',
  'визит знает, что пришёл из очереди'
);

SELECT isnt(
  (SELECT arrived_at FROM reservations
   WHERE location_id = 'a7100000-0000-4000-8000-000000000001'),
  NULL,
  'гость сразу посажен — он уже стоит у стойки, а не приедет к вечеру'
);

SELECT throws_ok(
  $$SELECT seat_waitlist_entry_web('a7100000-0000-4000-8000-000000000001',
      (SELECT id FROM waitlist_entries
       WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000001'))$$,
  'already_closed',
  'посаженного не сажают дважды — вторая бронь заняла бы ещё стол'
);

-- Единственный стол занят: сервер отказывает, а не сажает поверх
SELECT add_waitlist_entry_web(
  'a7100000-0000-4000-8000-000000000001',
  'a7a00000-0000-4000-8000-000000000004', 'Второй гость', '0504444444', 2
);

SELECT throws_ok(
  $$SELECT seat_waitlist_entry_web('a7100000-0000-4000-8000-000000000001',
      (SELECT id FROM waitlist_entries
       WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000004'))$$,
  'full_slot',
  'занятость решает сервер: свободных столов нет — посадки нет'
);

-- ── 3. Уход из очереди ───────────────────────────────────────
SELECT set_waitlist_status_web(
  'a7100000-0000-4000-8000-000000000001',
  (SELECT id FROM waitlist_entries WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000004'),
  'cancelled'
);

SELECT is(
  (SELECT status FROM waitlist_entries WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000004'),
  'cancelled',
  'ушедший гость помечается, а не стирается: сколько людей ушло — вопрос к очереди'
);

SELECT lives_ok(
  $$SELECT set_waitlist_status_web('a7100000-0000-4000-8000-000000000001',
      (SELECT id FROM waitlist_entries WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000004'),
      'waiting')$$,
  'ошибочно убранного можно вернуть в очередь'
);

SELECT throws_ok(
  $$SELECT set_waitlist_status_web('a7100000-0000-4000-8000-000000000001',
      (SELECT id FROM waitlist_entries WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000001'),
      'waiting')$$,
  'already_closed',
  'посаженного назад в очередь не возвращают — за ним уже стоит визит'
);

-- ── 4. Перестановка ──────────────────────────────────────────
SELECT add_waitlist_entry_web(
  'a7100000-0000-4000-8000-000000000001',
  'a7a00000-0000-4000-8000-000000000005', 'Третий гость', '0505555555', 4
);

SELECT is(
  reorder_waitlist_web('a7100000-0000-4000-8000-000000000001', ARRAY[
    (SELECT id FROM waitlist_entries WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000005'),
    (SELECT id FROM waitlist_entries WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000004'),
    -- Посаженный в порядке не участвует: его место уже в истории
    (SELECT id FROM waitlist_entries WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000001')
  ]),
  2,
  'переставляются только те, кто ещё ждёт'
);

SELECT is(
  (SELECT position FROM waitlist_entries WHERE client_uuid = 'a7a00000-0000-4000-8000-000000000005'),
  1,
  'гость, которого решили позвать первым, стоит первым'
);

SELECT * FROM finish();
ROLLBACK;
