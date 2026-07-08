-- ============================================================
-- 029 REFUND RECEIPT — תעודת זיכוי (credit note) для возврата.
--
-- Израиль: возврат оформляется отдельным фискальным документом
-- со СВОЕЙ сквозной непрерывной нумерацией (не смешивается с
-- нумерацией чеков — другой тип документа, как в 020).
-- Номер присваивается атомарно в момент возврата внутри
-- issue_refund — возврат без документа не существует.
-- ============================================================

ALTER TABLE refunds
  ADD COLUMN location_id   UUID REFERENCES locations(id),
  ADD COLUMN refund_number INTEGER;

-- Сквозной счётчик зикуев на локацию (та же механика, что receipt_counters)
CREATE TABLE refund_counters (
  location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  counter     INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE refund_counters ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX idx_refunds_number
  ON refunds(location_id, refund_number) WHERE refund_number IS NOT NULL;

-- issue_refund: + location_id и сквозной номер документа
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
  v_org      UUID := auth_org_id();
  v_loc      UUID := auth_location_id();
  v_order    orders%ROWTYPE;
  v_shift    UUID;
  v_paid     INTEGER;
  v_refunded INTEGER;
  v_number   INTEGER;
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
    COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0),
    COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0)
  INTO v_paid, v_refunded
  FROM payments WHERE order_id = p_order_id;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_paid - v_refunded THEN
    RAISE EXCEPTION 'invalid refund amount';
  END IF;

  -- Деньги выдаются сейчас → возврат в текущую открытую смену
  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  -- Сквозной номер תעודת זיכוי (атомарный инкремент, как в 020)
  INSERT INTO refund_counters (location_id, counter)
  VALUES (v_loc, 1)
  ON CONFLICT (location_id)
  DO UPDATE SET counter = refund_counters.counter + 1
  RETURNING counter INTO v_number;

  INSERT INTO refunds (id, org_id, location_id, order_id, shift_id, staff_id,
                       amount, method, reason, items, refund_number)
  VALUES (p_refund_id, v_org, v_loc, p_order_id, v_shift, p_staff_id, p_amount, p_method,
          NULLIF(TRIM(p_reason), ''), p_items, v_number);

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
    'refund_id',     p_refund_id,
    'refund_number', v_number,
    'refunded',      p_amount,
    'remaining',     v_paid - v_refunded - p_amount
  );
END $$;

REVOKE EXECUTE ON FUNCTION issue_refund FROM anon, public;
