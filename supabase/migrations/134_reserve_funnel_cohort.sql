-- ============================================================
-- 134 RESERVE FUNNEL COHORT — точная монотонная воронка сессий.
--
-- 125/126 считали DISTINCT session_id независимо для каждого шага.
-- Если раннее событие не доехало или оказалось за границей периода,
-- поздний шаг мог стать больше раннего и кабинет показывал 200 %.
--
-- Единица отчёта остаётся прежней — анонимная сессия вкладки. Для
-- каждой сессии находим самый дальний наблюдавшийся шаг и считаем
-- «дошла как минимум сюда». Это точная когорта по событиям периода,
-- а не клиентское восстановление из пяти несвязанных итогов.
-- ============================================================

-- Сохраняем последнюю полную реализацию отчёта (126) как закрытую
-- внутреннюю функцию. Обёртка ниже меняет только блок funnel и не
-- копирует сотни строк остальных проверенных метрик.
ALTER FUNCTION reserve_analytics_web(UUID[], DATE, DATE)
  RENAME TO reserve_analytics_web_v1_133;

REVOKE ALL ON FUNCTION reserve_analytics_web_v1_133(UUID[], DATE, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_analytics_web_v1_133(UUID[], DATE, DATE)
  TO service_role;

CREATE FUNCTION reserve_analytics_web(
  p_location_ids UUID[] DEFAULT NULL,
  p_from         DATE DEFAULT NULL,
  p_to           DATE DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids     UUID[] := _reserve_report_locations(p_location_ids);
  v_to      DATE := COALESCE(p_to, CURRENT_DATE);
  v_from    DATE := COALESCE(p_from, v_to - 29);
  v_report  JSONB;
  v_funnel  JSONB;
BEGIN
  -- Старая функция остаётся источником всех метрик вне воронки и тем
  -- самым сохраняет её валидацию диапазона, tenant scope и контракт.
  v_report := reserve_analytics_web_v1_133(
    p_location_ids, p_from, p_to
  )::JSONB;

  WITH bounds AS (
    SELECT
      l.id,
      (v_from::TIMESTAMP AT TIME ZONE
        COALESCE(l.timezone, 'Asia/Jerusalem')) AS from_ts,
      ((v_to + 1)::TIMESTAMP AT TIME ZONE
        COALESCE(l.timezone, 'Asia/Jerusalem')) AS to_ts
    FROM locations l
    WHERE l.id = ANY(v_ids)
  ),
  ev AS (
    SELECT e.*
    FROM reservation_funnel_events e
    JOIN bounds b ON b.id = e.location_id
    WHERE e.at >= b.from_ts AND e.at < b.to_ts
  ),
  session_progress AS (
    SELECT
      session_id,
      MAX(CASE
        WHEN step = 'submitted' THEN 5
        WHEN step = 'form_started' THEN 4
        WHEN step = 'slot_selected' THEN 3
        -- no_slots/waitlisted — отдельные ветви после проверки
        -- доступности. Они входят в общую когорту до второго шага,
        -- но не притворяются выбором слота или заявкой.
        WHEN step IN ('availability', 'no_slots', 'waitlisted') THEN 2
        WHEN step = 'page_view' THEN 1
        ELSE 0
      END) AS max_step
    FROM ev
    GROUP BY session_id
  ),
  funnel AS (
    SELECT
      COUNT(*) FILTER (WHERE max_step >= 1) AS page_view,
      COUNT(*) FILTER (WHERE max_step >= 2) AS availability,
      COUNT(*) FILTER (WHERE max_step >= 3) AS slot_selected,
      COUNT(*) FILTER (WHERE max_step >= 4) AS form_started,
      COUNT(*) FILTER (WHERE max_step >= 5) AS submitted,
      (SELECT COUNT(DISTINCT session_id) FROM ev
        WHERE step = 'waitlisted') AS waitlisted,
      (SELECT COUNT(DISTINCT session_id) FROM ev
        WHERE step = 'no_slots') AS dead_ends
    FROM session_progress
  )
  SELECT jsonb_build_object(
    'basis', 'event_time',
    'calculation_version', 2,
    'cohort', 'observed_session_max_step',
    'page_view', page_view,
    'availability', availability,
    'slot_selected', slot_selected,
    'form_started', form_started,
    'submitted', submitted,
    'waitlisted', waitlisted,
    'dead_ends', dead_ends,
    'conversion', CASE WHEN page_view > 0
      THEN ROUND(submitted::NUMERIC * 100 / page_view, 1) END,
    'form_conversion', CASE WHEN form_started > 0
      THEN ROUND(submitted::NUMERIC * 100 / form_started, 1) END
  ) INTO v_funnel
  FROM funnel;

  RETURN jsonb_set(v_report, '{funnel}', v_funnel, TRUE)::JSON;
END $$;

REVOKE ALL ON FUNCTION reserve_analytics_web(UUID[], DATE, DATE)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reserve_analytics_web(UUID[], DATE, DATE)
  TO authenticated, service_role;

COMMENT ON FUNCTION reserve_analytics_web(UUID[], DATE, DATE) IS
  'Отчёт бронирований для кабинета (134). Funnel calculation_version=2: точная когорта наблюдавшихся сессий по максимальному достигнутому шагу.';

-- После применения:
--   SELECT reserve_analytics_web(NULL, CURRENT_DATE - 29, CURRENT_DATE)
--          -> 'funnel';
-- Откат не destructive: выпустить следующую forward-only миграцию,
-- переопределяющую публичную функцию. События и брони не изменяются.
