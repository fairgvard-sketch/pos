-- ============================================================
-- 152: каноническая read-модель визита для веб-стола хостес
--
-- ЗАЧЕМ.
--
-- Кабинет собирал стол броней четырьмя независимыми путями: раздел
-- (`ReservationsDesk`) читал заявки дня, полотно (`TimelineDesk`) —
-- настройки, столы, зоны и брони, список (`ReservationList`) — то же
-- самое ещё раз, лист ожидания — столы в третий раз. Один рендер
-- раздела стоил ЧЕТЫРНАДЦАТИ запросов, и каждый компонент держал
-- собственную realtime-подписку на `reservations`: одно событие
-- перезапускало все четыре загрузки.
--
-- Хуже количества — расхождение. Полотно и список показывали одну и ту
-- же бронь, собранную разными выборками, и «что видит хостес» зависело
-- от того, с какой вкладки он пришёл.
--
-- Здесь один ответ на вопрос «что в зале за это окно»: часы точки,
-- зоны, столы и визиты вместе с контекстом гостя и сводкой POS-заказа.
--
-- ЧТО СОЗНАТЕЛЬНО НЕ ВОШЛО.
--
-- Заметка и метки гостя (121) в списочную модель НЕ попадают. Они
-- нужны, когда визит открыли, а не когда полотно рисует двести блоков;
-- отдавать их пачкой значит рассылать внутренние сведения о всех
-- гостях дня ради одного, которого откроют. Их отдаёт `get_visit_web`.
--
-- Состав POS-заказа не дублируется: позиции живут в `orders`, и вторая
-- копия неизбежно разошлась бы с первой. Наружу идут только номер,
-- операционный статус, сумма и факт оплаты.
--
-- ⚠️ ТРЕБУЕТ 120 (_reservation_web_member), 119 (reservation_tables),
--    121 (reservations.guest_id, guest_reservation_stats), 131 (merge).
-- ============================================================

-- ── 1. Контекст гостя списком ────────────────────────────────
/**
 * Сжатый контекст гостя для карточек и блоков.
 *
 * Одним проходом по броням организации для НАБОРА гостей — потому что
 * альтернатива (позвать `guest_reservation_stats` на каждый визит) это
 * N+1 в самом горячем месте продукта: двести блоков полотна дали бы
 * двести вызовов.
 *
 * Слияние (131) переставляет `reservations.guest_id` на оставшийся
 * профиль, поэтому группировка по колонке уже канонична и
 * `resolve_guest_id` здесь не нужен.
 *
 * Состоявшийся визит считается ровно так же, как в
 * `guest_reservation_stats` (121): явно завершённый либо подтверждённый
 * и уже прошедший. Две формулы «сколько раз он у нас был» разъехались
 * бы через месяц, и хостес не смог бы объяснить, какой из двух цифр
 * верить.
 */
CREATE OR REPLACE FUNCTION _visit_guest_context(p_guest_ids UUID[])
RETURNS TABLE (
  guest_id  UUID,
  visits    INTEGER,
  upcoming  INTEGER,
  cancelled INTEGER,
  no_shows  INTEGER,
  avg_party NUMERIC,
  last_at   TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    r.guest_id,
    COUNT(*) FILTER (
      WHERE r.status = 'completed'
         OR (r.status = 'confirmed' AND r.reserved_at < NOW()))::INTEGER,
    COUNT(*) FILTER (
      WHERE r.status IN ('new', 'confirmed') AND r.reserved_at >= NOW())::INTEGER,
    COUNT(*) FILTER (WHERE r.status = 'cancelled')::INTEGER,
    COUNT(*) FILTER (WHERE r.status = 'no_show')::INTEGER,
    ROUND(AVG(r.party_size) FILTER (WHERE r.status <> 'rejected'), 1),
    MAX(r.reserved_at) FILTER (
      WHERE r.status = 'completed'
         OR (r.status = 'confirmed' AND r.reserved_at < NOW()))
  FROM reservations r
  WHERE r.org_id = auth_org_id()
    AND r.guest_id = ANY(p_guest_ids)
    -- Тестовая бронь (126) занимает настоящий стол, но историей гостя
    -- не является: она не должна делать владельца постоянным гостем.
    AND NOT r.is_test
  GROUP BY r.guest_id
$$;

REVOKE ALL ON FUNCTION _visit_guest_context(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _visit_guest_context(UUID[]) TO authenticated, service_role;

-- ── 2. Сводка POS-заказа ─────────────────────────────────────
/**
 * Маленькая правда о заказе, в который посадили визит (057).
 *
 * До этого кабинет знал ровно `order_id IS NOT NULL` и печатал одну
 * фразу «визит ведётся на кассе». Хостес не мог ответить ни на «они уже
 * заплатили?», ни на «какой у них номер» — за этим шли к терминалу.
 *
 * Мутировать заказ отсюда по-прежнему нельзя: правило `pos_mode`
 * (102/120/127) не меняется, это только чтение.
 */
CREATE OR REPLACE FUNCTION _visit_order_summary(p_order_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id',        o.id,
    'number',    o.daily_number,
    'status',    o.status,
    'type',      o.order_type,
    -- Агороты наружу как есть: перевод в шекели — дело отображения
    -- (инвариант денег), и делить на сто в SQL значит завести второе
    -- место, где сумма может округлиться иначе.
    'total',     o.total,
    'paid',      o.paid_at IS NOT NULL,
    'opened_at', o.created_at,
    'paid_at',   o.paid_at
  )
  FROM orders o
  WHERE o.id = p_order_id AND o.org_id = auth_org_id()
$$;

REVOKE ALL ON FUNCTION _visit_order_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _visit_order_summary(UUID) TO authenticated, service_role;

-- ── 3. Стол хостес одним ответом ─────────────────────────────
/**
 * Часы, зоны, столы и визиты окна — один вызов вместо четырёх выборок.
 *
 * `p_limit` честный: упёрлись — вызывающий об этом узнаёт (`capped`), а
 * не молча теряет строки. Потолок окна 400 дней такой же, как у отчёта
 * (125): синхронный ответ не должен превращаться в выгрузку года.
 *
 * Выключенные столы ОСТАЮТСЯ в ответе с признаком `blocked`: полная
 * география зала — часть ответа на вопрос «что с залом», а спрятанный
 * стол делает зал свободнее, чем он есть.
 */
CREATE OR REPLACE FUNCTION get_reservation_desk_web(
  p_location_id UUID,
  p_from        TIMESTAMPTZ,
  p_to          TIMESTAMPTZ,
  p_limit       INTEGER DEFAULT 500
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_limit  INTEGER := GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
  v_loc    RECORD;
  v_out    JSONB;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'invalid_range';
  END IF;
  IF p_to - p_from > INTERVAL '400 days' THEN
    RAISE EXCEPTION 'range_too_wide';
  END IF;

  SELECT timezone, COALESCE(settings -> 'reservations', '{}'::jsonb) AS rsv
  INTO v_loc
  FROM locations WHERE id = p_location_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  WITH win AS (
    SELECT r.*
    FROM reservations r
    WHERE r.org_id = v_org
      AND r.location_id = p_location_id
      AND r.reserved_at >= p_from
      AND r.reserved_at <  p_to
    ORDER BY r.reserved_at
    -- +1 строка — способ узнать, что за окном ещё есть визиты, не
    -- считая их все вторым запросом.
    LIMIT v_limit + 1
  ),
  kept AS (SELECT * FROM win ORDER BY reserved_at LIMIT v_limit),
  ctx AS (
    SELECT * FROM _visit_guest_context(
      ARRAY(SELECT DISTINCT guest_id FROM kept WHERE guest_id IS NOT NULL))
  )
  SELECT jsonb_build_object(
    'timezone', COALESCE(v_loc.timezone, 'Asia/Jerusalem'),
    'schedule', v_loc.rsv -> 'schedule',
    'from',     p_from,
    'to',       p_to,
    'capped',   (SELECT COUNT(*) FROM win) > v_limit,
    'zones', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', z.id, 'name', z.name, 'sort_order', z.sort_order)
             ORDER BY z.sort_order, z.name)
      FROM table_zones z
      WHERE z.location_id = p_location_id AND z.is_active
    ), '[]'::jsonb),
    'tables', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',         t.id,
               'label',      t.label,
               'seats',      COALESCE(t.seats, 2),
               'zone_id',    t.zone_id,
               'zone_name',  z.name,
               'sort_order', COALESCE(t.sort_order, 0),
               'blocked',    (NOT t.is_active OR t.status = 'disabled'))
             ORDER BY COALESCE(t.sort_order, 0), t.label)
      FROM tables t
      LEFT JOIN table_zones z ON z.id = t.zone_id
      WHERE t.location_id = p_location_id AND t.org_id = v_org
    ), '[]'::jsonb),
    'visits', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',             k.id,
               'status',         k.status,
               'customer_name',  k.customer_name,
               'customer_phone', k.customer_phone,
               'party_size',     k.party_size,
               'reserved_at',    k.reserved_at,
               'duration_min',   k.duration_min,
               'note',           k.note,
               'reject_reason',  k.reject_reason,
               'zone_id',        k.zone_id,
               'is_test',        k.is_test,
               'created_via',    k.created_via,
               'source',         k.source,
               'rules_ack',      k.rules_ack,
               'order_id',       k.order_id,
               'guest_id',       k.guest_id,
               -- Столы приходят строками связи (119), включая
               -- добавленные объединением; основной идёт первым, чтобы
               -- клиенту не пришлось знать правило «первый — главный».
               'table_ids', COALESCE((
                 SELECT jsonb_agg(rt.table_id ORDER BY rt.is_primary DESC, rt.table_id)
                 FROM reservation_tables rt WHERE rt.reservation_id = k.id
               ), '[]'::jsonb),
               -- Отметки времени, из которых собирается история визита.
               -- Отдаём то, что записано, и ничего сверх: недостающий
               -- переход честнее не показать, чем додумать по статусу.
               'created_at',           k.created_at,
               'decided_at',           k.decided_at,
               'arrived_at',           k.arrived_at,
               'cancelled_at',         k.cancelled_at,
               'rescheduled_at',       k.rescheduled_at,
               'previous_reserved_at', k.previous_reserved_at,
               'reschedule_count',     k.reschedule_count,
               'confirm_requested_at', k.confirm_requested_at,
               'guest_confirmed_at',   k.guest_confirmed_at,
               'order',  _visit_order_summary(k.order_id),
               'guest',  CASE WHEN k.guest_id IS NULL THEN NULL ELSE jsonb_build_object(
                           'id',        k.guest_id,
                           'visits',    COALESCE(c.visits, 0),
                           'upcoming',  COALESCE(c.upcoming, 0),
                           'cancelled', COALESCE(c.cancelled, 0),
                           'no_shows',  COALESCE(c.no_shows, 0),
                           'avg_party', c.avg_party,
                           'last_at',   c.last_at) END)
             ORDER BY k.reserved_at)
      FROM kept k
      LEFT JOIN ctx c ON c.guest_id = k.guest_id
    ), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION get_reservation_desk_web(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_reservation_desk_web(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
  TO authenticated, service_role;

-- ── 4. Карточка визита ───────────────────────────────────────
/**
 * Всё, что нужно открытому визиту, одним вызовом.
 *
 * Полотно и список уже держат визит целиком, поэтому панель открывается
 * мгновенно и БЕЗ запроса; этот вызов дополняет её тем, чего в списочной
 * модели намеренно нет: профиль гостя с заметкой и метками, полная
 * статистика броней (121) и денежная часть из POS.
 *
 * Ровно один запрос на открытие визита — не N+1 из профиля, статистики
 * и заказа по отдельности.
 */
CREATE OR REPLACE FUNCTION get_visit_web(
  p_location_id UUID,
  p_id          UUID
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_r      reservations%ROWTYPE;
  v_guest  guests%ROWTYPE;
  v_out    JSONB;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE id = p_id AND org_id = v_org AND location_id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_r.guest_id IS NOT NULL THEN
    SELECT * INTO v_guest FROM guests WHERE id = v_r.guest_id AND org_id = v_org;
  END IF;

  v_out := jsonb_build_object(
    'id',       v_r.id,
    'order',    _visit_order_summary(v_r.order_id),
    'tables', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t.id, 'label', t.label, 'seats', COALESCE(t.seats, 2),
               'zone_name', z.name, 'is_primary', rt.is_primary)
             ORDER BY rt.is_primary DESC, t.label)
      FROM reservation_tables rt
      JOIN tables t ON t.id = rt.table_id
      LEFT JOIN table_zones z ON z.id = t.zone_id
      WHERE rt.reservation_id = v_r.id
    ), '[]'::jsonb),
    'guest', CASE WHEN v_guest.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',            v_guest.id,
      'name',          v_guest.name,
      'phone',         v_guest.phone,
      -- Внутреннее (121): наружу этот путь не ведёт — функция закрыта
      -- членством owner/manager и capability `reservations_desk`.
      'notes',         v_guest.notes,
      'tags',          COALESCE(to_jsonb(v_guest.tags), '[]'::jsonb),
      -- Денежная часть есть только там, где есть касса. У standalone
      -- Reserve она нулевая, и показывать её нельзя: пустая «средняя
      -- сумма чека» выглядит как гость, который ничего не тратит.
      'loyalty_visits', v_guest.visits,
      'total_spent',    v_guest.total_spent,
      'last_visit_at',  v_guest.last_visit_at,
      'anonymized',     v_guest.anonymized_at IS NOT NULL,
      'stats',          guest_reservation_stats(v_guest.id)) END
  );

  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION get_visit_web(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_visit_web(UUID, UUID) TO authenticated, service_role;

-- ============================================================
-- ОТКАТ
--
-- Forward-only: миграция не меняет ни одной таблицы и не трогает
-- существующие функции — только добавляет четыре новых. Функциональный
-- откат = отозвать EXECUTE у `authenticated`:
--
--   REVOKE EXECUTE ON FUNCTION get_reservation_desk_web(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM authenticated;
--   REVOKE EXECUTE ON FUNCTION get_visit_web(UUID, UUID) FROM authenticated;
--
-- Кабинет старой сборки продолжает работать: прямые выборки под RLS
-- (053) не тронуты, кассовый путь (119) не тронут.
--
-- ПРОВЕРКА под веб-владельцем:
--   SELECT get_reservation_desk_web('<loc>', NOW() - INTERVAL '1 day',
--                                   NOW() + INTERVAL '1 day');
--   SELECT get_visit_web('<loc>', '<reservation_id>');
-- ============================================================
