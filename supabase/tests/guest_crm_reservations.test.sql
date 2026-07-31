-- pgTAP: единый профиль гостя для броней и продаж (121).
--
-- До 121 профилей было два и они не знали друг о друге: `guests`
-- заполнялась продажами, а история броней считалась отдельным агрегатом
-- по телефону. Гость, который бронирует стол каждую неделю, в базе
-- клиентов не появлялся вовсе.

BEGIN;
SELECT plan(29);

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'pgTAP guest crm');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'CRM loc', 'Asia/Jerusalem');

INSERT INTO organization_products (org_id, product) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'reservations');

INSERT INTO table_zones (id, org_id, location_id, name) VALUES
  ('a4000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Терраса');

INSERT INTO tables (id, org_id, location_id, label, zone_id, seats, sort_order) VALUES
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', '1', 'a4000000-0000-4000-8000-000000000001', 4, 1);

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Хостес', 'manager', 'x');

-- Привилегированные RPC требуют staff-сессию (045/090, строгий режим)
INSERT INTO staff_sessions (token, staff_id, org_id, location_id) VALUES
  ('a5000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001');

CREATE FUNCTION pg_temp.as_org() RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    json_build_object('app_metadata', json_build_object(
      'org_id', 'a0000000-0000-4000-8000-000000000001',
      'location_id', 'a1000000-0000-4000-8000-000000000001'))::text, TRUE)
$$;
SELECT pg_temp.as_org();

CREATE FUNCTION pg_temp.book(p_uuid UUID, p_phone TEXT, p_name TEXT,
                             p_at TIMESTAMPTZ, p_status TEXT,
                             p_party INTEGER DEFAULT 2, p_zone UUID DEFAULT NULL,
                             p_note TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE sql AS $$
  INSERT INTO reservations (
    org_id, location_id, client_uuid, customer_name, customer_phone,
    party_size, reserved_at, duration_min, status, zone_id, note)
  VALUES (
    'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
    p_uuid, p_name, p_phone, p_party, p_at, 90, p_status, p_zone, p_note)
  RETURNING guest_id
$$;

-- ── 1. Бронь заводит и находит профиль ───────────────────────
SELECT isnt(
  pg_temp.book('a9000000-0000-4000-8000-000000000001', '0501234567', 'Дана',
               NOW() - INTERVAL '30 days', 'completed', 2,
               'a4000000-0000-4000-8000-000000000001', 'у окна'),
  NULL,
  'бронь с телефоном сразу получает профиль гостя');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guests WHERE org_id = 'a0000000-0000-4000-8000-000000000001'),
  1, 'профиль создан ровно один');

-- Второй визит того же телефона — ТОТ ЖЕ профиль, а не дубль.
SELECT is(
  pg_temp.book('a9000000-0000-4000-8000-000000000002', '050-123-45-67', 'Дана',
               NOW() - INTERVAL '7 days', 'completed', 4,
               'a4000000-0000-4000-8000-000000000001'),
  (SELECT id FROM guests WHERE phone = '0501234567'),
  'телефон в другом формате ведёт к ТОМУ ЖЕ профилю — дублей нет');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guests WHERE org_id = 'a0000000-0000-4000-8000-000000000001'),
  1, 'второй профиль не завёлся');

-- Walk-in без телефона профиля не заводит.
SELECT is(
  pg_temp.book('a9000000-0000-4000-8000-000000000003', '', 'Аноним',
               NOW() + INTERVAL '1 day', 'confirmed'),
  NULL, 'бронь без телефона профиля не создаёт');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guests WHERE org_id = 'a0000000-0000-4000-8000-000000000001'),
  1, 'анонимная бронь базу клиентов не засоряет');

-- ── 2. Ресторанная статистика ────────────────────────────────
SELECT pg_temp.book('a9000000-0000-4000-8000-000000000004', '0501234567', 'Дана',
                    NOW() + INTERVAL '3 days', 'confirmed', 6);
SELECT pg_temp.book('a9000000-0000-4000-8000-000000000005', '0501234567', 'Дана',
                    NOW() - INTERVAL '2 days', 'no_show', 2);
SELECT pg_temp.book('a9000000-0000-4000-8000-000000000006', '0501234567', 'Дана',
                    NOW() - INTERVAL '1 day', 'cancelled', 2);

CREATE FUNCTION pg_temp.stats() RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT guest_reservation_stats((SELECT id FROM guests WHERE phone = '0501234567'))
$$;

SELECT is((pg_temp.stats() ->> 'total')::INTEGER, 5, 'всего броней у гостя — 5');
SELECT is((pg_temp.stats() ->> 'visits')::INTEGER, 2, 'состоявшихся визитов — 2');
SELECT is((pg_temp.stats() ->> 'upcoming')::INTEGER, 1, 'будущих броней — 1');
SELECT is((pg_temp.stats() ->> 'no_shows')::INTEGER, 1, 'неявка учтена');
SELECT is((pg_temp.stats() ->> 'cancelled')::INTEGER, 1, 'отмена учтена');
SELECT is(pg_temp.stats() ->> 'zone', 'Терраса', 'любимая зона выведена из истории');
SELECT ok((pg_temp.stats() ->> 'avg_party')::NUMERIC > 2, 'типичный размер компании посчитан');
SELECT is(
  jsonb_array_length(pg_temp.stats() -> 'notes'), 1,
  'заметки из броней собраны');

-- ── 3. Узнавание гостя при телефонной брони ──────────────────
CREATE FUNCTION pg_temp.hist() RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT guest_history('0501234567')::jsonb
$$;

SELECT is((pg_temp.hist() ->> 'visits')::INTEGER, 2,
  'guest_history отдаёт визиты (прежний ключ 063 сохранён)');
SELECT isnt(pg_temp.hist() ->> 'guest_id', NULL,
  'guest_history отдаёт id профиля — хостес попадает в карточку одним действием');
SELECT is((pg_temp.hist() ->> 'no_shows')::INTEGER, 1,
  'неявки видны прямо на карточке брони');
SELECT is(guest_history('')::jsonb ->> 'visits', '0',
  'пустой телефон не роняет запрос');
SELECT is(guest_history('0509999999')::jsonb ->> 'visits', '0',
  'незнакомый телефон — пустой профиль, а не ошибка');

-- ── 4. Метки и аудит ─────────────────────────────────────────
CREATE FUNCTION pg_temp.guest() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT id FROM guests WHERE phone = '0501234567'
$$;

-- Прямой UPDATE (колоночный грант 114) тоже обязан попадать в аудит,
-- иначе аудит обходится молча и смысла не имеет.
UPDATE guests SET notes = 'аллергия на орехи' WHERE id = pg_temp.guest();

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guest_audit
   WHERE guest_id = pg_temp.guest() AND field = 'notes'),
  1, 'прямая правка заметки попала в аудит');

SELECT is(
  (SELECT new_value FROM guest_audit
   WHERE guest_id = pg_temp.guest() AND field = 'notes'
   ORDER BY changed_at DESC LIMIT 1),
  'аллергия на орехи', 'аудит хранит новое значение');

-- Метки правятся только через RPC: колоночного гранта на них нет.
-- Проверяем ГРАНТ, а не попытку записи: pgTAP исполняется суперпользователем,
-- для которого колоночные гранты не действуют, и прямой UPDATE прошёл бы.
SELECT ok(
  NOT has_column_privilege('authenticated', 'guests', 'tags', 'UPDATE'),
  'клиенту не выдан UPDATE на метки — только через RPC');
SELECT ok(
  has_column_privilege('authenticated', 'guests', 'notes', 'UPDATE'),
  'заметка остаётся прямо редактируемой (грант 114), и её ловит аудит-триггер');

SELECT lives_ok($$
  SELECT set_guest_profile(
    (SELECT id FROM guests WHERE phone = '0501234567'),
    NULL, NULL, ARRAY['VIP', 'постоянный', '  ', 'VIP'],
    'a5000000-0000-4000-8000-000000000001')
$$, 'метки ставятся через set_guest_profile со staff-сессией');

SELECT throws_ok($$
  SELECT set_guest_profile(
    (SELECT id FROM guests WHERE phone = '0501234567'),
    NULL, NULL, ARRAY['без прав'])
$$, 'staff session required',
  'без сессии профиль не правится — право проверяется сервером');

SELECT is(
  (SELECT cardinality(tags) FROM guests WHERE phone = '0501234567'),
  2, 'дубли и пустые метки отброшены');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guest_audit
   WHERE guest_id = pg_temp.guest() AND field = 'tags'),
  1, 'смена меток тоже в аудите');

-- ── 5. Карточка клиента без POS ──────────────────────────────
-- У точки без кассы заказов нет, но ресторанный блок обязан быть полным.
SELECT is(
  jsonb_array_length(get_guest_card(pg_temp.guest()) -> 'orders'), 0,
  'без POS список заказов пуст');
SELECT is(
  (get_guest_card(pg_temp.guest()) -> 'reservations' ->> 'visits')::INTEGER, 2,
  'ресторанный блок карточки полон и без кассы — standalone Reserve цел');

SELECT * FROM finish();
ROLLBACK;
