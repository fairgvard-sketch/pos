-- ============================================================
-- 125 RESERVE ANALYTICS — отчёт по броням для кабинета.
--
-- МОТИВ. 124 научился копить воронку, но показывать её негде: владелец
-- по-прежнему видит только список визитов. Здесь появляется единственная
-- функция отчёта, которую зовёт экран Analytics.
--
-- ДВЕ ОСИ ВРЕМЕНИ, и это главное, что нужно понимать про этот отчёт.
--   * Воронка и всё, что про ПРИВОД гостя (конверсия, каналы, средний
--     запас до визита), считается по МОМЕНТУ ДЕЙСТВИЯ: сессии периода
--     сравниваются с бронями, СОЗДАННЫМИ в том же периоде. Иначе
--     конверсия делила бы сессии этой недели на брони, оформленные
--     месяц назад на эту неделю, — и была бы просто неверной.
--   * Всё, что про РАБОТУ ЗАЛА (исходы визитов, загрузка, день недели,
--     час, зона), считается по МОМЕНТУ ВИЗИТА.
-- Обе оси помечены в ответе (`basis`), чтобы экран не выдавал одно за
-- другое.
--
-- Загрузка считается в посадко-часах ГОСТЕЙ (party_size × длительность)
-- к посадко-часам ЗАЛА (места × часы работы по расписанию 117). Не по
-- занятым столам: стол на четверых под пару — это и есть недозагрузка,
-- которую владелец хочет увидеть, а не спрятать.
--
-- Брони, созданные до 124, канала не имеют. Они попадают в 'unknown', а
-- не растворяются в 'direct': «не измеряли» и «пришли сами» — разные
-- ответы, и подменять первый вторым нельзя.
--
-- Сетевой разрез (пункт 4 плана): функция принимает МАССИВ точек и
-- пересекает его с точками организации вызывающего. Показать чужую точку
-- нельзя ни при каком наборе параметров; пустой массив = все свои.
--
-- ⚠️ ТРЕБУЕТ 117 (расписание), 120 (_reservation_web_member), 124 (воронка).
-- ============================================================

-- ── Часы работы дня в минутах ────────────────────────────────
/**
 * Сколько минут точка открыта для брони в эту локальную дату. Окно через
 * полночь принадлежит дате начала (соглашение 117), поэтому отрицательная
 * разница означает переход через сутки, а не ошибку.
 */
CREATE OR REPLACE FUNCTION reservation_open_minutes(p_schedule JSONB, p_date DATE)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(SUM(
    CASE WHEN secs < 0 THEN secs + 86400 ELSE secs END
  ) / 60, 0)::INTEGER
  FROM (
    SELECT EXTRACT(EPOCH FROM ((w ->> 1)::TIME - (w ->> 0)::TIME)) AS secs
    FROM jsonb_array_elements(reservation_day_windows(p_schedule, p_date)) AS w
    WHERE jsonb_typeof(w) = 'array'
      AND (w ->> 0) ~ '^\d{1,2}:\d{2}$'
      AND (w ->> 1) ~ '^\d{1,2}:\d{2}$'
  ) AS windows
$$;

REVOKE ALL ON FUNCTION reservation_open_minutes(JSONB, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservation_open_minutes(JSONB, DATE) TO authenticated, service_role;

COMMENT ON FUNCTION reservation_open_minutes(JSONB, DATE) IS
  'Минуты приёма броней в локальную дату (125). Основание знаменателя загрузки: места × часы работы.';

-- ── Разрешённые точки отчёта ─────────────────────────────────
/**
 * Точки, которые вызывающему МОЖНО показать. Пустой/NULL массив —
 * все точки организации (обычный случай одноточечного заведения).
 *
 * Пересечение, а не проверка с исключением: сетевой фильтр — это выбор
 * подмножества своих точек, и попытка добавить чужую должна её просто
 * не включить, а не сорвать весь отчёт.
 */
CREATE OR REPLACE FUNCTION _reserve_report_locations(p_location_ids UUID[])
RETURNS UUID[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_ids UUID[];
BEGIN
  IF auth_backoffice_role() IS NULL
     OR auth_backoffice_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_members
    WHERE auth_user_id = auth.uid() AND org_id = v_org AND is_active
  ) THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  IF NOT org_has_capability(v_org, 'reservations_desk') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  SELECT ARRAY_AGG(id) INTO v_ids
  FROM locations
  WHERE org_id = v_org
    AND (p_location_ids IS NULL
         OR array_length(p_location_ids, 1) IS NULL
         OR id = ANY(p_location_ids));

  RETURN COALESCE(v_ids, '{}'::UUID[]);
END $$;

REVOKE ALL ON FUNCTION _reserve_report_locations(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _reserve_report_locations(UUID[]) TO authenticated, service_role;

-- ── Отчёт ────────────────────────────────────────────────────
/**
 * Единственная функция экрана Analytics. Диапазон дат — ЛОКАЛЬНЫЙ для
 * каждой точки: сеть в разных поясах не должна получать смещённые сутки.
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
  -- Потолок окна: отчёт синхронный, а не фоновая выгрузка.
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

  -- Визиты периода: ось «когда гость приходит».
  visits AS (
    SELECT r.*, b.name AS loc_name, b.tz
    FROM reservations r
    JOIN bounds b ON b.id = r.location_id
    WHERE r.reserved_at >= b.from_ts AND r.reserved_at < b.to_ts
  ),
  -- Оформления периода: ось «когда гость забронировал».
  made AS (
    SELECT r.*
    FROM reservations r
    JOIN bounds b ON b.id = r.location_id
    WHERE r.created_at >= b.from_ts AND r.created_at < b.to_ts
  ),
  ev AS (
    SELECT e.*
    FROM reservation_funnel_events e
    JOIN bounds b ON b.id = e.location_id
    WHERE e.at >= b.from_ts AND e.at < b.to_ts
  ),

  -- Воронка считается СЕССИЯМИ, а не строками: один человек, трижды
  -- переспросивший даты, — это один человек, а не три.
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

  -- Загрузка: числитель — гости в зале, знаменатель — места × часы работы.
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

    -- Воронка: ось «действие гостя»
    'funnel', (SELECT json_build_object(
      'basis', 'event_time',
      'page_view', page_view, 'availability', availability,
      'slot_selected', slot_selected, 'form_started', form_started,
      'submitted', submitted, 'waitlisted', waitlisted,
      'dead_ends', dead_ends,
      -- Конверсия честная только при непустой вершине: 0/0 — это «нет
      -- данных», а не «ноль процентов».
      'conversion', CASE WHEN page_view > 0
                         THEN ROUND(submitted::NUMERIC * 100 / page_view, 1) END,
      'form_conversion', CASE WHEN form_started > 0
                              THEN ROUND(submitted::NUMERIC * 100 / form_started, 1) END
    ) FROM funnel),

    -- Оформления: ось «когда забронировали»
    'bookings', (SELECT json_build_object(
      'basis', 'created_at',
      'total', COUNT(*),
      'instant', COUNT(*) FILTER (WHERE auto),
      'manual', COUNT(*) FILTER (WHERE NOT auto),
      'avg_party', ROUND(AVG(party_size)::NUMERIC, 1),
      -- Запас до визита: сколько заранее бронируют. Отрицательный
      -- (бронь задним числом с кассы) в среднее не берём.
      'avg_lead_min', ROUND(AVG(GREATEST(
        EXTRACT(EPOCH FROM (reserved_at - created_at)) / 60, 0))::NUMERIC)
    ) FROM made),

    -- Визиты: ось «когда пришли»
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

    -- Каналы: сессии из воронки рядом с бронями того же канала. Строка
    -- есть, даже если канал дал сессии и ни одной брони — иначе
    -- бесполезный канал просто исчезал бы из отчёта.
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

    -- Спрос, которого заведение сегодня не видит вообще: гость спросил
    -- дату и компанию, а свободного времени не нашлось.
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

REVOKE ALL ON FUNCTION reserve_analytics_web(UUID[], DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reserve_analytics_web(UUID[], DATE, DATE) TO authenticated, service_role;

COMMENT ON FUNCTION reserve_analytics_web(UUID[], DATE, DATE) IS
  'Отчёт по броням для кабинета (125). Две оси времени: воронка и оформления — по моменту действия, визиты и загрузка — по моменту визита; ось помечена в поле basis каждого блока.';

-- ── Проверка после применения ────────────────────────────────
-- Под ролью веб-владельца:
--   SELECT reserve_analytics_web(NULL, CURRENT_DATE - 29, CURRENT_DATE);
--   SELECT reserve_analytics_web(ARRAY['<чужая точка>']::UUID[]);  -- пустой отчёт
-- Откат: DROP FUNCTION reserve_analytics_web, _reserve_report_locations,
-- reservation_open_minutes. Данные не затрагиваются — функция только читает.
