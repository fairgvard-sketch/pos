-- ============================================================
-- 114. База клиентов лояльности: карточка гостя и CRM в бэкофисе.
--
-- Мотив: guests (031) хранит балансы и счётчики, loyalty_events —
-- append-only журнал начислений, order_items — состав каждого заказа.
-- Всё это уже есть, но карточка гостя на кассе (113) показывала лишь
-- «#номер · дата · сумма»: владелец не видел, ЧТО человек покупал,
-- когда и за что получил баллы. Веб-кабинет ANGLE гостей не видел вовсе.
--
-- Решение — две RPC по образцу 097/089:
--   * get_guest_card(guest_id)         — карточка для кассы (JWT устройства);
--   * get_backoffice_guests(location)  — список + карточка для ANGLE.
-- Обе SECURITY INVOKER: тело читает guests/orders/order_items ПОД RLS
-- вызывающего (guests_all скоупит по org_id = auth_org_id()), поэтому
-- чужая организация недостижима даже при ошибке в гейте. Новых GRANT на
-- сами таблицы не выдаём.
--
-- Заметка о госте (notes) — новая колонка: свободный текст бариста
-- («без сахара», «постоянный»). Правится клиентом, поэтому добавляется
-- в колоночный грант UPDATE рядом с name (031); балансы остаются
-- server-only — их по-прежнему меняют только apply_loyalty/pay_order.
--
-- ⚠️ ТРЕБУЕТ 031 (guests, loyalty_events), 088 (auth_backoffice_role).
-- ============================================================

-- ── Заметка о госте ─────────────────────────────────────────
ALTER TABLE guests ADD COLUMN IF NOT EXISTS notes TEXT;

-- Клиент правит имя, телефон и заметку. Балансы (stamps/points/visits/
-- total_spent) в грант НЕ входят — инвариант 031 сохраняется.
GRANT UPDATE (phone, name, notes) ON guests TO authenticated;

-- ── Карточка гостя для кассы ────────────────────────────────
-- Возвращает одним запросом: профиль, последние заказы С СОСТАВОМ,
-- любимые позиции и журнал начислений/списаний.
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

  RETURN jsonb_build_object(
    'id',            v_guest.id,
    'phone',         v_guest.phone,
    'name',          v_guest.name,
    'notes',         v_guest.notes,
    'stamps',        v_guest.stamps,
    'points',        v_guest.points,
    'visits',        v_guest.visits,
    'total_spent',   v_guest.total_spent,
    'last_visit_at', v_guest.last_visit_at,
    'created_at',    v_guest.created_at,
    'orders',        v_orders,
    'favorites',     v_favs,
    'events',        v_events
  );
END $$;

REVOKE EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) TO authenticated;

-- ── Список гостей для бэкофиса ──────────────────────────────
-- Гейт как в 097: веб-владелец/менеджер проходит по членству (088),
-- иначе — staff-сессия с правом 'manage'. Гости скоупятся по org
-- (RLS), а не по точке: программа лояльности общая на организацию.
CREATE OR REPLACE FUNCTION get_backoffice_guests(
  p_search        TEXT DEFAULT NULL,
  p_limit         INTEGER DEFAULT 100,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_q      TEXT    := NULLIF(TRIM(COALESCE(p_search, '')), '');
  v_digits TEXT;
  v_result JSONB;
BEGIN
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  v_digits := regexp_replace(COALESCE(v_q, ''), '\D', '', 'g');

  SELECT COALESCE(jsonb_agg(g ORDER BY g.last_visit_at DESC NULLS LAST), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT id, phone, name, notes, stamps, points, visits, total_spent, last_visit_at
    FROM guests
    WHERE v_q IS NULL
       OR (length(v_digits) >= 3 AND phone LIKE '%' || v_digits || '%')
       OR (length(v_digits) < 3  AND name ILIKE '%' || v_q || '%')
    ORDER BY last_visit_at DESC NULLS LAST
    LIMIT v_limit
  ) g;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION get_backoffice_guests(TEXT, INTEGER, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_backoffice_guests(TEXT, INTEGER, UUID) TO authenticated;
