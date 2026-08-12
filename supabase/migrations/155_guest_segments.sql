-- ============================================================
-- 155: автоматические сегменты гостя с доказательством
--
-- ЗАЧЕМ.
--
-- Сегменты кабинета были ФИЛЬТРАМИ ПО ТРАТАМ: «постоянные» = три визита
-- лояльности, «топ» = 200 ₪, «пропали» = 90 дней без покупки. Все три
-- считаются по `guests.visits` и `guests.total_spent`, которые
-- заполняет КАССА. У точки, купившей один ANGLE Reserve, эти колонки
-- нули: гость, который бронирует стол каждую пятницу полгода, не
-- попадал ни в один сегмент вообще.
--
-- Второе: метка ничего не объясняла. «Пропал» без «был у вас 8 раз,
-- последний — 4 месяца назад» невозможно ни проверить, ни оспорить, и
-- владелец ей просто не верит.
--
-- ЧТО СЧИТАЕТСЯ ВИЗИТОМ.
--
-- Состоявшийся визит = завершённая бронь (`completed`, либо
-- `confirmed` с прошедшим временем) ПЛЮС оплаченный заказ кассы,
-- который НЕ привязан к броне. Сложение без этого условия считало бы
-- посаженную в заказ бронь дважды — она даёт и завершённый визит, и
-- оплаченный заказ.
--
-- НЕ визит: тестовая бронь (126), отклонённая заявка, отменённая бронь
-- и неявка. Считать их значило бы наградить заведение за отказы.
--
-- ПОРОГИ И ГРАНИЦЫ.
--
-- Пороги — параметры со значениями по умолчанию, а не константы в
-- запросе: «постоянный» у кофейни и у ресторана — разные числа.
-- Интервалы считаются в сутках от `NOW()`, без привязки к календарной
-- полуночи: порог «180 дней без визита» не должен зависеть от того, в
-- каком часовом поясе стоит точка и когда открылся отчёт.
--
-- Сегмент — НЕ колонка. Он выводится в момент запроса: записанная в
-- строку метка устаревает молча в тот день, когда гость пришёл снова.
--
-- ⚠️ ТРЕБУЕТ 131 (get_backoffice_guests, merged_into/anonymized_at),
--    121 (reservations.guest_id).
-- ============================================================

/**
 * Факты о госте, из которых выводится сегмент.
 *
 * Одна функция на весь набор гостей — не вызов на каждого: страница
 * базы клиентов это сто строк, и сто отдельных подсчётов истории
 * превратили бы её в самый медленный экран кабинета.
 *
 * `p_location_ids` сужает ФАКТЫ, а не гостей: клиентская база общая на
 * организацию (лояльность одна), и «покажи гостей этой точки» означает
 * «считай по визитам этой точки», а не «заведи ей своих гостей».
 */
CREATE OR REPLACE FUNCTION guest_retention_facts(
  p_guest_ids    UUID[],
  p_location_ids UUID[] DEFAULT NULL
) RETURNS TABLE (
  guest_id     UUID,
  rsv_visits   INTEGER,
  pos_visits   INTEGER,
  visits       INTEGER,
  first_at     TIMESTAMPTZ,
  last_at      TIMESTAMPTZ,
  no_shows     INTEGER,
  cancelled    INTEGER,
  upcoming     INTEGER,
  spend        INTEGER
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH scope AS (SELECT unnest(p_guest_ids) AS id),
  rsv AS (
    SELECT r.guest_id,
           COUNT(*) FILTER (
             WHERE NOT r.is_test
               AND (r.status = 'completed'
                    OR (r.status = 'confirmed' AND r.reserved_at < NOW())))::INTEGER AS visits,
           MIN(r.reserved_at) FILTER (
             WHERE NOT r.is_test
               AND (r.status = 'completed'
                    OR (r.status = 'confirmed' AND r.reserved_at < NOW()))) AS first_at,
           MAX(r.reserved_at) FILTER (
             WHERE NOT r.is_test
               AND (r.status = 'completed'
                    OR (r.status = 'confirmed' AND r.reserved_at < NOW()))) AS last_at,
           COUNT(*) FILTER (WHERE r.status = 'no_show' AND NOT r.is_test)::INTEGER AS no_shows,
           COUNT(*) FILTER (WHERE r.status = 'cancelled' AND NOT r.is_test)::INTEGER AS cancelled,
           COUNT(*) FILTER (
             WHERE r.status IN ('new', 'confirmed')
               AND r.reserved_at >= NOW() AND NOT r.is_test)::INTEGER AS upcoming
    FROM reservations r
    WHERE r.guest_id IN (SELECT id FROM scope)
      AND (p_location_ids IS NULL OR r.location_id = ANY(p_location_ids))
    GROUP BY r.guest_id
  ),
  pos AS (
    -- Заказ, привязанный к броне, уже посчитан завершённым визитом:
    -- второй раз он бы удвоил историю постоянного гостя.
    SELECT o.guest_id,
           COUNT(*)::INTEGER AS visits,
           MIN(COALESCE(o.paid_at, o.created_at)) AS first_at,
           MAX(COALESCE(o.paid_at, o.created_at)) AS last_at,
           COALESCE(SUM(o.total), 0)::INTEGER AS spend
    FROM orders o
    WHERE o.guest_id IN (SELECT id FROM scope)
      AND o.status IN ('paid', 'fulfilled')
      AND (p_location_ids IS NULL OR o.location_id = ANY(p_location_ids))
      AND NOT EXISTS (SELECT 1 FROM reservations r2 WHERE r2.order_id = o.id)
    GROUP BY o.guest_id
  )
  SELECT
    s.id,
    COALESCE(rsv.visits, 0),
    COALESCE(pos.visits, 0),
    COALESCE(rsv.visits, 0) + COALESCE(pos.visits, 0),
    LEAST(rsv.first_at, COALESCE(pos.first_at, rsv.first_at)),
    GREATEST(rsv.last_at, COALESCE(pos.last_at, rsv.last_at)),
    COALESCE(rsv.no_shows, 0),
    COALESCE(rsv.cancelled, 0),
    COALESCE(rsv.upcoming, 0),
    COALESCE(pos.spend, 0)
  FROM scope s
  LEFT JOIN rsv ON rsv.guest_id = s.id
  LEFT JOIN pos ON pos.guest_id = s.id
$$;

REVOKE ALL ON FUNCTION guest_retention_facts(UUID[], UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION guest_retention_facts(UUID[], UUID[]) TO authenticated, service_role;

/**
 * Факты → набор сегментов.
 *
 * Сегментов у гостя НЕСКОЛЬКО, и это не недосмотр: «постоянный» и «с
 * будущей бронью» — разные ответы на разные вопросы, и выбирать между
 * ними значило бы прятать один из них. Экран фильтрует по вхождению.
 *
 * Порядок в массиве — от общего к частному, чтобы первый элемент
 * годился как основная подпись карточки.
 */
CREATE OR REPLACE FUNCTION guest_segment_set(
  p_visits      INTEGER,
  p_first_at    TIMESTAMPTZ,
  p_last_at     TIMESTAMPTZ,
  p_no_shows    INTEGER,
  p_upcoming    INTEGER,
  p_spend       INTEGER,
  p_new_days    INTEGER DEFAULT 90,
  p_regular     INTEGER DEFAULT 5,
  p_vip_spend   INTEGER DEFAULT 50000,
  p_vip_visits  INTEGER DEFAULT 10,
  p_lost_days   INTEGER DEFAULT 180,
  p_no_show_max INTEGER DEFAULT 2
) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT ARRAY(SELECT s FROM (
    SELECT unnest(ARRAY[
      -- Пришёл впервые и недавно: «новый» через год после единственного
      -- визита — это не новый, это потерянный.
      CASE WHEN p_visits = 1 AND p_first_at IS NOT NULL
            AND p_first_at >= NOW() - make_interval(days => p_new_days)
           THEN 'new' END,
      CASE WHEN p_visits >= 2 THEN 'returning' END,
      CASE WHEN p_visits >= p_regular THEN 'regular' END,
      -- Деньги, когда касса есть; когда её нет — частота визитов.
      -- Ноль трат у standalone Reserve означает «не измеряли», а не
      -- «гость ничего не тратит», и лишать его VIP по этому нулю нельзя.
      CASE WHEN p_spend >= p_vip_spend
             OR (p_spend = 0 AND p_visits >= p_vip_visits)
           THEN 'vip' END,
      -- «Пропал» — про того, кто ХОДИЛ и перестал. Ни разу не пришедший
      -- не пропадал: у него просто нет истории.
      CASE WHEN p_visits >= 1 AND p_last_at IS NOT NULL
            AND p_last_at < NOW() - make_interval(days => p_lost_days)
           THEN 'lost' END,
      -- «Под угрозой» — просрочил СВОЙ обычный ритм, а не общий срок.
      -- Нужны хотя бы три визита: по двум точкам ритма не бывает.
      -- Уже потерянный сюда не попадает: две метки об одном молчании.
      CASE WHEN p_visits >= 3 AND p_first_at IS NOT NULL AND p_last_at IS NOT NULL
            AND p_last_at >= NOW() - make_interval(days => p_lost_days)
            AND EXTRACT(EPOCH FROM (NOW() - p_last_at))
                > 2 * EXTRACT(EPOCH FROM (p_last_at - p_first_at)) / (p_visits - 1)
           THEN 'at_risk' END,
      CASE WHEN p_upcoming > 0 THEN 'upcoming' END,
      CASE WHEN p_no_shows >= p_no_show_max THEN 'repeat_no_show' END
    ]) AS s
  ) x WHERE s IS NOT NULL)
$$;

REVOKE ALL ON FUNCTION guest_segment_set(
  INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER,
  INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION guest_segment_set(
  INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER,
  INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER)
  TO authenticated, service_role;

-- ── База клиентов знает сегменты ─────────────────────────────
-- Старая сигнатура снимается: девять аргументов с умолчаниями и
-- двенадцать с умолчаниями дали бы неоднозначность вызова, а PostgREST
-- зовёт по именам. Выложенный кабинет продолжает работать — новые
-- параметры необязательны.
DROP FUNCTION IF EXISTS get_backoffice_guests(
  TEXT, INTEGER, UUID, TEXT[], INTEGER, INTEGER, INTEGER, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION get_backoffice_guests(
  p_search        TEXT    DEFAULT NULL,
  p_limit         INTEGER DEFAULT 100,
  p_staff_session UUID    DEFAULT NULL,
  p_tags          TEXT[]  DEFAULT NULL,
  p_min_visits    INTEGER DEFAULT NULL,
  p_min_spent     INTEGER DEFAULT NULL,
  p_seen_days     INTEGER DEFAULT NULL,
  p_inactive_days INTEGER DEFAULT NULL,
  p_sort          TEXT    DEFAULT 'recent',
  p_segment       TEXT    DEFAULT NULL,
  p_location_ids  UUID[]  DEFAULT NULL,
  p_offset        INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 5000);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_q      TEXT    := NULLIF(TRIM(COALESCE(p_search, '')), '');
  v_sort   TEXT    := COALESCE(NULLIF(TRIM(COALESCE(p_sort, '')), ''), 'recent');
  v_tags   TEXT[]  := CASE WHEN COALESCE(cardinality(p_tags), 0) = 0 THEN NULL ELSE p_tags END;
  v_seg    TEXT    := NULLIF(TRIM(COALESCE(p_segment, '')), '');
  v_locs   UUID[]  := CASE WHEN COALESCE(cardinality(p_location_ids), 0) = 0
                           THEN NULL ELSE p_location_ids END;
  v_digits TEXT;
  v_result JSONB;
BEGIN
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  v_digits := regexp_replace(COALESCE(v_q, ''), '\D', '', 'g');

  WITH base AS (
    SELECT
      id, phone, name, notes, tags, stamps, points, visits, total_spent,
      last_visit_at, created_at
    FROM guests
    WHERE merged_into IS NULL
      AND anonymized_at IS NULL
      AND (v_q IS NULL
           OR (length(v_digits) >= 3 AND phone LIKE '%' || v_digits || '%')
           OR (length(v_digits) < 3  AND name ILIKE '%' || v_q || '%'))
      AND (v_tags IS NULL OR tags @> v_tags)
      AND (p_min_visits IS NULL OR visits >= p_min_visits)
      AND (p_min_spent  IS NULL OR total_spent >= p_min_spent)
      AND (p_seen_days  IS NULL
           OR last_visit_at >= NOW() - make_interval(days => p_seen_days))
      -- «Пропал» — про того, кто ходил и перестал. Ни разу не пришедший
      -- не пропадал, и в этот сегмент он не попадает.
      AND (p_inactive_days IS NULL
           OR (last_visit_at IS NOT NULL
               AND last_visit_at < NOW() - make_interval(days => p_inactive_days)))
  ),
  facts AS (
    SELECT * FROM guest_retention_facts(
      ARRAY(SELECT id FROM base), v_locs)
  ),
  scored AS (
    SELECT b.*,
           f.visits    AS real_visits,
           f.rsv_visits,
           f.pos_visits,
           f.first_at  AS first_visit_at,
           f.last_at   AS real_last_at,
           f.no_shows,
           f.cancelled AS cancelled_visits,
           f.upcoming,
           f.spend     AS real_spend,
           guest_segment_set(
             f.visits, f.first_at, f.last_at, f.no_shows, f.upcoming, f.spend
           ) AS segments
    FROM base b
    JOIN facts f ON f.guest_id = b.id
  ),
  filtered AS (
    SELECT * FROM scored
    WHERE v_seg IS NULL OR segments @> ARRAY[v_seg]
  ),
  page AS (
    SELECT *,
           COUNT(*) OVER () AS total_rows,
           ROW_NUMBER() OVER (ORDER BY
             CASE WHEN v_sort = 'spend'  THEN real_spend  END DESC NULLS LAST,
             CASE WHEN v_sort = 'visits' THEN real_visits END DESC NULLS LAST,
             CASE WHEN v_sort = 'new'    THEN created_at  END DESC NULLS LAST,
             CASE WHEN v_sort = 'name'   THEN lower(COALESCE(name, phone)) END ASC NULLS LAST,
             COALESCE(real_last_at, last_visit_at) DESC NULLS LAST,
             created_at DESC
           ) AS rn
    FROM filtered
    ORDER BY rn
    OFFSET v_offset
    LIMIT v_limit
  )
  SELECT COALESCE(jsonb_agg(
    (to_jsonb(p) - 'rn' - 'total_rows')
    -- Доказательство метки. Без него «пропал» невозможно ни проверить,
    -- ни оспорить, и владелец ему просто не верит.
    || jsonb_build_object('why_segment', jsonb_build_object(
         'visits',        p.real_visits,
         'from_bookings', p.rsv_visits,
         'from_register', p.pos_visits,
         'first_at',      p.first_visit_at,
         'last_at',       p.real_last_at,
         'days_since',    CASE WHEN p.real_last_at IS NULL THEN NULL
                               ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - p.real_last_at)) / 86400)::INTEGER END,
         'avg_gap_days',  CASE WHEN p.real_visits >= 2
                                 AND p.first_visit_at IS NOT NULL AND p.real_last_at IS NOT NULL
                               THEN ROUND((EXTRACT(EPOCH FROM (p.real_last_at - p.first_visit_at))
                                           / 86400 / (p.real_visits - 1))::NUMERIC, 1)
                               ELSE NULL END,
         'spend',         p.real_spend,
         'no_shows',      p.no_shows,
         'cancelled',     p.cancelled_visits,
         'upcoming',      p.upcoming))
    ORDER BY p.rn), '[]'::jsonb)
  INTO v_result
  FROM page p;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION get_backoffice_guests(
  TEXT, INTEGER, UUID, TEXT[], INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, UUID[], INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_backoffice_guests(
  TEXT, INTEGER, UUID, TEXT[], INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, UUID[], INTEGER)
  TO authenticated;

COMMENT ON FUNCTION get_backoffice_guests(
  TEXT, INTEGER, UUID, TEXT[], INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, UUID[], INTEGER) IS
  'База клиентов с автоматическими сегментами (155). Сегмент выводится в момент запроса и несёт why_segment — числа, из которых он получен.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only, схема не менялась. Функциональный откат — вернуть
-- прежнее тело `get_backoffice_guests` новой миграцией: сегменты
-- нигде не записаны, удалять нечего.
--
-- ⚠️ Старая 9-аргументная сигнатура СНЯТА (DROP). Выложенный кабинет
-- зовёт функцию по именам параметров и продолжает работать: новые три
-- параметра необязательны. Клиент, зовущий позиционно, сломался бы —
-- такого в проекте нет.
--
-- ПРОВЕРКА под веб-владельцем:
--   SELECT get_backoffice_guests(p_segment => 'at_risk');
--   SELECT get_backoffice_guests(p_segment => 'lost', p_limit => 10);
-- ============================================================
