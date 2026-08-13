-- ============================================================
-- 159: аналитика удержания
--
-- ЗАЧЕМ.
--
-- Отчёт по броням (125/134) отвечает на вопрос «сколько пришло»:
-- воронка, каналы, загрузка зала. Про то, ВОЗВРАЩАЮТСЯ ли эти люди, он
-- не говорит ничего — а именно возврат отличает заведение с базой от
-- заведения с потоком.
--
-- ДВЕ ОСИ, КОТОРЫЕ НЕЛЬЗЯ ПУТАТЬ (правило 125 сохранено).
--
-- Здесь всё считается по МОМЕНТУ ВИЗИТА (`reserved_at`), а не по
-- моменту действия гостя: «сколько новых пришло в мае» — это про
-- визиты мая, кем бы и когда бы они ни были забронированы. Ответ помечен
-- `basis: reserved_at`, и экран обязан это подписывать.
--
-- КОГОРТЫ ВОЗВРАТА — ОПРЕДЕЛЕНИЕ.
--
-- Знаменатель: гости, у которых ПЕРВЫЙ состоявшийся визит попал в
-- период. Числитель: из них те, кто пришёл ещё раз в течение 30/60/90
-- дней после первого визита.
--
-- Отсюда следствие, которое обязано быть в интерфейсе: когорта не
-- считается «созревшей», пока с её первого визита не прошло N дней.
-- Гость, впервые пришедший вчера, не «не вернулся за 90 дней» — у него
-- ещё есть 89. Поэтому рядом с каждой когортой едет `mature` — сколько
-- гостей успели прожить полное окно. Делить по всем значит занижать
-- возврат тем сильнее, чем свежее период.
--
-- ЧТО СЧИТАЕТСЯ ВИЗИТОМ — то же, что в 155: завершённая бронь плюс
-- оплаченный заказ без брони. Тестовые, отклонённые и отменённые не
-- считаются нигде.
--
-- ⚠️ ТРЕБУЕТ 125 (_reserve_report_locations), 155 (guest_retention_facts,
--    guest_segment_set).
-- ============================================================

CREATE OR REPLACE FUNCTION guest_retention_analytics_web(
  p_location_ids UUID[]   DEFAULT NULL,
  p_from         DATE     DEFAULT NULL,
  p_to           DATE     DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_locs UUID[] := _reserve_report_locations(p_location_ids);
  v_org  UUID   := auth_org_id();
  v_from DATE   := COALESCE(p_from, (NOW() - INTERVAL '90 days')::DATE);
  v_to   DATE   := COALESCE(p_to, NOW()::DATE);
  v_out  JSONB;
BEGIN
  IF v_to < v_from THEN
    RAISE EXCEPTION 'invalid_range';
  END IF;
  IF v_to - v_from > 400 THEN
    RAISE EXCEPTION 'range_too_wide';
  END IF;

  WITH
  -- Все состоявшиеся визиты организации: когорты считаются от ПЕРВОГО
  -- визита гостя вообще, а не первого внутри периода — иначе давний
  -- гость, зашедший в мае, посчитался бы новым.
  visits AS (
    SELECT r.guest_id, r.reserved_at AS at, r.location_id
    FROM reservations r
    WHERE r.org_id = v_org
      AND r.guest_id IS NOT NULL
      AND NOT r.is_test
      AND (r.status = 'completed'
           OR (r.status = 'confirmed' AND r.reserved_at < NOW()))
    UNION ALL
    SELECT o.guest_id, COALESCE(o.paid_at, o.created_at), o.location_id
    FROM orders o
    WHERE o.org_id = v_org
      AND o.guest_id IS NOT NULL
      AND o.status IN ('paid', 'fulfilled')
      AND NOT EXISTS (SELECT 1 FROM reservations r2 WHERE r2.order_id = o.id)
  ),
  firsts AS (
    SELECT guest_id, MIN(at) AS first_at FROM visits GROUP BY guest_id
  ),
  -- Визиты выбранных точек внутри периода
  window_visits AS (
    SELECT v.* FROM visits v
    WHERE v.location_id = ANY(v_locs)
      AND v.at >= v_from::TIMESTAMPTZ
      AND v.at < (v_to + 1)::TIMESTAMPTZ
  ),
  -- Новый в периоде = первый визит вообще пришёлся на этот период
  cohort AS (
    SELECT f.guest_id, f.first_at
    FROM firsts f
    WHERE f.first_at >= v_from::TIMESTAMPTZ
      AND f.first_at < (v_to + 1)::TIMESTAMPTZ
      AND EXISTS (SELECT 1 FROM window_visits w WHERE w.guest_id = f.guest_id)
  ),
  returned AS (
    SELECT c.guest_id, c.first_at,
           EXISTS (SELECT 1 FROM visits v WHERE v.guest_id = c.guest_id
                     AND v.at > c.first_at
                     AND v.at <= c.first_at + INTERVAL '30 days') AS r30,
           EXISTS (SELECT 1 FROM visits v WHERE v.guest_id = c.guest_id
                     AND v.at > c.first_at
                     AND v.at <= c.first_at + INTERVAL '60 days') AS r60,
           EXISTS (SELECT 1 FROM visits v WHERE v.guest_id = c.guest_id
                     AND v.at > c.first_at
                     AND v.at <= c.first_at + INTERVAL '90 days') AS r90,
           EXISTS (SELECT 1 FROM visits v WHERE v.guest_id = c.guest_id
                     AND v.at > c.first_at) AS ever
    FROM cohort c
  ),
  -- Брони периода: исходы, задержка до визита, размер компании
  bookings AS (
    SELECT r.*, f.first_at
    FROM reservations r
    LEFT JOIN firsts f ON f.guest_id = r.guest_id
    WHERE r.org_id = v_org
      AND r.location_id = ANY(v_locs)
      AND NOT r.is_test
      AND r.reserved_at >= v_from::TIMESTAMPTZ
      AND r.reserved_at < (v_to + 1)::TIMESTAMPTZ
  )
  SELECT jsonb_build_object(
    'basis',       'reserved_at',
    'from',        v_from,
    'to',          v_to,
    'locations',   to_jsonb(v_locs),

    -- Новые против вернувшихся: визит гостя, у которого этот визит
    -- первый, против визита гостя, который уже был.
    'guests', jsonb_build_object(
      'new',       (SELECT COUNT(DISTINCT w.guest_id) FROM window_visits w
                    JOIN firsts f ON f.guest_id = w.guest_id
                    WHERE f.first_at >= v_from::TIMESTAMPTZ
                      AND f.first_at < (v_to + 1)::TIMESTAMPTZ),
      'returning', (SELECT COUNT(DISTINCT w.guest_id) FROM window_visits w
                    JOIN firsts f ON f.guest_id = w.guest_id
                    WHERE f.first_at < v_from::TIMESTAMPTZ),
      'total',     (SELECT COUNT(DISTINCT guest_id) FROM window_visits)),

    -- Когорты возврата. `mature` — сколько гостей прожили полное окно;
    -- делить по всем значит занижать возврат у свежего периода.
    'return_rate', jsonb_build_object(
      'cohort_size', (SELECT COUNT(*) FROM cohort),
      'd30', jsonb_build_object(
        'mature',   (SELECT COUNT(*) FROM returned WHERE first_at <= NOW() - INTERVAL '30 days'),
        'returned', (SELECT COUNT(*) FROM returned WHERE r30 AND first_at <= NOW() - INTERVAL '30 days')),
      'd60', jsonb_build_object(
        'mature',   (SELECT COUNT(*) FROM returned WHERE first_at <= NOW() - INTERVAL '60 days'),
        'returned', (SELECT COUNT(*) FROM returned WHERE r60 AND first_at <= NOW() - INTERVAL '60 days')),
      'd90', jsonb_build_object(
        'mature',   (SELECT COUNT(*) FROM returned WHERE first_at <= NOW() - INTERVAL '90 days'),
        'returned', (SELECT COUNT(*) FROM returned WHERE r90 AND first_at <= NOW() - INTERVAL '90 days')),
      -- Повтор после первого визита без ограничения по сроку
      'ever',      (SELECT COUNT(*) FROM returned WHERE ever)),

    -- Исходы визитов: отмены и неявки в долях, а не в штуках — иначе
    -- их не сравнить между каналами разного размера.
    'outcomes', jsonb_build_object(
      'total',     (SELECT COUNT(*) FROM bookings),
      'completed', (SELECT COUNT(*) FROM bookings WHERE status = 'completed'
                      OR (status = 'confirmed' AND reserved_at < NOW())),
      'cancelled', (SELECT COUNT(*) FROM bookings WHERE status = 'cancelled'),
      'no_show',   (SELECT COUNT(*) FROM bookings WHERE status = 'no_show'),
      'rejected',  (SELECT COUNT(*) FROM bookings WHERE status = 'rejected')),

    -- Запас до визита и размер компании: по ним настраивают смены
    'lead_time', jsonb_build_object(
      'avg_hours', (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (reserved_at - created_at)) / 3600)::NUMERIC, 1)
                    FROM bookings WHERE created_at IS NOT NULL),
      'avg_party', (SELECT ROUND(AVG(party_size), 1) FROM bookings)),

    -- Качество канала: не заявки, а СОСТОЯВШИЕСЯ визиты. Канал, дающий
    -- много броней и мало визитов, дорог, и это должно быть видно.
    'by_source', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'source',    COALESCE(src, 'unknown'),
               'bookings',  n,
               'completed', done,
               'no_show',   ns,
               'cancelled', cx)
             ORDER BY n DESC)
      FROM (
        SELECT COALESCE(source, 'unknown') AS src,
               COUNT(*)::INTEGER AS n,
               COUNT(*) FILTER (WHERE status = 'completed'
                 OR (status = 'confirmed' AND reserved_at < NOW()))::INTEGER AS done,
               COUNT(*) FILTER (WHERE status = 'no_show')::INTEGER AS ns,
               COUNT(*) FILTER (WHERE status = 'cancelled')::INTEGER AS cx
        FROM bookings GROUP BY 1
      ) s), '[]'::jsonb),

    -- Конверсия листа ожидания: записались → согласились на слот
    'waitlist', jsonb_build_object(
      'entries',   (SELECT COUNT(*) FROM waitlist_entries w
                    WHERE w.org_id = v_org AND w.location_id = ANY(v_locs)
                      AND w.wanted_date BETWEEN v_from AND v_to),
      'offered',   (SELECT COUNT(*) FROM waitlist_entries w
                    WHERE w.org_id = v_org AND w.location_id = ANY(v_locs)
                      AND w.wanted_date BETWEEN v_from AND v_to
                      AND w.offer_at IS NOT NULL),
      'seated',    (SELECT COUNT(*) FROM waitlist_entries w
                    WHERE w.org_id = v_org AND w.location_id = ANY(v_locs)
                      AND w.wanted_date BETWEEN v_from AND v_to
                      AND w.reservation_id IS NOT NULL)),

    -- Деньги — только там, где есть касса. У standalone Reserve блок
    -- пуст, а не нулевой: ноль описывал бы гостей, которые ничего не
    -- потратили, а не отсутствие кассы.
    'money', CASE WHEN EXISTS (
        SELECT 1 FROM orders o WHERE o.org_id = v_org AND o.location_id = ANY(v_locs)
          AND o.status IN ('paid', 'fulfilled')
          AND COALESCE(o.paid_at, o.created_at) >= v_from::TIMESTAMPTZ
          AND COALESCE(o.paid_at, o.created_at) < (v_to + 1)::TIMESTAMPTZ)
      THEN (
        SELECT jsonb_build_object(
          'revenue',   COALESCE(SUM(o.total), 0),
          'orders',    COUNT(*),
          'avg_check', ROUND(AVG(o.total))::INTEGER)
        FROM orders o
        WHERE o.org_id = v_org AND o.location_id = ANY(v_locs)
          AND o.status IN ('paid', 'fulfilled')
          AND COALESCE(o.paid_at, o.created_at) >= v_from::TIMESTAMPTZ
          AND COALESCE(o.paid_at, o.created_at) < (v_to + 1)::TIMESTAMPTZ)
      ELSE NULL END
  ) INTO v_out;

  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION guest_retention_analytics_web(UUID[], DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION guest_retention_analytics_web(UUID[], DATE, DATE)
  TO authenticated, service_role;

COMMENT ON FUNCTION guest_retention_analytics_web(UUID[], DATE, DATE) IS
  'Аналитика удержания (159): новые против вернувшихся, когорты возврата 30/60/90 с созревшей базой, исходы, качество канала по состоявшимся визитам, конверсия листа ожидания и деньги только при наличии кассы.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only: только новая функция. Функциональный откат — отозвать
-- EXECUTE у `authenticated`.
--
-- СВЕРКА (обязательна перед доверием числам): за выбранный период
--   SELECT COUNT(DISTINCT guest_id) FROM reservations
--   WHERE location_id = ANY(...) AND NOT is_test
--     AND (status = 'completed' OR (status='confirmed' AND reserved_at < NOW()))
--     AND reserved_at >= '<from>' AND reserved_at < '<to>';
-- должно сойтись с `guests.total` минус гости, пришедшие только по
-- заказам кассы без брони.
-- ============================================================
