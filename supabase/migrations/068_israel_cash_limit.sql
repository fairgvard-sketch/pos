-- ============================================================
-- 068 ISRAEL CASH LIMIT - fail-closed validation for pay_order.
--
-- Standard business transaction rule (Law for Reduction of the Use of
-- Cash):
--   * transaction <= 6,000 NIS: cash may cover the whole transaction;
--   * transaction > 6,000 NIS: cash <= min(10%, 6,000 NIS).
--
-- There is a separate tourist threshold in the law. It is intentionally
-- NOT enabled until the product can identify the buyer as a tourist and
-- retain the required evidence/audit trail. All current sales therefore
-- use the standard, stricter business rule.
--
-- The existing implementation is renamed and made private. The public RPC
-- wrapper validates the complete payment array before any financial row is
-- written, then delegates to the unchanged atomic/idempotent implementation.
-- ============================================================

ALTER FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ)
  RENAME TO pay_order_unchecked;

REVOKE EXECUTE ON FUNCTION pay_order_unchecked(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION pay_order(
  p_order_id     UUID,
  p_payments     JSONB,
  p_tip          INTEGER     DEFAULT 0,
  p_payment_uuid UUID        DEFAULT NULL,
  p_paid_at      TIMESTAMPTZ DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org               UUID := auth_org_id();
  v_order_total       INTEGER;
  v_tip               INTEGER := GREATEST(COALESCE(p_tip, 0), 0);
  v_transaction_total INTEGER;
  v_payment_total     INTEGER := 0;
  v_cash_total        INTEGER := 0;
  v_max_cash          INTEGER;
  v_pay               JSONB;
  v_amount            INTEGER;
  v_result             JSONB;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- A completed operation must remain replayable after this migration.
  IF p_payment_uuid IS NOT NULL THEN
    SELECT result INTO v_result
    FROM op_log
    WHERE op_uuid = p_payment_uuid AND org_id = v_org;
    IF FOUND THEN
      RETURN v_result::JSON;
    END IF;
  END IF;

  SELECT total INTO v_order_total
  FROM orders
  WHERE id = p_order_id AND org_id = v_org AND status = 'open'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found or not open';
  END IF;

  IF p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payments';
  END IF;
  IF jsonb_array_length(p_payments) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payments';
  END IF;

  FOR v_pay IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    IF (v_pay ->> 'method') IS NULL
       OR (v_pay ->> 'method') NOT IN ('cash', 'card', 'cibus', 'tenbis', 'bit') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payment_method';
    END IF;
    v_amount := (v_pay ->> 'amount')::INTEGER;
    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payment_amount';
    END IF;
    v_payment_total := v_payment_total + v_amount;
    IF v_pay ->> 'method' = 'cash' THEN
      v_cash_total := v_cash_total + v_amount;
    END IF;
  END LOOP;

  -- POS treats the payable total, including a tip recorded in this payment,
  -- as one transaction for the cash guard. Accountant sign-off is still a
  -- release gate; see docs/israel-compliance.md.
  v_transaction_total := v_order_total + v_tip;

  -- tendered/change are informational; payment amount must equal the debt.
  IF v_payment_total <> v_transaction_total THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'payment_total_mismatch';
  END IF;

  IF v_transaction_total <= 600000 THEN
    v_max_cash := v_transaction_total;
  ELSE
    v_max_cash := LEAST(v_transaction_total / 10, 600000);
  END IF;

  IF v_cash_total > v_max_cash THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'cash_limit_exceeded';
  END IF;

  RETURN pay_order_unchecked(
    p_order_id,
    p_payments,
    p_tip,
    p_payment_uuid,
    p_paid_at
  );
END $$;

REVOKE EXECUTE ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ)
  TO authenticated;

COMMENT ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ) IS
  'Atomic/idempotent order payment with Israel standard-business cash-limit validation (migration 068).';

COMMENT ON FUNCTION pay_order_unchecked(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ) IS
  'Private implementation behind pay_order. Direct client execution is revoked by migration 068.';
