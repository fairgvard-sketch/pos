-- ============================================================
-- 115. Режим лояльности в ответе get_guest_card.
--
-- Мотив: бэкофис ANGLE показывает баланс гостя либо в штампах, либо в
-- деньгах — по loyalty_mode точки. Но get_backoffice_context (105) поля
-- loyalty_mode не отдаёт, и веб-клиент вынужден был угадывать режим
-- (фолбэк на 'points'): точка со штампами показала бы «5» как ₪0.05.
--
-- Тело 114 повторено целиком (forward-only, CREATE OR REPLACE) с одним
-- добавленным полем 'loyalty_mode'. Режим берём с точки последнего
-- заказа гостя, иначе — с любой точки org: программа лояльности общая
-- на организацию, и режим у точек совпадает.
--
-- ⚠️ ТРЕБУЕТ 114 (get_guest_card).
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
    'loyalty_mode',  COALESCE(v_mode, 'off'),
    'orders',        v_orders,
    'favorites',     v_favs,
    'events',        v_events
  );
END $$;

REVOKE EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_guest_card(UUID, INTEGER) TO authenticated;
