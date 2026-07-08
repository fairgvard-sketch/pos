-- ============================================================
-- 032 CLOSE SHIFT GUARD — смена не закрывается, пока на точке
-- есть открытые заказы (счета столов / неоплаченные заказы).
--
-- Иначе столы «зависают»: pay_order требует открытую смену, и
-- оплатить забытый счёт после закрытия уже нельзя. Проверяем все
-- open-заказы локации (не только этой смены — на случай счетов,
-- открытых до внедрения проверки). Клиент показывает дружелюбное
-- сообщение; здесь — настоящая защита.
-- ============================================================

CREATE OR REPLACE FUNCTION close_shift(p_shift_id UUID, p_staff_id UUID, p_counted_cash INTEGER, p_note TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_shift    shifts%ROWTYPE;
  v_open     INTEGER;
  v_cash     INTEGER;
  v_card     INTEGER;
  v_orders   INTEGER;
  v_expected INTEGER;
BEGIN
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift already closed';
  END IF;

  -- Открытые заказы точки: сначала закрыть/оплатить/отменить их
  SELECT COUNT(*) INTO v_open
  FROM orders WHERE location_id = v_shift.location_id AND status = 'open';
  IF v_open > 0 THEN
    RAISE EXCEPTION 'shift has open orders: %', v_open;
  END IF;

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE method = 'cash'), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'card'), 0),
    COUNT(DISTINCT order_id)
  INTO v_cash, v_card, v_orders
  FROM payments WHERE shift_id = p_shift_id;

  v_expected := v_shift.opening_float + v_cash;

  UPDATE shifts SET
    status        = 'closed',
    closed_by     = p_staff_id,
    counted_cash  = p_counted_cash,
    expected_cash = v_expected,
    cash_diff     = p_counted_cash - v_expected,
    total_sales   = v_cash + v_card,
    orders_count  = v_orders,
    closed_at     = NOW(),
    close_note    = NULLIF(TRIM(p_note), '')
  WHERE id = p_shift_id;

  RETURN json_build_object(
    'cash_sales',    v_cash,
    'card_sales',    v_card,
    'total_sales',   v_cash + v_card,
    'expected_cash', v_expected,
    'counted_cash',  p_counted_cash,
    'cash_diff',     p_counted_cash - v_expected,
    'orders_count',  v_orders
  );
END $$;
