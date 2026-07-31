-- ============================================================
-- 117 RESERVATION SCHEDULE — недельное расписание брони, исключения,
-- lead time и горизонт записи. Единый источник истины.
--
-- МОТИВ (release blocker). До 117 у брони было ДВА независимых источника
-- часов, ничем не связанных между собой:
--   * settings.reservations.hours — свободный текст, который видит гость;
--   * settings.reservations.open/close — ОДНА пара 'HH:MM' на все семь
--     дней, и только она проверялась сервером (059/072/105) и клиентом.
-- Дня недели в enforcement-модели не было вообще. На проде это давало
-- ровно то, что и должно было дать: страница «Булочки» писала гостю
-- «שבת · סגור», а reservation_availability отдавала на субботу 49
-- свободных слотов 08:00–20:00, и при instant=true они подтверждались
-- автоматически — визит никто из персонала не видел до самого прихода
-- гостя.
--
-- МОДЕЛЬ. settings.reservations.schedule — канонический объект:
--
--   {
--     "weekly": { "0": [["08:00","20:00"]],        -- вс: одно окно
--                 "2": [["12:00","15:00"],
--                       ["18:00","23:00"]],        -- вт: обед и ужин
--                 "6": [] },                       -- сб: закрыто
--     "exceptions": { "2026-09-21": [],             -- закрыто (праздник)
--                     "2026-10-05": [["18:00","23:59"]] },  -- особые часы
--     "lead_min": 30,        -- минимальный запас до визита, мин
--     "horizon_days": 30     -- насколько вперёд можно бронировать
--   }
--
-- Формат окон — тот же, что у расписания онлайн-заказов (101/112):
-- ключ дня = EXTRACT(DOW) как текст, окно = ["HH:MM","HH:MM"], пустой
-- массив = день закрыт, ["20:00","02:00"] = окно через полночь. Это
-- сознательно НЕ третий диалект: редакторы и ядра похожи, а форматы
-- совпадают.
--
-- Отличия семантики от online_orders (осознанные, 112 не трогаем):
--   1) Граница окна ВКЛЮЧИТЕЛЬНА с обеих сторон. У заказов окно
--      полуоткрытое (в 20:00 магазин уже закрыт), у брони 059 всегда
--      проверял `v_local > v_close`, а цикл слотов шёл `WHILE m <= to`,
--      то есть 20:00 был последним предлагаемым временем. Сохраняем —
--      иначе у всех существующих точек молча пропал бы последний слот.
--   2) Окно через полночь принадлежит дате, в которую ОНАЧАЛОСЬ.
--      online_hours_open_at считает ночную дугу открытой и «сегодня», и
--      «вчера»; для брони это дало бы фантомный слот (вс 01:00 при окне
--      вс 20:00–02:00, хотя ночь принадлежит воскресенью→понедельнику).
--
-- ИСКЛЮЧЕНИЯ. Ключ даты (локальная дата точки, 'YYYY-MM-DD') ПОЛНОСТЬЮ
-- заменяет недельные окна этого дня: [] = закрыто, непустой массив =
-- особые часы. Отсутствие ключа = действует неделя.
--
-- СОВМЕСТИМОСТЬ. Если schedule нет или он битый — работает прежняя
-- модель open/close (fail-forward: точка, до которой не дошёл бэкфилл,
-- ведёт себя ровно как раньше, а не закрывается молча).
--
-- БЭКФИЛЛ. Истина для существующих точек — ТЕКСТ hours (решение
-- владельца): именно он показывался гостю и именно он описывает реальный
-- график. Парсер разбирает ивритские/русские/английские дни и диапазоны;
-- точка, чей текст разобрать не удалось или который покрывает не все семь
-- дней, получает расписание из open/close и попадает в NOTICE для ручной
-- проверки. Ничего не удаляется: hours и open/close остаются в settings.
--
-- ⚠️ ТРЕБУЕТ 105 (submit_reservation v5, reservation_availability v3
--    с capability-гейтом).
-- ============================================================

-- ── 1. Нормализованное расписание ────────────────────────────
/**
 * settings → канонический schedule. Отсутствие/битость ключа schedule
 * означает legacy-режим: семь одинаковых окон из open/close (а если и их
 * нет — прежние дефолты 07:00–23:45), пустые исключения и прежние
 * границы 30 минут / 30 дней.
 */
CREATE OR REPLACE FUNCTION reservation_schedule(p_settings JSONB)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_rsv   JSONB := p_settings -> 'reservations';
  v_sch   JSONB := v_rsv -> 'schedule';
  v_src   JSONB;
  v_open  TEXT;
  v_close TEXT;
  v_week  JSONB := '{}'::jsonb;
  i       INTEGER;
BEGIN
  -- Числа читаются регуляркой, а не приведением типа: битое значение в
  -- настройках обязано дать дефолт, а не исключение посреди публичного
  -- запроса. Поэтому в функции нет EXCEPTION-обработчика — бросать
  -- нечему, и IMMUTABLE остаётся честным.
  v_src := COALESCE(v_sch, v_rsv, '{}'::jsonb);

  IF jsonb_typeof(v_sch) = 'object' AND jsonb_typeof(v_sch -> 'weekly') = 'object' THEN
    v_week := v_sch -> 'weekly';
  ELSE
    -- Legacy: одна пара open/close на все семь дней
    v_open  := COALESCE(NULLIF(v_rsv ->> 'open', ''), '07:00');
    v_close := COALESCE(NULLIF(v_rsv ->> 'close', ''), '23:45');
    FOR i IN 0..6 LOOP
      v_week := v_week || jsonb_build_object(
        i::TEXT, jsonb_build_array(jsonb_build_array(v_open, v_close)));
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'weekly', v_week,
    'exceptions', CASE WHEN jsonb_typeof(v_sch -> 'exceptions') = 'object'
                       THEN v_sch -> 'exceptions' ELSE '{}'::jsonb END,
    'lead_min', CASE WHEN v_src ->> 'lead_min' ~ '^\d{1,5}$'
                     THEN LEAST(43200, (v_src ->> 'lead_min')::INTEGER) ELSE 30 END,
    'horizon_days', CASE WHEN v_src ->> 'horizon_days' ~ '^\d{1,3}$'
                         THEN GREATEST(1, LEAST(365, (v_src ->> 'horizon_days')::INTEGER))
                         ELSE 30 END
  );
END $$;

REVOKE ALL ON FUNCTION reservation_schedule(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservation_schedule(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION reservation_schedule(JSONB) IS
  'Каноническое расписание брони: weekly/exceptions/lead_min/horizon_days. Без ключа schedule разворачивает legacy open/close в семь одинаковых дней.';

-- ── 2. Окна конкретной локальной даты ────────────────────────
/**
 * Окна брони на локальную дату точки. Исключение по дате ПОЛНОСТЬЮ
 * заменяет неделю (в том числе пустым массивом = закрыто). День, не
 * описанный в weekly, считается закрытым — как у расписания заказов.
 */
CREATE OR REPLACE FUNCTION reservation_day_windows(p_schedule JSONB, p_date DATE)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_exc  JSONB := p_schedule -> 'exceptions' -> to_char(p_date, 'YYYY-MM-DD');
  v_week JSONB;
BEGIN
  IF v_exc IS NOT NULL AND jsonb_typeof(v_exc) = 'array' THEN
    RETURN v_exc;
  END IF;
  v_week := p_schedule -> 'weekly' -> (EXTRACT(DOW FROM p_date)::INT::TEXT);
  IF v_week IS NULL OR jsonb_typeof(v_week) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN v_week;
END $$;

REVOKE ALL ON FUNCTION reservation_day_windows(JSONB, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservation_day_windows(JSONB, DATE) TO authenticated, service_role;

COMMENT ON FUNCTION reservation_day_windows(JSONB, DATE) IS
  'Окна брони на локальную дату: исключение по дате замещает недельное правило целиком; неописанный день закрыт.';

-- ── 3. Единый предикат «эта минута бронируема» ───────────────
/**
 * ЕДИНСТВЕННОЕ место, где решается «попадает ли момент в часы брони».
 * И сетка слотов, и приём заявки обязаны спрашивать только его — иначе
 * расхождение показанного и принимаемого возвращается.
 *
 * Границы окна включительны с обеих сторон (см. шапку). Окно через
 * полночь принадлежит дате начала, поэтому момент после полуночи
 * сверяется с окнами ПРЕДЫДУЩЕЙ локальной даты.
 */
CREATE OR REPLACE FUNCTION reservation_bookable_at(
  p_settings JSONB,
  p_tz       TEXT,
  p_at       TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_sch   JSONB := reservation_schedule(p_settings);
  v_local TIMESTAMP;
  v_date  DATE;
  v_time  TIME;
  v_win   JSONB;
  v_from  TIME;
  v_to    TIME;
BEGIN
  v_local := p_at AT TIME ZONE COALESCE(NULLIF(p_tz, ''), 'Asia/Jerusalem');
  v_date  := v_local::DATE;
  v_time  := v_local::TIME;

  -- Окна самой даты
  FOR v_win IN SELECT * FROM jsonb_array_elements(reservation_day_windows(v_sch, v_date)) LOOP
    BEGIN
      v_from := (v_win ->> 0)::TIME;
      v_to   := (v_win ->> 1)::TIME;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;  -- битое окно пропускаем, а не роняем заявку
    END;
    IF v_from <= v_to THEN
      IF v_time >= v_from AND v_time <= v_to THEN RETURN TRUE; END IF;
    ELSE
      IF v_time >= v_from THEN RETURN TRUE; END IF;  -- дуга до полуночи
    END IF;
  END LOOP;

  -- Ночной хвост предыдущей даты
  FOR v_win IN SELECT * FROM jsonb_array_elements(reservation_day_windows(v_sch, v_date - 1)) LOOP
    BEGIN
      v_from := (v_win ->> 0)::TIME;
      v_to   := (v_win ->> 1)::TIME;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
    IF v_from > v_to AND v_time <= v_to THEN RETURN TRUE; END IF;
  END LOOP;

  RETURN FALSE;
END $$;

REVOKE ALL ON FUNCTION reservation_bookable_at(JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservation_bookable_at(JSONB, TEXT, TIMESTAMPTZ)
  TO authenticated, service_role;

COMMENT ON FUNCTION reservation_bookable_at(JSONB, TEXT, TIMESTAMPTZ) IS
  'Единый предикат часов брони: попадает ли момент в окно расписания точки (границы включительны, окно через полночь принадлежит дате начала).';

-- ============================================================
-- 3a. _table_free v2 — объединённые столы наконец занимают места.
--
-- НАЙДЕНО ТЕСТАМИ 117 (дефект живёт с 063). Объединённая бронь пишет
-- основной стол в table_id, а остальные — в массив hold_table_ids. Но
-- занятость везде считалась ТОЛЬКО по table_id: и здесь, и в
-- EXCLUDE-констрейнте. Значит бронь «2+4 на шестерых» реально держала
-- один стол, а второй оставался свободным для любого следующего гостя —
-- две компании садились за один стол, причём молча: ни ошибки, ни
-- конфликта, оба подтверждения выглядели штатно.
--
-- Условие расширено на массив. Гейт доступности (и сетка, и приём) теперь
-- видит все столы объединения.
--
-- ⚠️ ОСТАТОЧНЫЙ РИСК, осознанный: EXCLUDE-констрейнт по-прежнему покрывает
-- только table_id — по массиву gist-исключение не строится без переделки
-- модели (отдельная таблица «бронь ↔ стол»). Гонка двух ОДНОВРЕМЕННЫХ
-- объединённых броней на общий дополнительный стол остаётся возможной;
-- одиночные брони и пара «объединённая + одиночная» закрыты проверкой
-- ниже. Переделка модели — Phase 3 (таймлайн всё равно требует явных
-- связей брони со столами).
-- ============================================================
CREATE OR REPLACE FUNCTION _table_free(
  p_table_id UUID,
  p_at       TIMESTAMPTZ,
  p_dur_min  INTEGER,
  p_buffer   INTEGER DEFAULT 0,
  p_exclude  UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM reservations r
    WHERE (r.table_id = p_table_id OR p_table_id = ANY (r.hold_table_ids))
      AND r.status IN ('new', 'confirmed')
      AND (p_exclude IS NULL OR r.id <> p_exclude)
      AND r.occupancy && tstzrange(
            p_at - make_interval(mins => p_buffer),
            p_at + make_interval(mins => p_dur_min + p_buffer),
            '[)')
  );
$$;

REVOKE ALL ON FUNCTION _table_free(UUID, TIMESTAMPTZ, INTEGER, INTEGER, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _table_free(UUID, TIMESTAMPTZ, INTEGER, INTEGER, UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION _table_free(UUID, TIMESTAMPTZ, INTEGER, INTEGER, UUID) IS
  'Свободен ли стол в окне визита с буфером. С 117 учитывает и hold_table_ids — столы, добавленные объединением.';

-- ============================================================
-- 4. reservation_availability v4 — сетка слотов по расписанию.
--
-- Тело 105 с одной заменой: вместо единственного окна [open..close]
-- обходятся ВСЕ окна запрошенной даты (обед/ужин — разные окна), а
-- окно через полночь продолжается за 24:00, поэтому ночные слоты
-- показываются в дне своей смены. Границы lead/horizon берутся из
-- расписания. Всё остальное — зона, вместимость, буфер, объединение,
-- capability-гейт — без изменений.
-- ============================================================
CREATE OR REPLACE FUNCTION reservation_availability(
  p_location_id UUID,
  p_date        DATE,
  p_party       INTEGER,
  p_zone_id     UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_sch      JSONB;
  v_tz       TEXT;
  v_step     INTEGER := 15;
  v_dur      INTEGER := 90;
  v_buffer   INTEGER := 0;
  v_combine  BOOLEAN := FALSE;
  v_min_at   TIMESTAMPTZ;
  v_max_at   TIMESTAMPTZ;
  v_slots    JSONB := '[]'::jsonb;
  v_seen     TEXT[] := '{}';
  v_win      JSONB;
  v_from     INTEGER;
  v_to       INTEGER;
  v_m        INTEGER;
  v_label    TEXT;
  v_at       TIMESTAMPTZ;
  v_free     BOOLEAN;
BEGIN
  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;
  -- Capability-гейт (105): live-доступность — часть публичной брони.
  IF NOT org_has_capability(v_loc.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  v_tz  := COALESCE(NULLIF(v_loc.timezone, ''), 'Asia/Jerusalem');
  v_rsv := v_loc.settings -> 'reservations';

  IF NOT COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;
  IF p_party IS NULL OR p_party < 1 OR p_party > 200 THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  v_sch     := reservation_schedule(v_loc.settings);
  v_step    := GREATEST(5, COALESCE((v_rsv ->> 'slot_min')::INTEGER, v_step));
  v_dur     := COALESCE((v_rsv ->> 'duration_min')::INTEGER, v_dur);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, v_buffer);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_min_at  := NOW() + make_interval(mins => (v_sch ->> 'lead_min')::INTEGER);
  v_max_at  := NOW() + make_interval(days => (v_sch ->> 'horizon_days')::INTEGER);

  FOR v_win IN SELECT * FROM jsonb_array_elements(reservation_day_windows(v_sch, p_date)) LOOP
    BEGIN
      v_from := EXTRACT(HOUR FROM (v_win ->> 0)::TIME)::INT * 60
                + EXTRACT(MINUTE FROM (v_win ->> 0)::TIME)::INT;
      v_to   := EXTRACT(HOUR FROM (v_win ->> 1)::TIME)::INT * 60
                + EXTRACT(MINUTE FROM (v_win ->> 1)::TIME)::INT;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;  -- битое окно не роняет страницу
    END;
    -- Окно через полночь продолжается в следующие сутки: 20:00–02:00 →
    -- минуты 1200..1560. Итерация по минутам, а не по TIME (баг 063:
    -- '23:45' + 15 мин заворачивается в '00:00' и цикл не кончается).
    IF v_to < v_from THEN
      v_to := v_to + 1440;
    END IF;

    v_m := v_from;
    WHILE v_m <= v_to LOOP
      v_label := to_char(make_time((v_m / 60) % 24, v_m % 60, 0), 'HH24:MI');
      -- Локальное время слота → момент в UTC для сравнения с бронями
      v_at := (p_date + make_interval(mins => v_m)) AT TIME ZONE v_tz;

      -- Несуществующее локальное время (весенний перевод часов) отбрасываем.
      -- В Asia/Jerusalem 02:00 → 03:00: Postgres отображает 02:00 и 03:00 в
      -- ОДИН И ТОТ ЖЕ момент, поэтому без этой проверки сетка предлагала бы
      -- четыре фантомных слота 02:00–02:45, каждый из которых молча бронирует
      -- 03:00–03:45. Обратное преобразование не совпало — времени нет.
      IF (v_at AT TIME ZONE v_tz)::TIME <> v_label::TIME THEN
        v_m := v_m + v_step;
        CONTINUE;
      END IF;

      IF v_at >= v_min_at AND v_at <= v_max_at AND NOT (v_label = ANY (v_seen)) THEN
        v_seen := array_append(v_seen, v_label);
        v_free := array_length(
          _pick_tables(p_location_id, p_party, v_at, v_dur, v_buffer, v_combine, NULL, p_zone_id), 1
        ) IS NOT NULL;
        -- `at` — абсолютный момент слота. Метка 'HH:MM' сама по себе
        -- неоднозначна у ночной смены: слот «01:00» окна 20:00–02:00
        -- принадлежит СЛЕДУЮЩИМ суткам, и клиент, собирая время как
        -- «выбранная дата + метка», отправил бы момент на 24 часа раньше.
        -- Клиент обязан отправлять `at`, а метку показывать.
        v_slots := v_slots || jsonb_build_object(
          'time', v_label, 'free', v_free, 'at', v_at);
      END IF;
      v_m := v_m + v_step;
    END LOOP;
  END LOOP;

  RETURN json_build_object(
    'date', p_date,
    'slot_min', v_step,
    'slots', v_slots
  );
END $$;

REVOKE ALL ON FUNCTION reservation_availability(UUID, DATE, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reservation_availability(UUID, DATE, INTEGER, UUID) TO service_role;

-- ============================================================
-- 5. submit_reservation v6 — приём заявки по тому же расписанию.
--
-- Тело 105 дословно; изменены ровно две вещи:
--   а) проверка часов переведена с пары open/close на общий предикат
--      reservation_bookable_at — код ошибки прежний, 'outside_hours';
--   б) зашитые «+30 минут / +30 дней» заменены на lead_min/horizon_days
--      расписания (дефолты те же, поведение ненастроенных точек прежнее).
--
-- Пересчёт доступности в instant-режиме уже был серверным (_pick_tables
-- на p_reserved_at, а не на присланный клиентом слот) и остаётся им:
-- клиенту здесь не доверяют ничего, кроме времени, которое тут же
-- перепроверяется по расписанию и по занятости столов, а гонку двух
-- гостей ловит EXCLUDE-констрейнт → 'full_slot'.
-- ============================================================
CREATE OR REPLACE FUNCTION submit_reservation(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_reserved_at TIMESTAMPTZ,
  p_note        TEXT DEFAULT NULL,
  p_zone_id     UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_sch      JSONB;
  v_existing reservations%ROWTYPE;
  v_name     TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone    TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note     TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_max      INTEGER;
  v_instant  BOOLEAN;
  v_combine  BOOLEAN;
  v_dur      INTEGER;
  v_buffer   INTEGER;
  v_tables   UUID[];
  v_table    UUID := NULL;
  v_hold     UUID[] := '{}';
  v_status   TEXT := 'new';
  v_dep_amt  INTEGER := 0;
  v_dep_st   TEXT := 'none';
  v_id       UUID;
BEGIN
  -- Идемпотентность
  SELECT * INTO v_existing FROM reservations WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('reservation_id', v_existing.id, 'duplicate', TRUE,
                             'status', v_existing.status);
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  -- Capability-гейт (105): публичная бронь — public_reservations.
  -- ДО settings-тумблера: module_disabled ≠ disabled.
  IF NOT org_has_capability(v_loc.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  v_rsv := v_loc.settings -> 'reservations';

  IF NOT COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;
  v_max := GREATEST(1, LEAST(200, COALESCE((v_rsv ->> 'max_party')::INTEGER, 20)));
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > v_max THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;

  -- (б) Окно записи из расписания (117): дефолты 30 мин / 30 дней —
  -- ровно прежние зашитые границы.
  v_sch := reservation_schedule(v_loc.settings);
  IF p_reserved_at IS NULL
     OR p_reserved_at < NOW() + make_interval(mins => (v_sch ->> 'lead_min')::INTEGER)
     OR p_reserved_at > NOW() + make_interval(days => (v_sch ->> 'horizon_days')::INTEGER) THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;
  -- Зона (072): пожелание гостя; обязана быть живой зоной этой точки
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  -- (а) Часы приёма (059 → 117): один предикат с сеткой слотов.
  IF NOT reservation_bookable_at(v_loc.settings, v_loc.timezone, p_reserved_at) THEN
    RAISE EXCEPTION 'outside_hours';
  END IF;

  -- Анти-спам
  IF (SELECT COUNT(*) FROM reservations
      WHERE customer_phone = v_phone AND created_at > NOW() - INTERVAL '15 minutes') >= 3 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT COUNT(*) FROM reservations
      WHERE location_id = p_location_id AND status = 'new') >= 30 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  v_instant := COALESCE((v_rsv ->> 'instant')::BOOLEAN, FALSE);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_dur     := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);

  -- Депозит-плейсхолдер (без оплаты). UI выключен с 117, но данные и
  -- логика сохранены: точка с уже проставленным флагом не меняет поведение.
  IF COALESCE((v_rsv ->> 'deposit_required')::BOOLEAN, FALSE)
     AND p_party_size >= COALESCE((v_rsv ->> 'deposit_from_party')::INTEGER, 1) THEN
    v_dep_amt := GREATEST(0, COALESCE((v_rsv ->> 'deposit_amount')::INTEGER, 0));
    IF v_dep_amt > 0 THEN
      v_dep_st := 'required';
    END IF;
  END IF;

  IF v_instant THEN
    -- Подбор стола(ов) под окно визита — в выбранной зоне, если задана
    v_tables := _pick_tables(p_location_id, p_party_size, p_reserved_at, v_dur,
                             v_buffer, v_combine, NULL, p_zone_id);
    IF array_length(v_tables, 1) IS NULL THEN
      RAISE EXCEPTION 'full_slot';
    END IF;
    v_table  := v_tables[1];
    v_hold   := v_tables[2:array_length(v_tables, 1)];  -- пусто для одиночного
    v_status := 'confirmed';
  END IF;

  -- INSERT. EXCLUDE-констрейнт ловит гонку (два инстант-гостя на один стол):
  -- при конфликте — отдаём full_slot, а не 500.
  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, note, duration_min, table_id, hold_table_ids,
      auto, status, decided_at, deposit_amount, deposit_status, zone_id)
    VALUES (
      v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
      p_party_size, p_reserved_at, v_note, v_dur, v_table, COALESCE(v_hold, '{}'),
      v_instant, v_status, CASE WHEN v_instant THEN NOW() END, v_dep_amt, v_dep_st,
      p_zone_id)
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'full_slot';
  END;

  RETURN json_build_object(
    'reservation_id', v_id,
    'duplicate', FALSE,
    'status', v_status,
    'deposit_status', v_dep_st,
    'deposit_amount', v_dep_amt
  );
END $$;

REVOKE ALL ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID) TO service_role;

-- ============================================================
-- 6. Бэкфилл: текст hours → недельное расписание.
--
-- Разбираем то, что владелец писал ГОСТЮ, потому что именно это —
-- фактический график заведения. Формат строки: «<дни> · <время>»,
-- как в плейсхолдере настроек и как на проде:
--     א׳ – ה׳ · 08:00 – 20:00
--     שישי · 08:00 – 15:00
--     שבת · סגור
-- Поддержаны иврит (буквы с герешем и без, полные названия), русский и
-- английский; диапазон дней через любой дефис, перечисление через запятую;
-- «закрыто» словом. Несколько интервалов времени в строке через запятую
-- дают несколько окон (обед и ужин).
--
-- Разбор считается успешным ТОЛЬКО если покрыты все семь дней. Иначе
-- точка получает расписание из open/close и попадает в NOTICE.
-- Функции-парсеры удаляются в конце миграции: это разовый инструмент.
-- ============================================================

CREATE FUNCTION _rsv_dow_token(p_token TEXT)
RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v TEXT := LOWER(TRIM(regexp_replace(COALESCE(p_token, ''), '[׳''`"]', '', 'g')));
BEGIN
  RETURN CASE v
    WHEN 'א' THEN 0 WHEN 'ראשון' THEN 0 WHEN 'יום ראשון' THEN 0
    WHEN 'вс' THEN 0 WHEN 'воскресенье' THEN 0 WHEN 'sun' THEN 0 WHEN 'sunday' THEN 0
    WHEN 'ב' THEN 1 WHEN 'שני' THEN 1 WHEN 'יום שני' THEN 1
    WHEN 'пн' THEN 1 WHEN 'понедельник' THEN 1 WHEN 'mon' THEN 1 WHEN 'monday' THEN 1
    WHEN 'ג' THEN 2 WHEN 'שלישי' THEN 2 WHEN 'יום שלישי' THEN 2
    WHEN 'вт' THEN 2 WHEN 'вторник' THEN 2 WHEN 'tue' THEN 2 WHEN 'tuesday' THEN 2
    WHEN 'ד' THEN 3 WHEN 'רביעי' THEN 3 WHEN 'יום רביעי' THEN 3
    WHEN 'ср' THEN 3 WHEN 'среда' THEN 3 WHEN 'wed' THEN 3 WHEN 'wednesday' THEN 3
    WHEN 'ה' THEN 4 WHEN 'חמישי' THEN 4 WHEN 'יום חמישי' THEN 4
    WHEN 'чт' THEN 4 WHEN 'четверг' THEN 4 WHEN 'thu' THEN 4 WHEN 'thursday' THEN 4
    WHEN 'ו' THEN 5 WHEN 'שישי' THEN 5 WHEN 'יום שישי' THEN 5
    WHEN 'пт' THEN 5 WHEN 'пятница' THEN 5 WHEN 'fri' THEN 5 WHEN 'friday' THEN 5
    WHEN 'ש' THEN 6 WHEN 'שבת' THEN 6 WHEN 'יום שבת' THEN 6
    WHEN 'сб' THEN 6 WHEN 'суббота' THEN 6 WHEN 'sat' THEN 6 WHEN 'saturday' THEN 6
    ELSE NULL
  END;
END $$;

CREATE FUNCTION _rsv_parse_hours_text(p_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_week   JSONB := '{}'::jsonb;
  v_line   TEXT;
  v_parts  TEXT[];
  v_days   TEXT;
  v_times  TEXT;
  v_tok    TEXT;
  v_a      INTEGER;
  v_b      INTEGER;
  v_d      INTEGER;
  v_wins   JSONB;
  v_seg    TEXT;
  v_tm     TEXT[];
  v_covered BOOLEAN;
  i        INTEGER;
BEGIN
  IF COALESCE(TRIM(p_text), '') = '' THEN
    RETURN NULL;
  END IF;

  FOREACH v_line IN ARRAY regexp_split_to_array(p_text, E'\n') LOOP
    v_line := TRIM(v_line);
    CONTINUE WHEN v_line = '';

    -- «дни · время». Без разделителя строку разобрать нельзя.
    v_parts := regexp_split_to_array(v_line, '·');
    IF array_length(v_parts, 1) < 2 THEN
      RETURN NULL;
    END IF;
    v_days  := TRIM(v_parts[1]);
    v_times := TRIM(array_to_string(v_parts[2:array_length(v_parts, 1)], '·'));

    -- Окна времени: «08:00 – 20:00» либо несколько через запятую,
    -- либо слово «закрыто».
    IF v_times ~* '(סגור|закрыт|closed)' THEN
      v_wins := '[]'::jsonb;
    ELSE
      v_wins := '[]'::jsonb;
      FOREACH v_seg IN ARRAY regexp_split_to_array(v_times, ',') LOOP
        -- regexp_match (не ...matches): скалярная форма отдаёт NULL при
        -- отсутствии совпадения, множественная — пустое множество строк.
        v_tm := regexp_match(v_seg, '(\d{1,2}:\d{2})\s*[-–—~]\s*(\d{1,2}:\d{2})');
        IF v_tm IS NULL THEN
          RETURN NULL;  -- время в строке есть, но нечитаемое
        END IF;
        v_wins := v_wins || jsonb_build_array(
          jsonb_build_array(
            to_char(v_tm[1]::TIME, 'HH24:MI'),
            to_char(v_tm[2]::TIME, 'HH24:MI')));
      END LOOP;
      IF jsonb_array_length(v_wins) = 0 THEN
        RETURN NULL;
      END IF;
    END IF;

    -- Дни: «א – ה», «שישי», «пн, ср», «Вс–Чт»
    FOREACH v_seg IN ARRAY regexp_split_to_array(v_days, ',') LOOP
      v_seg := TRIM(v_seg);
      CONTINUE WHEN v_seg = '';
      IF v_seg ~ '[-–—]' THEN
        v_tok := TRIM(split_part(regexp_replace(v_seg, '[–—]', '-', 'g'), '-', 1));
        v_a := _rsv_dow_token(v_tok);
        v_tok := TRIM(split_part(regexp_replace(v_seg, '[–—]', '-', 'g'), '-', 2));
        v_b := _rsv_dow_token(v_tok);
        IF v_a IS NULL OR v_b IS NULL THEN
          RETURN NULL;
        END IF;
        -- Диапазон может заворачиваться через субботу (пт–вт)
        v_d := v_a;
        LOOP
          v_week := v_week || jsonb_build_object(v_d::TEXT, v_wins);
          EXIT WHEN v_d = v_b;
          v_d := (v_d + 1) % 7;
        END LOOP;
      ELSE
        v_a := _rsv_dow_token(v_seg);
        IF v_a IS NULL THEN
          RETURN NULL;
        END IF;
        v_week := v_week || jsonb_build_object(v_a::TEXT, v_wins);
      END IF;
    END LOOP;
  END LOOP;

  -- Разбор принимается только при полном покрытии недели: частичный
  -- график молча закрыл бы неупомянутые дни.
  v_covered := TRUE;
  FOR i IN 0..6 LOOP
    IF v_week -> i::TEXT IS NULL THEN
      v_covered := FALSE;
    END IF;
  END LOOP;
  IF NOT v_covered THEN
    RETURN NULL;
  END IF;

  RETURN v_week;
END $$;

DO $$
DECLARE
  v_loc      RECORD;
  v_week     JSONB;
  v_sch      JSONB;
  v_ok       INTEGER := 0;
  v_fallback INTEGER := 0;
BEGIN
  FOR v_loc IN
    SELECT id, name, settings FROM locations
    WHERE jsonb_typeof(settings -> 'reservations') = 'object'
      AND settings -> 'reservations' -> 'schedule' IS NULL
  LOOP
    v_week := _rsv_parse_hours_text(v_loc.settings -> 'reservations' ->> 'hours');

    IF v_week IS NULL THEN
      -- Фолбэк: семь одинаковых окон из open/close (поведение не меняется)
      v_week := '{}'::jsonb;
      FOR i IN 0..6 LOOP
        v_week := v_week || jsonb_build_object(i::TEXT, jsonb_build_array(jsonb_build_array(
          COALESCE(NULLIF(v_loc.settings -> 'reservations' ->> 'open', ''), '07:00'),
          COALESCE(NULLIF(v_loc.settings -> 'reservations' ->> 'close', ''), '23:45'))));
      END LOOP;
      v_fallback := v_fallback + 1;
      RAISE NOTICE '117: точка % (%) — текст hours не разобран, расписание взято из open/close. ПРОВЕРИТЬ вручную в ANGLE.',
        v_loc.name, v_loc.id;
    ELSE
      v_ok := v_ok + 1;
    END IF;

    v_sch := jsonb_build_object(
      'weekly', v_week,
      'exceptions', '{}'::jsonb,
      'lead_min', 30,
      'horizon_days', 30);

    UPDATE locations
    SET settings = jsonb_set(
          settings,
          ARRAY['reservations', 'schedule'],
          v_sch,
          TRUE)
    WHERE id = v_loc.id;
  END LOOP;

  RAISE NOTICE '117: расписание брони заполнено — % из текста hours, % из open/close.', v_ok, v_fallback;
END $$;

DROP FUNCTION _rsv_parse_hours_text(TEXT);
DROP FUNCTION _rsv_dow_token(TEXT);

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Миграция forward-only и НИЧЕГО не удаляет: open/close и текст hours
-- остаются в settings нетронутыми. Функциональный откат для одной
-- точки — снять ключ schedule, после чего reservation_schedule снова
-- развернёт legacy open/close:
--
--   UPDATE locations
--   SET settings = settings #- '{reservations,schedule}'
--   WHERE id = '<location_id>';
--
-- ПРОВЕРОЧНЫЕ ЗАПРОСЫ после применения:
--
--   -- 1. Что получилось у каждой точки
--   SELECT name, settings -> 'reservations' -> 'schedule' -> 'weekly'
--   FROM locations WHERE settings -> 'reservations' -> 'schedule' IS NOT NULL;
--
--   -- 2. Закрытый день действительно закрыт (ожидается f)
--   SELECT reservation_bookable_at(settings, timezone,
--            '2026-08-01 10:00'::timestamp AT TIME ZONE timezone)
--   FROM locations WHERE id = '<location_id>';
--
--   -- 3. Сетка субботы пуста (ожидается 0 слотов)
--   SELECT json_array_length((reservation_availability(
--            '<location_id>', DATE '2026-08-01', 2) -> 'slots')::json);
-- ============================================================
