-- ============================================================
-- 156: ресторанная часть карточки клиента
--
-- ЗАЧЕМ.
--
-- Карточка гостя знала заказы, любимые позиции и баллы — то есть всё,
-- что записывает КАССА. Хостес, открывая её от визита, не получал
-- ответа ни на один свой вопрос: придёт ли этот человек ещё раз и
-- когда, где он обычно садится, во сколько приходит и сколько их
-- обычно. У точки без кассы карточка была почти пустой.
--
-- `guest_reservation_stats` (121) отвечала на часть этого, но в ней нет
-- ни следующей брони, ни привычного дня и часа, ни списка визитов — а
-- именно они превращают «карточку клиента» в подсказку смене.
--
-- ЧТО ДОБАВЛЕНО.
--
--   * `next_visit` — ближайшая живая бронь: когда, сколько человек, где;
--   * `usual` — привычные день недели, час и размер компании,
--     посчитанные В ЧАСАХ ТОЧКИ. Считать их в UTC значит сдвинуть
--     вечернего гостя на предыдущий день;
--   * `visit_history` — последние визиты списком, чтобы «8 раз» можно
--     было проверить глазами;
--   * `segments` и `why_segment` — те же, что в списке (155). Метка в
--     списке и метка в карточке обязаны совпадать, поэтому считает их
--     одна функция.
--
-- ЧЕГО НЕТ НАМЕРЕННО.
--
-- Аллергии и потребностей доступности не выводятся из заказанного.
-- «Брал безглютеновый хлеб» не означает «целиакия», и ошибка здесь
-- опаснее пустого поля. Такие сведения остаются явной заметкой
-- сотрудника (`guests.notes`, 121) с аудитом правок.
--
-- ⚠️ ТРЕБУЕТ 121 (guest_reservation_stats), 155 (guest_retention_facts,
--    guest_segment_set).
-- ============================================================

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
END $$;

REVOKE EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) TO authenticated;

COMMENT ON FUNCTION get_guest_card(UUID, INTEGER) IS
  'Карточка клиента (114/121/156): касса, лояльность и ресторанная часть — следующая бронь, привычные день/час/компания, история визитов и сегменты.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only: схема не менялась, функция расширена новыми ключами.
-- Прежние ключи и их смысл сохранены, поэтому выложенный кабинет
-- работает без изменений. Откат — вернуть тело 121 новой миграцией.
--
-- ПРОВЕРКА под веб-владельцем:
--   SELECT get_guest_card('<guest_id>') -> 'next_visit';
--   SELECT get_guest_card('<guest_id>') -> 'usual';
--   SELECT get_guest_card('<guest_id>') -> 'segments';
-- ============================================================
