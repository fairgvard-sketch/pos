-- ============================================================
-- 030 REFUND METHOD MATCH — деньги возвращаются тем способом,
-- которым платили: нал → нал, карта → карта.
--
-- На каждый способ можно вернуть не больше, чем им оплачено
-- (минус уже возвращённое этим способом). Для смешанной оплаты
-- возврат крупнее доли одного способа проводится двумя возвратами.
-- Клиент ограничивает выбор в UI; здесь — настоящая защита.
-- ============================================================

CREATE OR REPLACE FUNCTION issue_refund(
  p_refund_id UUID,
  p_order_id  UUID,
  p_staff_id  UUID,
  p_amount    INTEGER,
  p_method    TEXT,
  p_reason    TEXT  DEFAULT NULL,
  p_items     JSONB DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org             UUID := auth_org_id();
  v_loc             UUID := auth_location_id();
  v_order           orders%ROWTYPE;
  v_shift           UUID;
  v_paid            INTEGER;
  v_refunded        INTEGER;
  v_paid_method     INTEGER;
  v_refunded_method INTEGER;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  IF p_method NOT IN ('cash', 'card') THEN
    RAISE EXCEPTION 'invalid refund method';
  END IF;

  -- Идемпотентность: этот возврат уже проведён
  IF EXISTS (SELECT 1 FROM refunds WHERE id = p_refund_id) THEN
    RETURN json_build_object('refund_id', p_refund_id, 'duplicate', TRUE);
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status NOT IN ('paid', 'fulfilled', 'refunded') THEN
    RAISE EXCEPTION 'order not refundable';
  END IF;

  SELECT
    COALESCE(SUM(amount)  FILTER (WHERE amount > 0), 0),
    COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0),
    COALESCE(SUM(amount)  FILTER (WHERE amount > 0 AND method = p_method), 0),
    COALESCE(-SUM(amount) FILTER (WHERE amount < 0 AND method = p_method), 0)
  INTO v_paid, v_refunded, v_paid_method, v_refunded_method
  FROM payments WHERE order_id = p_order_id;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_paid - v_refunded THEN
    RAISE EXCEPTION 'invalid refund amount';
  END IF;

  -- Возврат тем же способом: не больше, чем оплачено этим способом
  IF p_amount > v_paid_method - v_refunded_method THEN
    RAISE EXCEPTION 'refund exceeds amount paid by %', p_method;
  END IF;

  -- Деньги выдаются сейчас → возврат в текущую открытую смену
  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  INSERT INTO refunds (id, org_id, order_id, shift_id, staff_id, amount, method, reason, items)
  VALUES (p_refund_id, v_org, p_order_id, v_shift, p_staff_id, p_amount, p_method,
          NULLIF(TRIM(p_reason), ''), p_items);

  INSERT INTO payments (org_id, order_id, shift_id, method, amount, refund_id)
  VALUES (v_org, p_order_id, v_shift, p_method, -p_amount, p_refund_id);

  -- Возвращено всё → заказ считается возвращённым целиком
  IF v_refunded + p_amount >= v_paid THEN
    UPDATE orders SET
      status        = 'refunded',
      refunded_at   = NOW(),
      refunded_by   = p_staff_id,
      refund_reason = NULLIF(TRIM(p_reason), '')
    WHERE id = p_order_id;
  END IF;

  RETURN json_build_object(
    'refund_id', p_refund_id,
    'refunded',  p_amount,
    'remaining', v_paid - v_refunded - p_amount
  );
END $$;

REVOKE EXECUTE ON FUNCTION issue_refund FROM anon, public;
