-- ============================================================
-- 161: один канонический счётчик визитов
--
-- ЗАЧЕМ.
--
-- На живой приёмке один и тот же гость показывался с двумя разными
-- числами: 6 визитов в строке списка и 4 в карточке. Хуже того,
-- читалка объявляла строку как «4 visits», пока в видимой ячейке
-- стояло 6 — зрячий и незрячий получали разные факты об одном человеке.
--
-- Причина в том, что в ответе живут ДВА счётчика с похожими именами:
--
--   * `guests.visits` — счётчик лояльности, его заполняет только касса;
--   * `why_segment.visits` (155) — состоявшиеся визиты: завершённые
--     брони ПЛЮС оплаченные заказы без брони.
--
-- Часть экранов читала первый, часть второй, и оба выглядели как
-- «визиты».
--
-- РЕШЕНИЕ.
--
-- Явное имя `combined_visits` в обоих ответах. Считать сложением на
-- клиенте нельзя: бронь, посаженную в заказ, тогда учли бы дважды —
-- поэтому величина приходит с сервера, где вычет уже сделан (155).
--
-- `visits` НЕ удаляется и не переопределяется: это счётчик лояльности,
-- он складывается при слиянии профилей и показывается в блоке баллов.
-- Разные понятия остаются разными полями.
--
-- ⚠️ ТРЕБУЕТ 155 (guest_retention_facts), 156 (карточка клиента).
-- Миграции 155 и 156 НЕ редактируются — здесь их функции заменяются
-- целиком с добавленным полем.
-- ============================================================

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
    -- Канонический счётчик визитов: брони ПЛЮС кассовые заказы без
    -- брони. Имя явное, потому что рядом живёт legacy `visits` —
    -- счётчик лояльности, который заполняет только касса.
    || jsonb_build_object('combined_visits', p.real_visits)
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
END $$;;

CREATE OR REPLACE FUNCTION get_guest_card(
  p_guest_id UUID,
  p_limit    INTEGER DEFAULT 20
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_guest    guests%ROWTYPE;
  v_limit    INTEGER := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_orders   JSONB;
  v_favs     JSONB;
  v_events   JSONB;
  v_mode     TEXT;
  v_facts    RECORD;
  v_next     JSONB;
  v_usual    JSONB;
  v_history  JSONB;
BEGIN
  -- RLS сама отсечёт чужую org: guests_all скоупит по auth_org_id()
  SELECT * INTO v_guest FROM guests WHERE id = p_guest_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guest not found';
  END IF;

  -- Последние заказы с позициями. Отменённые строки (voided_at) в состав
  -- не попадают — гость их не покупал, но сам заказ показываем.
  SELECT COALESCE(jsonb_agg(o ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_orders
  FROM (
    SELECT
      ord.id,
      ord.daily_number,
      ord.total,
      ord.status,
      ord.created_at,
      ord.loyalty_discount,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name',         oi.name,
          'variant_name', oi.variant_name,
          'qty',          oi.qty,
          'line_total',   oi.line_total
        ) ORDER BY oi.name)
        FROM order_items oi
        WHERE oi.order_id = ord.id AND oi.voided_at IS NULL
      ), '[]'::jsonb) AS items
    FROM orders ord
    WHERE ord.guest_id = p_guest_id
    ORDER BY ord.created_at DESC
    LIMIT v_limit
  ) o;

  -- Любимые позиции: топ-5 по суммарному количеству за всё время
  SELECT COALESCE(jsonb_agg(f ORDER BY f.qty DESC), '[]'::jsonb)
  INTO v_favs
  FROM (
    SELECT oi.name, SUM(oi.qty)::INTEGER AS qty
    FROM order_items oi
    JOIN orders ord ON ord.id = oi.order_id
    WHERE ord.guest_id = p_guest_id
      AND oi.voided_at IS NULL
      AND ord.status IN ('paid', 'fulfilled')
    GROUP BY oi.name
    ORDER BY SUM(oi.qty) DESC
    LIMIT 5
  ) f;

  -- Движения баллов/штампов (031): начисления, списания, коррекции
  SELECT COALESCE(jsonb_agg(e ORDER BY e.created_at DESC), '[]'::jsonb)
  INTO v_events
  FROM (
    SELECT le.kind, le.stamps_delta, le.points_delta, le.created_at, le.order_id
    FROM loyalty_events le
    WHERE le.guest_id = p_guest_id
    ORDER BY le.created_at DESC
    LIMIT v_limit
  ) e;

  -- 115: режим программы — с точки последнего заказа, иначе любой точки org
  SELECT l.loyalty_mode INTO v_mode
  FROM orders ord
  JOIN locations l ON l.id = ord.location_id
  WHERE ord.guest_id = p_guest_id
  ORDER BY ord.created_at DESC
  LIMIT 1;

  IF v_mode IS NULL THEN
    SELECT l.loyalty_mode INTO v_mode
    FROM locations l
    WHERE l.org_id = v_guest.org_id
    ORDER BY l.created_at
    LIMIT 1;
  END IF;

  -- ── Ресторанная часть (156) ────────────────────────────────

  -- Ближайшая живая бронь: первое, что спрашивает хостес, открывая
  -- карточку от визита.
  SELECT jsonb_build_object(
           'id',            r.id,
           'reserved_at',   r.reserved_at,
           'party_size',    r.party_size,
           'status',        r.status,
           'location_id',   r.location_id,
           'location_name', l.name)
  INTO v_next
  FROM reservations r
  JOIN locations l ON l.id = r.location_id
  WHERE r.guest_id = p_guest_id
    AND r.status IN ('new', 'confirmed')
    AND r.reserved_at >= NOW()
    AND NOT r.is_test
  ORDER BY r.reserved_at
  LIMIT 1;

  /*
   * Привычка гостя — в часах ТОЧКИ.
   *
   * В UTC вечерний гость Иерусалима переезжает на предыдущий день, и
   * «обычно приходит в пятницу» превращается в четверг. Считаем по
   * состоявшимся визитам: намерения (отменённые брони) привычкой не
   * являются.
   */
  SELECT jsonb_build_object(
           'dow',   (SELECT dow FROM (
                       SELECT EXTRACT(DOW FROM r.reserved_at AT TIME ZONE
                                COALESCE(NULLIF(l.timezone, ''), 'Asia/Jerusalem'))::INTEGER AS dow,
                              COUNT(*) AS n
                       FROM reservations r
                       JOIN locations l ON l.id = r.location_id
                       WHERE r.guest_id = p_guest_id AND NOT r.is_test
                         AND (r.status = 'completed'
                              OR (r.status = 'confirmed' AND r.reserved_at < NOW()))
                       GROUP BY 1 ORDER BY n DESC, dow LIMIT 1) d),
           'hour',  (SELECT hour FROM (
                       SELECT EXTRACT(HOUR FROM r.reserved_at AT TIME ZONE
                                COALESCE(NULLIF(l.timezone, ''), 'Asia/Jerusalem'))::INTEGER AS hour,
                              COUNT(*) AS n
                       FROM reservations r
                       JOIN locations l ON l.id = r.location_id
                       WHERE r.guest_id = p_guest_id AND NOT r.is_test
                         AND (r.status = 'completed'
                              OR (r.status = 'confirmed' AND r.reserved_at < NOW()))
                       GROUP BY 1 ORDER BY n DESC, hour LIMIT 1) h),
           'party', (SELECT ROUND(AVG(r.party_size), 1)
                     FROM reservations r
                     WHERE r.guest_id = p_guest_id AND NOT r.is_test
                       AND (r.status = 'completed'
                            OR (r.status = 'confirmed' AND r.reserved_at < NOW()))))
  INTO v_usual;

  -- Визиты списком: «8 раз» должно быть проверяемо глазами, иначе это
  -- просто число, которому владелец не верит.
  SELECT COALESCE(jsonb_agg(h ORDER BY h.reserved_at DESC), '[]'::jsonb)
  INTO v_history
  FROM (
    SELECT r.id, r.reserved_at, r.status, r.party_size, r.note,
           r.created_via, r.source, r.location_id,
           l.name AS location_name,
           z.name AS zone_name,
           r.order_id IS NOT NULL AS on_register
    FROM reservations r
    JOIN locations l ON l.id = r.location_id
    LEFT JOIN table_zones z ON z.id = r.zone_id
    WHERE r.guest_id = p_guest_id AND NOT r.is_test
    ORDER BY r.reserved_at DESC
    LIMIT v_limit
  ) h;

  -- Метка в списке и метка в карточке обязаны совпадать, поэтому
  -- считает их одна функция (155), а не вторая формула здесь.
  SELECT * INTO v_facts FROM guest_retention_facts(ARRAY[p_guest_id], NULL);

  RETURN jsonb_build_object(
    'id',            v_guest.id,
    'phone',         v_guest.phone,
    'name',          v_guest.name,
    'notes',         v_guest.notes,
    'tags',          to_jsonb(v_guest.tags),
    'stamps',        v_guest.stamps,
    'points',        v_guest.points,
    'visits',        v_guest.visits,
    'total_spent',   v_guest.total_spent,
    'last_visit_at', v_guest.last_visit_at,
    'created_at',    v_guest.created_at,
    'loyalty_mode',  COALESCE(v_mode, 'off'),
    -- Канонический счётчик визитов. `visits` выше — счётчик лояльности
    -- кассы, и это РАЗНЫЕ величины: строка списка, карточка, подпись для
    -- читалки и выгрузка обязаны показывать именно этот.
    'combined_visits', v_facts.visits,
    'orders',        v_orders,
    'favorites',     v_favs,
    'events',        v_events,
    -- Ресторанный блок (121). У точки без POS orders/favorites
    -- пусты, а этот блок полон — профиль остаётся осмысленным
    -- и без кассы, то есть standalone Reserve не ломается.
    'reservations',  guest_reservation_stats(p_guest_id),
    'next_visit',    v_next,
    'usual',         v_usual,
    'visit_history', v_history,
    'segments',      to_jsonb(guest_segment_set(
                       v_facts.visits, v_facts.first_at, v_facts.last_at,
                       v_facts.no_shows, v_facts.upcoming, v_facts.spend)),
    'why_segment',   jsonb_build_object(
                       'visits',        v_facts.visits,
                       'from_bookings', v_facts.rsv_visits,
                       'from_register', v_facts.pos_visits,
                       'first_at',      v_facts.first_at,
                       'last_at',       v_facts.last_at,
                       'days_since',    CASE WHEN v_facts.last_at IS NULL THEN NULL
                                             ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - v_facts.last_at)) / 86400)::INTEGER END,
                       'avg_gap_days',  CASE WHEN v_facts.visits >= 2
                                               AND v_facts.first_at IS NOT NULL AND v_facts.last_at IS NOT NULL
                                             THEN ROUND((EXTRACT(EPOCH FROM (v_facts.last_at - v_facts.first_at))
                                                         / 86400 / (v_facts.visits - 1))::NUMERIC, 1)
                                             ELSE NULL END,
                       'spend',         v_facts.spend,
                       'no_shows',      v_facts.no_shows,
                       'cancelled',     v_facts.cancelled,
                       'upcoming',      v_facts.upcoming)
  );
END $$;;

REVOKE EXECUTE ON FUNCTION get_backoffice_guests(
  TEXT, INTEGER, UUID, TEXT[], INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, UUID[], INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_backoffice_guests(
  TEXT, INTEGER, UUID, TEXT[], INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, UUID[], INTEGER)
  TO authenticated;

REVOKE EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) TO authenticated;

COMMENT ON FUNCTION get_guest_card(UUID, INTEGER) IS
  'Карточка клиента (114/121/156/161). combined_visits — канонический счётчик визитов (брони + касса без двойного счёта); visits — счётчик лояльности кассы.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only: схема не менялась, добавлено одно поле в двух ответах.
-- Прежние ключи сохранены, поэтому выложенный кабинет продолжает
-- работать. Откат — вернуть тела 155/156 новой миграцией.
--
-- ПРОВЕРКА под веб-владельцем:
--   SELECT get_guest_card('<guest>') ->> 'combined_visits';
--   SELECT get_backoffice_guests(p_limit => 1) -> 0 ->> 'combined_visits';
-- ============================================================
