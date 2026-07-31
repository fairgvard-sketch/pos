-- pgTAP: недельное расписание брони, исключения, lead/horizon (117).
--
-- До 117 движок доступности не был покрыт ничем: ни один тест не проверял
-- reservation_availability, _pick_tables, _table_free или submit_reservation.
-- Здесь закрываются оба контура сразу — и сетка слотов, которую видит гость,
-- и приём заявки, — потому что первопричина продового бага была именно в их
-- расхождении: страница писала «шабат закрыто», а сервер принимал субботние
-- брони и в instant-режиме подтверждал их сам.
--
-- Даты вычисляются от текущего момента (ближайший нужный день недели через
-- 2–9 дней): фиксированные даты протухли бы, выйдя за горизонт записи или
-- уехав в прошлое.

BEGIN;
SELECT plan(42);

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'pgTAP reserve schedule');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'Reserve loc', 'Asia/Jerusalem');

INSERT INTO organization_products (org_id, product) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'reservations');

INSERT INTO table_zones (id, org_id, location_id, name) VALUES
  ('d4000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'Зал');

-- Два стола: двойка и четвёрка, оба объединяемые.
INSERT INTO tables (id, org_id, location_id, label, zone_id, seats, combinable, sort_order) VALUES
  ('d2000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', '1', 'd4000000-0000-4000-8000-000000000001', 2, TRUE, 1),
  ('d2000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', '2', 'd4000000-0000-4000-8000-000000000001', 4, TRUE, 2);

-- ── Хелперы ──────────────────────────────────────────────────
/** Ближайший будущий день недели (0=вс) через 2–9 дней: не «сегодня»,
 *  поэтому lead_min не срезает начало сетки, и внутри горизонта записи. */
CREATE FUNCTION pg_temp.dow(p_dow INT) RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT d::DATE
  FROM generate_series(
    (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE + 2,
    (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE + 9,
    INTERVAL '1 day') d
  WHERE EXTRACT(DOW FROM d) = p_dow
  LIMIT 1
$$;

/** Ближайший день весеннего перевода часов: сутки длиной 23 часа. */
CREATE FUNCTION pg_temp.dst_day() RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT d::DATE
  FROM generate_series(
    (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE + 2,
    (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE + 360,
    INTERVAL '1 day') d
  WHERE EXTRACT(EPOCH FROM (
          ((d::DATE + 1)::TIMESTAMP AT TIME ZONE 'Asia/Jerusalem')
        - (d::DATE::TIMESTAMP AT TIME ZONE 'Asia/Jerusalem'))) = 23 * 3600
  LIMIT 1
$$;

/** settings.reservations из недельной сетки, исключений и доп. флагов. */
CREATE FUNCTION pg_temp.rsv(p_weekly JSONB, p_exceptions JSONB DEFAULT '{}'::jsonb,
                            p_extra JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object('reservations',
    jsonb_build_object(
      'enabled', TRUE,
      'schedule', jsonb_build_object(
        'weekly', p_weekly, 'exceptions', p_exceptions,
        'lead_min', 30, 'horizon_days', 365)
    ) || p_extra)
$$;

/** Одинаковое окно на все семь дней. */
CREATE FUNCTION pg_temp.every_day(p_windows JSONB) RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_object_agg(i::TEXT, p_windows) FROM generate_series(0, 6) i
$$;

CREATE FUNCTION pg_temp.slots(p_date DATE, p_party INTEGER DEFAULT 2)
RETURNS JSONB LANGUAGE sql AS $$
  SELECT (reservation_availability(
    'd1000000-0000-4000-8000-000000000001', p_date, p_party)::jsonb) -> 'slots'
$$;

CREATE FUNCTION pg_temp.slot_count(p_date DATE, p_party INTEGER DEFAULT 2)
RETURNS INTEGER LANGUAGE sql AS $$
  SELECT jsonb_array_length(pg_temp.slots(p_date, p_party))
$$;

/** Число СВОБОДНЫХ слотов: сетка отдаёт все слоты окна с флагом free,
 *  поэтому «мест нет» — это ноль свободных, а не пустая сетка. */
CREATE FUNCTION pg_temp.free_count(p_date DATE, p_party INTEGER DEFAULT 2)
RETURNS INTEGER LANGUAGE sql AS $$
  SELECT COUNT(*)::INTEGER FROM jsonb_array_elements(pg_temp.slots(p_date, p_party)) s
  WHERE (s ->> 'free')::BOOLEAN
$$;

CREATE FUNCTION pg_temp.slot_times(p_date DATE) RETURNS TEXT[] LANGUAGE sql AS $$
  SELECT ARRAY(SELECT s ->> 'time' FROM jsonb_array_elements(pg_temp.slots(p_date)) s)
$$;

CREATE FUNCTION pg_temp.loc_settings() RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT settings FROM locations WHERE id = 'd1000000-0000-4000-8000-000000000001'
$$;

/** Бронируем ли момент «дата + локальное время». */
CREATE FUNCTION pg_temp.bookable(p_date DATE, p_time TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT reservation_bookable_at(
    pg_temp.loc_settings(), 'Asia/Jerusalem',
    (p_date + p_time::TIME) AT TIME ZONE 'Asia/Jerusalem')
$$;

-- ── 1. Нормализация расписания ───────────────────────────────
SELECT is(
  reservation_schedule('{}'::jsonb) -> 'weekly' -> '6',
  '[["07:00", "23:45"]]'::jsonb,
  'без настроек — прежние дефолты 07:00–23:45 на каждый день'
);
SELECT is(
  reservation_schedule('{"reservations":{"open":"08:00","close":"20:00"}}'::jsonb) -> 'weekly' -> '6',
  '[["08:00", "20:00"]]'::jsonb,
  'legacy open/close разворачивается в семь одинаковых дней'
);
SELECT is(
  (reservation_schedule('{}'::jsonb) ->> 'lead_min')::INTEGER, 30,
  'дефолтный lead_min — прежние 30 минут'
);
SELECT is(
  (reservation_schedule('{}'::jsonb) ->> 'horizon_days')::INTEGER, 30,
  'дефолтный горизонт — прежние 30 дней'
);
SELECT is(
  (reservation_schedule('{"reservations":{"schedule":{"weekly":{},"lead_min":"мусор"}}}'::jsonb)
     ->> 'lead_min')::INTEGER, 30,
  'битое число в настройках даёт дефолт, а не исключение'
);

-- ── 2. Закрытый день: продовый случай «Булочки» ──────────────
-- вс–чт 08–20, пт 08–15, сб закрыто.
UPDATE locations SET settings = pg_temp.rsv(
  '{"0":[["08:00","20:00"]],"1":[["08:00","20:00"]],"2":[["08:00","20:00"]],
    "3":[["08:00","20:00"]],"4":[["08:00","20:00"]],
    "5":[["08:00","15:00"]],"6":[]}'::jsonb)
WHERE id = 'd1000000-0000-4000-8000-000000000001';

SELECT ok(NOT pg_temp.bookable(pg_temp.dow(6), '10:00'),
  'суббота закрыта — предикат отказывает');
SELECT ok(pg_temp.bookable(pg_temp.dow(0), '10:00'),
  'воскресенье открыто — предикат пропускает');
SELECT ok(NOT pg_temp.bookable(pg_temp.dow(5), '16:00'),
  'пятница после 15:00 закрыта — предикат отказывает');
SELECT ok(pg_temp.bookable(pg_temp.dow(0), '20:00'),
  'верхняя граница окна включительна (сохраняем поведение 059)');

-- Сетка обязана согласовываться с предикатом — иначе возвращается тот самый
-- баг: гостю показали слот, которого сервер не примет (или наоборот).
SELECT is(pg_temp.slot_count(pg_temp.dow(6)), 0,
  'сетка субботы пуста — закрытый день нигде не бронируем');
SELECT is(pg_temp.slot_count(pg_temp.dow(0)), 49,
  'воскресенье 08:00–20:00 шагом 15 мин — 49 слотов');
SELECT is(pg_temp.slot_count(pg_temp.dow(5)), 29,
  'пятница 08:00–15:00 — 29 слотов, а не полный день');

SELECT throws_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000001',
    'Гость', '0501234567', 2,
    (pg_temp.dow(6) + TIME '10:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'outside_hours', 'заявка на закрытую субботу отклонена сервером');

SELECT lives_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000002',
    'Гость', '0501234567', 2,
    (pg_temp.dow(0) + TIME '10:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'заявка на открытое воскресенье принимается');

-- ── 3. Разрыв смен (обед и ужин) ─────────────────────────────
UPDATE locations SET settings = pg_temp.rsv(
  pg_temp.every_day('[["12:00","15:00"],["18:00","22:00"]]'::jsonb))
WHERE id = 'd1000000-0000-4000-8000-000000000001';

SELECT is(pg_temp.slot_count(pg_temp.dow(0)), 30,
  'две смены 12–15 и 18–22 дают 13+17 слотов, промежуток не предлагается');
SELECT ok(NOT ('16:00' = ANY (pg_temp.slot_times(pg_temp.dow(0)))),
  'время между сменами в сетке отсутствует');
SELECT ok(
  '12:00' = ANY (pg_temp.slot_times(pg_temp.dow(0)))
  AND '22:00' = ANY (pg_temp.slot_times(pg_temp.dow(0))),
  'границы обеих смен предлагаются');
SELECT throws_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000003',
    'Гость', '0501234567', 2,
    (pg_temp.dow(0) + TIME '16:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'outside_hours', 'заявка в перерыв между сменами отклонена');

-- ── 4. Исключения по дате ────────────────────────────────────
-- Воскресенье закрыто исключением, понедельник — особые часы 18:00–23:00.
UPDATE locations SET settings = pg_temp.rsv(
  pg_temp.every_day('[["08:00","20:00"]]'::jsonb),
  jsonb_build_object(
    to_char(pg_temp.dow(0), 'YYYY-MM-DD'), '[]'::jsonb,
    to_char(pg_temp.dow(1), 'YYYY-MM-DD'), '[["18:00","23:00"]]'::jsonb))
WHERE id = 'd1000000-0000-4000-8000-000000000001';

SELECT is(pg_temp.slot_count(pg_temp.dow(0)), 0,
  'исключение-закрытие перекрывает открытый недельный день');
SELECT is(pg_temp.slot_count(pg_temp.dow(1)), 21,
  'исключение с особыми часами ЗАМЕЩАЕТ недельное окно, а не дополняет');
SELECT is(pg_temp.slot_count(pg_temp.dow(2)), 49,
  'дата без исключения живёт по неделе');
SELECT throws_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000004',
    'Гость', '0501234567', 2,
    (pg_temp.dow(1) + TIME '12:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'outside_hours', 'время вне особых часов исключения отклонено');

-- ── 5. Окно через полночь ────────────────────────────────────
UPDATE locations SET settings = pg_temp.rsv(
  pg_temp.every_day('[["20:00","02:00"]]'::jsonb))
WHERE id = 'd1000000-0000-4000-8000-000000000001';

SELECT ok(pg_temp.bookable(pg_temp.dow(0), '23:00'),
  'ночная смена: 23:00 воскресенья бронируемо');
SELECT ok(pg_temp.bookable(pg_temp.dow(0) + 1, '01:00'),
  'ночная смена: 01:00 понедельника — хвост воскресного окна');
SELECT is(pg_temp.slot_count(pg_temp.dow(0)), 25,
  'ночное окно 20:00–02:00 даёт 25 слотов, включая заполночные');
-- Заполночный слот обязан нести абсолютный момент СЛЕДУЮЩИХ суток: по одной
-- метке 'HH:MM' клиент собрал бы время на 24 часа раньше.
SELECT is(
  (SELECT (s ->> 'at')::TIMESTAMPTZ FROM jsonb_array_elements(pg_temp.slots(pg_temp.dow(0))) s
   WHERE s ->> 'time' = '01:00'),
  ((pg_temp.dow(0) + 1) + TIME '01:00') AT TIME ZONE 'Asia/Jerusalem',
  'слот 01:00 несёт момент следующих суток (иначе клиент ошибётся на 24 часа)');

-- ── 6. Переход на летнее время, Asia/Jerusalem ───────────────
-- Весной 02:00 → 03:00: локальных 02:00–02:45 не существует, и Postgres
-- отображает их в ТЕ ЖЕ моменты, что 03:00–03:45. Такие слоты обязаны
-- исчезнуть из сетки, иначе гость выбирает 02:00, а бронируется 03:00.
UPDATE locations SET settings = pg_temp.rsv(
  pg_temp.every_day('[["00:00","06:00"]]'::jsonb))
WHERE id = 'd1000000-0000-4000-8000-000000000001';

SELECT ok(pg_temp.dst_day() IS NOT NULL,
  'в горизонте есть день весеннего перевода часов (иначе тест бессмысленен)');
SELECT is(pg_temp.slot_count(pg_temp.dst_day()), 21,
  'DST: четыре несуществующих слота 02:00–02:45 выброшены из сетки (25 − 4)');
SELECT ok(
  NOT ('02:00' = ANY (pg_temp.slot_times(pg_temp.dst_day()))),
  'DST: несуществующего 02:00 в сетке нет');
SELECT is(
  (SELECT COUNT(DISTINCT (s ->> 'at')) FROM jsonb_array_elements(pg_temp.slots(pg_temp.dst_day())) s)::INTEGER,
  pg_temp.slot_count(pg_temp.dst_day()),
  'DST: все моменты сетки различны — двух слотов на один момент нет');

-- ── 7. Вместимость, буфер, объединение сохранены ─────────────
UPDATE locations SET settings = pg_temp.rsv(
  pg_temp.every_day('[["08:00","20:00"]]'::jsonb), '{}'::jsonb,
  '{"instant":true,"duration_min":90,"buffer_min":30,"max_party":10}'::jsonb)
WHERE id = 'd1000000-0000-4000-8000-000000000001';

-- Компания из 6 не помещается ни в один стол, объединение выключено.
SELECT throws_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000005',
    'Гость', '0501234567', 6,
    (pg_temp.dow(0) + TIME '12:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'full_slot', 'вместимость: 6 гостей без объединения — мест нет');

-- С объединением 2+4 набирают шестерых.
UPDATE locations SET settings = jsonb_set(settings, '{reservations,combine}', 'true'::jsonb)
WHERE id = 'd1000000-0000-4000-8000-000000000001';

SELECT lives_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000006',
    'Гость', '0501234567', 6,
    (pg_temp.dow(0) + TIME '12:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'объединение столов: 2+4 вмещают шестерых');

-- Дополнительный стол объединения обязан быть занят. До 117 он оставался
-- свободным (занятость считалась только по table_id), и вторая компания
-- садилась за тот же стол без единой ошибки.
SELECT throws_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000010',
    'Гость', '0507654321', 2,
    (pg_temp.dow(0) + TIME '12:30') AT TIME ZONE 'Asia/Jerusalem')
$$, 'full_slot', 'hold_table_ids: стол из объединения занят, а не свободен');

-- Буфер 30 мин: визит до 13:30, зазор до 13:45 — всего 15 минут.
SELECT throws_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000007',
    'Гость', '0507654321', 2,
    (pg_temp.dow(0) + TIME '13:45') AT TIME ZONE 'Asia/Jerusalem')
$$, 'full_slot', 'буфер уборки: зазор меньше буфера — стол ещё занят');

-- Ровно буфер (визит до 13:30, старт 14:00) — уже можно.
SELECT lives_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000008',
    'Гость', '0507654321', 2,
    (pg_temp.dow(0) + TIME '14:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'после длительности и полного буфера стол снова бронируем');

-- Сетка и приём согласованы и по занятости: слот, который сетка пометила
-- занятым, сервер обязан отклонить (и наоборот).
SELECT is(
  (SELECT s ->> 'free' FROM jsonb_array_elements(pg_temp.slots(pg_temp.dow(0), 6)) s
   WHERE s ->> 'time' = '12:00'),
  'false',
  'сетка показывает занятый слот занятым — расхождения с сервером нет');

-- ── 8. Совместимость: точка без schedule ─────────────────────
-- Организация, до которой бэкфилл не дошёл, обязана вести себя как до 117.
UPDATE locations
SET settings = '{"reservations":{"enabled":true,"open":"08:00","close":"20:00"}}'::jsonb
WHERE id = 'd1000000-0000-4000-8000-000000000001';

SELECT is(pg_temp.slot_count(pg_temp.dow(6)), 49,
  'без schedule работает legacy open/close — суббота как раньше открыта');
SELECT lives_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000009',
    'Гость', '0509999999', 2,
    (pg_temp.dow(6) + TIME '10:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'без schedule заявка проходит по прежним правилам (обратная совместимость)');

-- ── 9. Заблокированные столы и одновременная бронь ───────────
-- Механизмы, на которых держится «две брони не займут один стол».
UPDATE locations SET settings = pg_temp.rsv(
  pg_temp.every_day('[["08:00","20:00"]]'::jsonb), '{}'::jsonb,
  '{"instant":true,"duration_min":90,"buffer_min":0,"max_party":10}'::jsonb)
WHERE id = 'd1000000-0000-4000-8000-000000000001';

-- Выключенный стол не предлагается и не бронируется.
UPDATE tables SET is_active = FALSE
WHERE location_id = 'd1000000-0000-4000-8000-000000000001';

SELECT is(pg_temp.free_count(pg_temp.dow(2)), 0,
  'все столы выключены — свободных слотов нет');
SELECT throws_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000021',
    'Гость', '0501111111', 2,
    (pg_temp.dow(2) + TIME '12:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'full_slot', 'заявка на выключенный стол отклонена');

UPDATE tables SET is_active = TRUE
WHERE id = 'd2000000-0000-4000-8000-000000000001';

SELECT lives_ok($$
  SELECT submit_reservation(
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000022',
    'Гость', '0501111111', 2,
    (pg_temp.dow(2) + TIME '12:00') AT TIME ZONE 'Asia/Jerusalem')
$$, 'включённый стол снова бронируется');

-- Гонка двух одновременных гостей: инстант-подбор у обоих мог вернуть один
-- и тот же стол, потому что чужая транзакция ещё не видна. Последним словом
-- остаётся EXCLUDE-констрейнт — он и превращает гонку в честный full_slot
-- вместо второй брони на занятый стол.
SELECT throws_ok($$
  INSERT INTO reservations (
    org_id, location_id, client_uuid, customer_name, customer_phone,
    party_size, reserved_at, duration_min, table_id, status)
  VALUES (
    'd0000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    'd9000000-0000-4000-8000-000000000023',
    'Гонка', '0502222222', 2,
    (pg_temp.dow(2) + TIME '12:30') AT TIME ZONE 'Asia/Jerusalem',
    90, 'd2000000-0000-4000-8000-000000000001', 'confirmed')
$$, '23P01', NULL, 'EXCLUDE: вторая живая бронь на тот же стол в том же окне невозможна');

SELECT * FROM finish();
ROLLBACK;
