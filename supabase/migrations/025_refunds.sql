-- ============================================================
-- 025 REFUNDS — возврат оплаченного заказа (полный).
--
-- Инвариант «не удалять финансовые записи»: возврат = НОВЫЕ
-- отрицательные строки в payments (зеркало исходных) + статус
-- 'refunded' на заказе. Отрицательные платежи попадают в ТЕКУЩУЮ
-- смену → X/Z-отчёт автоматически минусует наличные/карту.
-- Исходные платежи и заказ нетронуты — аудит цел.
-- ============================================================

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('open', 'paid', 'fulfilled', 'voided', 'refunded'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS refunded_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refunded_by   UUID REFERENCES staff(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT;

CREATE OR REPLACE FUNCTION refund_order(
  p_order_id UUID,
  p_staff_id UUID,
  p_reason   TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_loc   UUID := auth_location_id();
  v_order orders%ROWTYPE;
  v_shift UUID;
  v_cnt   INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status NOT IN ('paid', 'fulfilled') THEN
    RAISE EXCEPTION 'order not refundable';
  END IF;

  -- Возврат идёт в ТЕКУЩУЮ открытую смену (деньги выдаются сейчас)
  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  -- Зеркальные отрицательные платежи
  INSERT INTO payments (org_id, order_id, shift_id, method, amount)
  SELECT org_id, order_id, v_shift, method, -amount
  FROM payments
  WHERE order_id = p_order_id AND amount > 0;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt = 0 THEN
    RAISE EXCEPTION 'no payments to refund';
  END IF;

  UPDATE orders SET
    status = 'refunded',
    refunded_at = NOW(),
    refunded_by = p_staff_id,
    refund_reason = NULLIF(TRIM(p_reason), '')
  WHERE id = p_order_id;

  RETURN json_build_object('order_id', p_order_id, 'refunded', v_order.total);
END $$;

REVOKE EXECUTE ON FUNCTION refund_order(UUID, UUID, TEXT) FROM anon, public;
