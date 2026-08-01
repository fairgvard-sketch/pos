-- ============================================================
-- 126 RESERVE LAUNCH — онбординг, чеклист запуска и тест-режим.
--
-- МОТИВ. Точка, купившая Reserve, включает приём тумблером — и всё.
-- Есть ли столы, задано ли расписание, написаны ли правила отмены,
-- получил ли владелец короткую ссылку — не проверяет никто. Тумблер
-- честно откроет гостю страницу пустого зала, где нечего бронировать.
--
-- Здесь появляются три вещи:
--   1) `reserve_launch_checklist_web` — что ещё не готово к публикации.
--      Считается из ДАННЫХ, а не из галочек, которые владелец ставит
--      сам: галочка «я настроил зал» ничего не гарантирует, а COUNT
--      столов гарантирует.
--   2) Предпросмотр по секретной ссылке: гостевая страница открывается
--      даже при ВЫКЛЮЧЕННОМ приёме, с явной пометкой. Владелец видит то
--      же, что увидит гость, до того как что-то опубликовал.
--   3) Тестовая бронь `reservations.is_test` — настоящая (занимает стол,
--      проходит по тем же правилам), но помеченная: бейдж в таймлайне и
--      полное исключение из отчёта 125.
--
-- ПОЧЕМУ ТЕСТОВУЮ БРОНЬ СОЗДАЁТ КАБИНЕТ, А НЕ ФОРМА ГОСТЯ. Провести её
-- через `submit_reservation` значило бы протащить туда режим «правила
-- те же, но тумблер приёма не смотрим» — то есть переписать функцию,
-- которая держит расписание, идемпотентность, подбор столов и гонку
-- инстант-броней. 120 уже разбирала эту цену: дублировать такое тело
-- ради одного флага нельзя. Кабинет создаёт бронь тем же `_pick_tables`
-- и тем же EXCLUDE, а предпросмотр остаётся ТОЛЬКО просмотром — на
-- последнем шаге он честно говорит, что брони не создал.
--
-- ⚠️ ТРЕБУЕТ 106 (слаги), 117 (расписание), 120 (_reservation_web_member),
--    125 (отчёт).
-- ============================================================

-- ── 1. Тестовая бронь ────────────────────────────────────────
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN reservations.is_test IS
  'Тестовая бронь владельца (126): настоящая и занимает стол, но помечена в интерфейсе и исключена из отчётов.';

-- ── 2. Секрет предпросмотра ──────────────────────────────────
/**
 * Токен живёт в `settings.reservations.preview_token`. Отдельной таблицы
 * не заводим: это один секрет на точку, у которого нет своей истории.
 *
 * `p_rotate` нужен, когда ссылку показали не тому: старый предпросмотр
 * должен перестать открываться сразу же.
 */
CREATE OR REPLACE FUNCTION reserve_preview_token_web(
  p_location_id UUID,
  p_rotate      BOOLEAN DEFAULT FALSE
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_token TEXT;
BEGIN
  PERFORM _reservation_web_member(p_location_id);

  SELECT settings -> 'reservations' ->> 'preview_token'
  INTO v_token
  FROM locations WHERE id = p_location_id AND org_id = auth_org_id()
  FOR UPDATE;

  IF v_token IS NULL OR p_rotate THEN
    v_token := replace(gen_random_uuid()::TEXT, '-', '');
    UPDATE locations
    SET settings = jsonb_set(
          COALESCE(settings, '{}'::jsonb),
          '{reservations,preview_token}',
          to_jsonb(v_token),
          TRUE)
    WHERE id = p_location_id AND org_id = auth_org_id();
  END IF;

  RETURN v_token;
END $$;

REVOKE ALL ON FUNCTION reserve_preview_token_web(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reserve_preview_token_web(UUID, BOOLEAN) TO authenticated, service_role;

/**
 * Проверка токена для публичного контура. Отдельная функция, потому что
 * зовёт её Edge Function под service_role, а не владелец: сравнение
 * секрета не должно требовать чтения всего `settings` наружу.
 */
CREATE OR REPLACE FUNCTION reserve_preview_valid(p_location_id UUID, p_token TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM locations
    WHERE id = p_location_id
      AND length(COALESCE(p_token, '')) >= 16
      AND settings -> 'reservations' ->> 'preview_token' = p_token
  )
$$;

REVOKE ALL ON FUNCTION reserve_preview_valid(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_preview_valid(UUID, TEXT) TO service_role;

-- ── 3. Тестовая бронь из кабинета ────────────────────────────
/**
 * Ставит настоящую бронь на ближайшее свободное время (или на заданное)
 * и помечает её тестовой. Правила подбора стола и занятости — общие с
 * гостевым потоком: `_pick_tables` + EXCLUDE ловят то же самое.
 *
 * Тумблер приёма и расписание НЕ проверяются: смысл шага в том, чтобы
 * убедиться, что зал и таймлайн работают, ДО публикации.
 */
CREATE OR REPLACE FUNCTION create_test_reservation_web(
  p_location_id UUID,
  p_at          TIMESTAMPTZ DEFAULT NULL,
  p_party_size  INTEGER DEFAULT 2
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_rsv    JSONB;
  v_at     TIMESTAMPTZ := COALESCE(p_at, date_trunc('hour', NOW()) + INTERVAL '2 hours');
  v_party  INTEGER := GREATEST(1, LEAST(COALESCE(p_party_size, 2), 20));
  v_dur    INTEGER;
  v_buffer INTEGER;
  v_combine BOOLEAN;
  v_tables UUID[];
  v_id     UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tables
    WHERE location_id = p_location_id AND org_id = v_org AND is_active
  ) THEN
    RAISE EXCEPTION 'no_tables';
  END IF;

  SELECT COALESCE(settings -> 'reservations', '{}'::jsonb) INTO v_rsv
  FROM locations WHERE id = p_location_id AND org_id = v_org;

  v_dur     := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);

  v_tables := _pick_tables(p_location_id, v_party, v_at, v_dur, v_buffer,
                           v_combine, NULL, NULL);
  IF array_length(v_tables, 1) IS NULL THEN
    RAISE EXCEPTION 'full_slot';
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, duration_min, table_id, hold_table_ids,
      status, auto, decided_at, decided_by_member, is_test, note)
    VALUES (
      v_org, p_location_id, gen_random_uuid(), 'Тестовая бронь', '0500000000',
      v_party, v_at, v_dur, v_tables[1],
      COALESCE(v_tables[2:array_length(v_tables, 1)], '{}'::UUID[]),
      'confirmed', TRUE, NOW(), v_member, TRUE,
      'Проверка перед запуском — отмените её, когда посмотрите таймлайн.')
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'full_slot';
  END;

  RETURN json_build_object('reservation_id', v_id, 'reserved_at', v_at,
                           'table_id', v_tables[1]);
END $$;

REVOKE ALL ON FUNCTION create_test_reservation_web(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_test_reservation_web(UUID, TIMESTAMPTZ, INTEGER) TO authenticated;

-- ── 4. Чеклист запуска ───────────────────────────────────────
/**
 * Что мешает опубликовать бронь. Каждый пункт считается из данных:
 * галочка «я настроил зал» ничего не гарантирует, а число столов — да.
 *
 * `ready` не включает сам тумблер приёма: он и есть публикация, а не
 * условие для неё. Иначе чеклист требовал бы включить приём, чтобы
 * разрешить включить приём.
 */
CREATE OR REPLACE FUNCTION reserve_launch_checklist_web(p_location_id UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_tables   INTEGER;
  v_seats    INTEGER;
  v_schedule BOOLEAN;
  v_policy   BOOLEAN;
  v_brand    BOOLEAN;
  v_slug     BOOLEAN;
  v_tested   BOOLEAN;
BEGIN
  PERFORM _reservation_web_member(p_location_id);

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id AND org_id = v_org;
  v_rsv := COALESCE(v_loc.settings -> 'reservations', '{}'::jsonb);

  SELECT COUNT(*)::INTEGER, COALESCE(SUM(seats), 0)::INTEGER
  INTO v_tables, v_seats
  FROM tables WHERE location_id = p_location_id AND org_id = v_org AND is_active;

  -- Расписание задано ЯВНО: legacy-пара open/close и умолчания 117
  -- считаются «ещё не настроено» — владелец их не выбирал.
  v_schedule := jsonb_typeof(v_rsv -> 'schedule' -> 'weekly') = 'object'
                AND (SELECT COUNT(*) FROM jsonb_object_keys(v_rsv -> 'schedule' -> 'weekly')) > 0;

  v_policy := NULLIF(btrim(COALESCE(v_rsv ->> 'policy', '')), '') IS NOT NULL;

  -- Брендинг: гостю нужно понять, куда он идёт. Имя + хотя бы один
  -- способ связи или адрес.
  v_brand := COALESCE(
    NULLIF(btrim(COALESCE(v_rsv ->> 'display_name', '')), ''),
    NULLIF(btrim(COALESCE(v_loc.settings ->> 'display_name', '')), ''),
    NULLIF(btrim(COALESCE(v_loc.receipt_business_name, '')), '')) IS NOT NULL
    AND COALESCE(
      NULLIF(btrim(COALESCE(v_rsv ->> 'address', '')), ''),
      NULLIF(btrim(COALESCE(v_loc.receipt_address, '')), ''),
      NULLIF(btrim(COALESCE(v_loc.receipt_phone, '')), '')) IS NOT NULL;

  SELECT EXISTS (SELECT 1 FROM location_slugs WHERE location_id = p_location_id)
  INTO v_slug;

  SELECT EXISTS (
    SELECT 1 FROM reservations
    WHERE location_id = p_location_id AND org_id = v_org AND is_test
  ) INTO v_tested;

  RETURN json_build_object(
    'location_id', p_location_id,
    'accepting', COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE),
    'steps', json_build_array(
      json_build_object('key', 'tables', 'done', v_tables > 0,
        'detail', v_tables || ' tables · ' || v_seats || ' seats'),
      json_build_object('key', 'schedule', 'done', v_schedule, 'detail', NULL),
      json_build_object('key', 'policy', 'done', v_policy, 'detail', NULL),
      json_build_object('key', 'branding', 'done', v_brand, 'detail', NULL),
      json_build_object('key', 'link', 'done', v_slug, 'detail', NULL),
      json_build_object('key', 'test_booking', 'done', v_tested, 'detail', NULL)
    ),
    'ready', v_tables > 0 AND v_schedule AND v_brand
  );
END $$;

REVOKE ALL ON FUNCTION reserve_launch_checklist_web(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reserve_launch_checklist_web(UUID) TO authenticated;

COMMENT ON FUNCTION reserve_launch_checklist_web(UUID) IS
  'Готовность точки к публикации брони (126). Считается из данных, а не из галочек владельца.';

-- ── 5. Отчёт не считает тестовые брони ───────────────────────
/**
 * Тело 125 дословно; изменены только предикаты выборок броней — visits
 * и made теперь отбрасывают `is_test`. Тестовая бронь занимает стол и
 * видна хостес, но портить конверсию и загрузку она не должна.
 */
CREATE OR REPLACE FUNCTION reserve_analytics_web(
  p_location_ids UUID[] DEFAULT NULL,
  p_from         DATE DEFAULT NULL,
  p_to           DATE DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids  UUID[] := _reserve_report_locations(p_location_ids);
  v_to   DATE := COALESCE(p_to, CURRENT_DATE);
  v_from DATE := COALESCE(p_from, v_to - 29);
  v_res  JSON;
BEGIN
  IF v_from > v_to THEN
    RAISE EXCEPTION 'invalid_range';
  END IF;
  IF v_to - v_from > 400 THEN
    RAISE EXCEPTION 'range_too_wide';
  END IF;

  WITH bounds AS (
    SELECT
      l.id, l.name,
      COALESCE(l.timezone, 'Asia/Jerusalem') AS tz,
      (v_from::TIMESTAMP AT TIME ZONE COALESCE(l.timezone, 'Asia/Jerusalem')) AS from_ts,
      ((v_to + 1)::TIMESTAMP AT TIME ZONE COALESCE(l.timezone, 'Asia/Jerusalem')) AS to_ts,
      reservation_schedule(COALESCE(l.settings, '{}'::jsonb)) AS schedule
    FROM locations l
    WHERE l.id = ANY(v_ids)
  ),
  visits AS (
    SELECT r.*, b.name AS loc_name, b.tz
    FROM reservations r
    JOIN bounds b ON b.id = r.location_id
    WHERE r.reserved_at >= b.from_ts AND r.reserved_at < b.to_ts
      AND NOT r.is_test
  ),
  made AS (
    SELECT r.*
    FROM reservations r
    JOIN bounds b ON b.id = r.location_id
    WHERE r.created_at >= b.from_ts AND r.created_at < b.to_ts
      AND NOT r.is_test
  ),
  ev AS (
    SELECT e.*
    FROM reservation_funnel_events e
    JOIN bounds b ON b.id = e.location_id
    WHERE e.at >= b.from_ts AND e.at < b.to_ts
  ),
  funnel AS (
    SELECT
      COUNT(DISTINCT session_id) FILTER (WHERE step = 'page_view')     AS page_view,
      COUNT(DISTINCT session_id) FILTER (WHERE step = 'availability')  AS availability,
      COUNT(DISTINCT session_id) FILTER (WHERE step = 'slot_selected') AS slot_selected,
      COUNT(DISTINCT session_id) FILTER (WHERE step = 'form_started')  AS form_started,
      COUNT(DISTINCT session_id) FILTER (WHERE step = 'submitted')     AS submitted,
      COUNT(DISTINCT session_id) FILTER (WHERE step = 'waitlisted')    AS waitlisted,
      COUNT(DISTINCT session_id) FILTER (WHERE step = 'no_slots')      AS dead_ends
    FROM ev
  ),
  seats AS (
    SELECT location_id, SUM(seats)::NUMERIC AS total
    FROM tables WHERE location_id = ANY(v_ids) AND is_active
    GROUP BY location_id
  ),
  open_hours AS (
    SELECT
      b.id AS location_id,
      SUM(reservation_open_minutes(b.schedule, d::DATE))::NUMERIC / 60 AS hours
    FROM bounds b
    CROSS JOIN generate_series(v_from, v_to, INTERVAL '1 day') AS d
    GROUP BY b.id
  ),
  capacity AS (
    SELECT COALESCE(SUM(o.hours * COALESCE(s.total, 0)), 0) AS seat_hours
    FROM open_hours o LEFT JOIN seats s ON s.location_id = o.location_id
  ),
  booked AS (
    SELECT COALESCE(SUM(party_size * duration_min::NUMERIC / 60), 0) AS seat_hours
    FROM visits
    WHERE status IN ('confirmed', 'completed')
  )

  SELECT json_build_object(
    'range', json_build_object(
      'from', v_from, 'to', v_to,
      'locations', (SELECT COALESCE(json_agg(json_build_object(
                      'id', id, 'name', name) ORDER BY name), '[]'::json) FROM bounds)),

    'funnel', (SELECT json_build_object(
      'basis', 'event_time',
      'page_view', page_view, 'availability', availability,
      'slot_selected', slot_selected, 'form_started', form_started,
      'submitted', submitted, 'waitlisted', waitlisted,
      'dead_ends', dead_ends,
      'conversion', CASE WHEN page_view > 0
                         THEN ROUND(submitted::NUMERIC * 100 / page_view, 1) END,
      'form_conversion', CASE WHEN form_started > 0
                              THEN ROUND(submitted::NUMERIC * 100 / form_started, 1) END
    ) FROM funnel),

    'bookings', (SELECT json_build_object(
      'basis', 'created_at',
      'total', COUNT(*),
      'instant', COUNT(*) FILTER (WHERE auto),
      'manual', COUNT(*) FILTER (WHERE NOT auto),
      'avg_party', ROUND(AVG(party_size)::NUMERIC, 1),
      'avg_lead_min', ROUND(AVG(GREATEST(
        EXTRACT(EPOCH FROM (reserved_at - created_at)) / 60, 0))::NUMERIC)
    ) FROM made),

    'visits', (SELECT json_build_object(
      'basis', 'reserved_at',
      'total', COUNT(*),
      'confirmed', COUNT(*) FILTER (WHERE status = 'confirmed'),
      'completed', COUNT(*) FILTER (WHERE status = 'completed'),
      'cancelled', COUNT(*) FILTER (WHERE status = 'cancelled'),
      'rejected', COUNT(*) FILTER (WHERE status = 'rejected'),
      'no_show', COUNT(*) FILTER (WHERE status = 'no_show'),
      'seated', COUNT(*) FILTER (WHERE arrived_at IS NOT NULL OR order_id IS NOT NULL),
      'guests', COALESCE(SUM(party_size) FILTER (
                  WHERE status IN ('confirmed', 'completed')), 0),
      'cancel_rate', CASE WHEN COUNT(*) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE status = 'cancelled')::NUMERIC * 100 / COUNT(*), 1) END,
      'no_show_rate', CASE WHEN COUNT(*) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE status = 'no_show')::NUMERIC * 100 / COUNT(*), 1) END
    ) FROM visits),

    'occupancy', (SELECT json_build_object(
      'basis', 'reserved_at',
      'seat_hours_booked', ROUND(b.seat_hours, 1),
      'seat_hours_available', ROUND(c.seat_hours, 1),
      'pct', CASE WHEN c.seat_hours > 0
                  THEN ROUND(b.seat_hours * 100 / c.seat_hours, 1) END
    ) FROM booked b CROSS JOIN capacity c),

    'waitlist', (SELECT json_build_object(
      'entries', COUNT(*),
      'converted', COUNT(*) FILTER (WHERE status = 'converted'),
      'conversion', CASE WHEN COUNT(*) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE status = 'converted')::NUMERIC * 100 / COUNT(*), 1) END
    ) FROM waitlist_entries w
      JOIN bounds b ON b.id = w.location_id
      WHERE w.created_at >= b.from_ts AND w.created_at < b.to_ts),

    'by_source', COALESCE((
      SELECT json_agg(row ORDER BY (row ->> 'bookings')::INT DESC, row ->> 'source')
      FROM (
        SELECT json_build_object(
          'source', src,
          'sessions', COALESCE(MAX(sessions), 0),
          'bookings', COALESCE(MAX(bookings), 0)
        ) AS row
        FROM (
          SELECT COALESCE(source, 'unknown') AS src,
                 COUNT(DISTINCT session_id) AS sessions, NULL::BIGINT AS bookings
          FROM ev GROUP BY 1
          UNION ALL
          SELECT COALESCE(source, 'unknown'), NULL, COUNT(*)
          FROM made GROUP BY 1
        ) AS parts
        GROUP BY src
      ) AS rows
    ), '[]'::json),

    'by_weekday', COALESCE((
      SELECT json_agg(json_build_object('dow', dow, 'bookings', n, 'guests', g) ORDER BY dow)
      FROM (
        SELECT EXTRACT(DOW FROM reserved_at AT TIME ZONE tz)::INT AS dow,
               COUNT(*) AS n, SUM(party_size) AS g
        FROM visits WHERE status IN ('confirmed', 'completed', 'no_show')
        GROUP BY 1
      ) AS d
    ), '[]'::json),

    'by_hour', COALESCE((
      SELECT json_agg(json_build_object('hour', hour, 'bookings', n) ORDER BY hour)
      FROM (
        SELECT EXTRACT(HOUR FROM reserved_at AT TIME ZONE tz)::INT AS hour, COUNT(*) AS n
        FROM visits WHERE status IN ('confirmed', 'completed', 'no_show')
        GROUP BY 1
      ) AS h
    ), '[]'::json),

    'by_party', COALESCE((
      SELECT json_agg(json_build_object('size', party_size, 'bookings', n) ORDER BY party_size)
      FROM (
        SELECT party_size, COUNT(*) AS n
        FROM visits WHERE status IN ('confirmed', 'completed', 'no_show')
        GROUP BY 1
      ) AS p
    ), '[]'::json),

    'by_zone', COALESCE((
      SELECT json_agg(json_build_object(
               'zone_id', z.id, 'name', COALESCE(z.name, 'Без зоны'), 'bookings', v.n)
             ORDER BY v.n DESC)
      FROM (
        SELECT zone_id, COUNT(*) AS n
        FROM visits WHERE status IN ('confirmed', 'completed', 'no_show')
        GROUP BY 1
      ) AS v
      LEFT JOIN table_zones z ON z.id = v.zone_id
    ), '[]'::json),

    'by_location', COALESCE((
      SELECT json_agg(json_build_object(
               'location_id', b.id, 'name', b.name,
               'bookings', COALESCE(v.n, 0), 'guests', COALESCE(v.g, 0))
             ORDER BY COALESCE(v.n, 0) DESC, b.name)
      FROM bounds b
      LEFT JOIN (
        SELECT location_id, COUNT(*) AS n, SUM(party_size) AS g
        FROM visits WHERE status IN ('confirmed', 'completed', 'no_show')
        GROUP BY 1
      ) AS v ON v.location_id = b.id
    ), '[]'::json),

    'unmet', COALESCE((
      SELECT json_agg(json_build_object(
               'date', wanted_date, 'party_size', party_size, 'requests', n)
             ORDER BY n DESC, wanted_date)
      FROM (
        SELECT wanted_date, party_size, COUNT(DISTINCT session_id) AS n
        FROM ev
        WHERE step = 'no_slots' AND wanted_date IS NOT NULL
        GROUP BY 1, 2
        ORDER BY n DESC
        LIMIT 20
      ) AS u
    ), '[]'::json)
  ) INTO v_res;

  RETURN v_res;
END $$;

-- ── Проверка после применения ────────────────────────────────
--   SELECT reserve_launch_checklist_web('<loc>');
--   SELECT reserve_preview_token_web('<loc>');
--   SELECT create_test_reservation_web('<loc>');   -- no_tables, если зал пуст
-- Откат: DROP FUNCTION create_test_reservation_web, reserve_launch_checklist_web,
-- reserve_preview_token_web, reserve_preview_valid; колонку is_test оставить
-- (тестовые брони уже помечены, снятие флага сделало бы их обычными).
