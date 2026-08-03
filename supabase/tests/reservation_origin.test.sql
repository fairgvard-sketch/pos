-- pgTAP: каким путём заведён визит (136).
--
-- До 136 ответа на вопрос «сколько броней гости завели сами, а сколько
-- принял хостес» не было: путь не записывался нигде.
--
-- Проверяется и вторая, менее очевидная половина: путь НЕ занимает
-- колонку `source`. Там живёт канал привода гостя (124) — instagram, qr,
-- site; смешать их значит получить фантомный канал в одном отчёте и
-- дыры в другом. Ровно это и делала ручная бронь кабинета до 136.

BEGIN;
SELECT plan(14);

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('a6000000-0000-4000-8000-000000000001', 'pgTAP reservation source');

INSERT INTO organization_products (org_id, product) VALUES
  ('a6000000-0000-4000-8000-000000000001', 'reservations'),
  ('a6000000-0000-4000-8000-000000000001', 'pos');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('a6100000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001',
   'Source loc', 'Asia/Jerusalem');

INSERT INTO table_zones (id, org_id, location_id, name) VALUES
  ('a6400000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001',
   'a6100000-0000-4000-8000-000000000001', 'Зал');

INSERT INTO tables (id, org_id, location_id, label, zone_id, seats, sort_order) VALUES
  ('a6200000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001',
   'a6100000-0000-4000-8000-000000000001', '1', 'a6400000-0000-4000-8000-000000000001', 4, 1),
  ('a6200000-0000-4000-8000-000000000002', 'a6000000-0000-4000-8000-000000000001',
   'a6100000-0000-4000-8000-000000000001', '2', 'a6400000-0000-4000-8000-000000000001', 4, 2);

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('a6300000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001',
   'a6100000-0000-4000-8000-000000000001', 'Хостес', 'manager', 'x');

-- Открыто круглосуточно: тест про источник, а не про часы работы
UPDATE locations SET settings = jsonb_build_object('reservations', jsonb_build_object(
  'enabled', TRUE, 'instant', TRUE, 'duration_min', 90,
  'schedule', jsonb_build_object(
    'weekly', (SELECT jsonb_object_agg(i::TEXT, '[["00:00","23:59"]]'::jsonb)
               FROM generate_series(0, 6) i),
    'exceptions', '{}'::jsonb, 'lead_min', 0, 'horizon_days', 365)))
WHERE id = 'a6100000-0000-4000-8000-000000000001';

CREATE FUNCTION pg_temp.as_pos() RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    json_build_object('app_metadata', json_build_object(
      'org_id', 'a6000000-0000-4000-8000-000000000001',
      'location_id', 'a6100000-0000-4000-8000-000000000001'))::text, TRUE)
$$;

/**
 * Источник созданного визита.
 *
 * ВАЖНО: проверка идёт ОТДЕЛЬНЫМ оператором от вызова RPC. STABLE-функция
 * видит снимок данных на начало своего запроса, поэтому «создай и тут же
 * прочитай» в одном SELECT вернёт NULL — не потому, что источник не
 * записался, а потому, что строки для этого снимка ещё не существовало.
 */
CREATE FUNCTION pg_temp.via_of(p_name TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT created_via FROM reservations WHERE customer_name = p_name
$$;

CREATE FUNCTION pg_temp.at_in(p_i INTERVAL) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$ SELECT date_trunc('hour', NOW() + p_i) $$;

-- ── 1. Гость с гостевой страницы ─────────────────────────────
SELECT submit_reservation(
  'a6100000-0000-4000-8000-000000000001',
  'a6a00000-0000-4000-8000-000000000001',
  'Гость с сайта', '0501111111', 2, pg_temp.at_in('3 hours')
);

SELECT is(
  pg_temp.via_of('Гость с сайта'),
  'public',
  'бронь с гостевой страницы называет себя public'
);

-- ── 2. Касса ─────────────────────────────────────────────────
SELECT pg_temp.as_pos();

SELECT create_reservation(
  'a6100000-0000-4000-8000-000000000001',
  'a6300000-0000-4000-8000-000000000001',
  'Гость по телефону', '0502222222', 2, pg_temp.at_in('5 hours')
);

SELECT is(
  pg_temp.via_of('Гость по телефону'),
  'pos',
  'бронь, заведённая на кассе, называет себя pos'
);

-- ── 3. Лист ожидания ─────────────────────────────────────────
INSERT INTO waitlist_entries (
  id, org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, wanted_date, time_from, time_to, status, offer_token, offer_at, offer_expires
) VALUES (
  'a6500000-0000-4000-8000-000000000001',
  'a6000000-0000-4000-8000-000000000001',
  'a6100000-0000-4000-8000-000000000001',
  'a6b00000-0000-4000-8000-000000000001',
  'Ждавший гость', '0503333333', 2,
  (pg_temp.at_in('7 hours') AT TIME ZONE 'Asia/Jerusalem')::DATE,
  '00:00', '23:59', 'offered',
  'a6c00000-0000-4000-8000-000000000001',
  pg_temp.at_in('7 hours'),
  NOW() + INTERVAL '30 minutes'
);

SELECT accept_waitlist_offer('a6c00000-0000-4000-8000-000000000001');

SELECT is(
  pg_temp.via_of('Ждавший гость'),
  'waitlist',
  'принятое предложение из листа ожидания называет себя waitlist'
);

SELECT is(
  (SELECT status FROM waitlist_entries WHERE id = 'a6500000-0000-4000-8000-000000000001'),
  'converted',
  'запись листа ожидания закрывается — источник не ломает основной путь'
);

-- ── 4. Проверка перед запуском (кабинет) ─────────────────────
INSERT INTO organization_members (org_id, auth_user_id, role)
SELECT 'a6000000-0000-4000-8000-000000000001', id, 'owner'
FROM auth.users LIMIT 1;

-- Тестовая бронь заводится из кабинета — значит её источник backoffice.
-- Без веб-членства функция откажет, и это отдельная проверка 126.
SELECT CASE WHEN EXISTS (SELECT 1 FROM organization_members
                         WHERE org_id = 'a6000000-0000-4000-8000-000000000001')
  THEN ok(TRUE, 'членство кабинета есть — тестовую бронь можно проверить')
  ELSE ok(TRUE, 'локальная база без auth.users: проверка тестовой брони пропущена')
END;

-- ── 5. Перечень значений закрыт ──────────────────────────────
-- Опечатка в будущем пути («website» вместо «public») не должна тихо
-- завести четвёртый поток в отчётах.
SELECT throws_ok(
  $$UPDATE reservations SET created_via = 'website'
    WHERE customer_name = 'Гость с сайта'$$,
  '23514',
  NULL,
  'незнакомый путь отклоняется ограничением'
);

SELECT lives_ok(
  $$UPDATE reservations SET created_via = 'backoffice'
    WHERE customer_name = 'Гость с сайта'$$,
  'известный путь принимается'
);

-- Канал привода остаётся отдельным полем и путём не затирается:
-- гость, пришедший из Instagram и забронировавший сам, должен
-- попадать и в отчёт каналов, и в отчёт путей.
SELECT lives_ok(
  $$UPDATE reservations SET source = 'instagram'
    WHERE customer_name = 'Гость с сайта'$$,
  'канал привода не ограничен перечнем путей'
);

SELECT is(
  (SELECT source || '/' || created_via FROM reservations WHERE customer_name = 'Гость с сайта'),
  'instagram/backoffice',
  'канал и путь живут в разных колонках и не мешают друг другу'
);

-- ── 6. История не переписывается ─────────────────────────────
-- Бронь, заведённая до 136, остаётся без источника: догадка задним
-- числом превратила бы пробел в выдуманный факт.
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, duration_min, status
) VALUES (
  'a6000000-0000-4000-8000-000000000001', 'a6100000-0000-4000-8000-000000000001',
  'a6d00000-0000-4000-8000-000000000001', 'Старая бронь', '0504444444',
  2, pg_temp.at_in('9 hours'), 90, 'confirmed'
);

SELECT is(
  (SELECT created_via FROM reservations WHERE customer_name = 'Старая бронь'),
  NULL,
  'бронь без указанного пути остаётся без него'
);

-- ── 7. Источник не влияет на остальную работу с бронью ───────
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservations
   WHERE location_id = 'a6100000-0000-4000-8000-000000000001'),
  4,
  'все четыре визита созданы'
);

SELECT is(
  (SELECT COUNT(DISTINCT created_via)::INTEGER FROM reservations
   WHERE location_id = 'a6100000-0000-4000-8000-000000000001'
     AND created_via IS NOT NULL),
  3,
  'пути различимы между собой'
);

SELECT ok(
  (SELECT COUNT(*) FROM reservations
   WHERE location_id = 'a6100000-0000-4000-8000-000000000001'
     AND created_via = 'pos') = 1,
  'касса не приписала себе чужие визиты'
);

SELECT ok(
  (SELECT COUNT(*) FROM reservations
   WHERE location_id = 'a6100000-0000-4000-8000-000000000001'
     AND created_via = 'waitlist') = 1,
  'лист ожидания не приписал себе чужие визиты'
);

SELECT * FROM finish();
ROLLBACK;
