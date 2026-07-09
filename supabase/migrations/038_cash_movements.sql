-- ============================================================
-- 038 CASH MOVEMENTS — внесение/изъятие наличных в течение смены
-- (Square: Cash Management, paid-in / paid-out).
--
-- Боль: expected_cash = размен + нетто-наличные. Дневная инкассация
-- (забрали выручку) или докладка размена ломала сверку — вечером
-- ложная недостача/излишек. Теперь движения фиксируются записями
-- (только INSERT, инвариант №2 — финансовые записи не удаляются)
-- и входят в формулу:
--   expected_cash = opening_float + нетто-наличные + cash_in − cash_out
--
-- shift_report / close_shift переопределяются (базы 033/037),
-- добавляются cash_in / cash_out; остальные формулы (guard столов,
-- авто-void брошенных, z_number, брутто/возвраты/НДС) без изменений.
-- ============================================================

CREATE TABLE IF NOT EXISTS cash_movements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  shift_id    UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  staff_id    UUID NOT NULL REFERENCES staff(id),
  type        TEXT NOT NULL CHECK (type IN ('in', 'out')),
  amount      INTEGER NOT NULL CHECK (amount > 0),  -- агороты
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements(shift_id);

ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;

-- Чтение — своей org; запись только через RPC (SECURITY DEFINER)
DO $$ BEGIN
  CREATE POLICY cash_movements_select ON cash_movements
    FOR SELECT TO authenticated USING (org_id = auth_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Внесение/изъятие: только в открытую смену ──
CREATE OR REPLACE FUNCTION add_cash_movement(
  p_shift_id UUID, p_staff_id UUID, p_type TEXT, p_amount INTEGER, p_reason TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_shift shifts%ROWTYPE;
  v_id    UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_type NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'invalid type';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'invalid amount';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift not open';
  END IF;

  INSERT INTO cash_movements (org_id, location_id, shift_id, staff_id, type, amount, reason)
  VALUES (v_org, v_shift.location_id, p_shift_id, p_staff_id, p_type, p_amount, NULLIF(TRIM(p_reason), ''))
  RETURNING id INTO v_id;

  RETURN json_build_object('id', v_id);
END $$;

REVOKE EXECUTE ON FUNCTION add_cash_movement(UUID, UUID, TEXT, INTEGER, TEXT) FROM anon, public;

-- ── shift_report: + cash_in/cash_out, expected с движениями ──
CREATE OR REPLACE FUNCTION shift_report(p_shift_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_shift     shifts%ROWTYPE;
  v_cash      INTEGER;
  v_card      INTEGER;
  v_orders    INTEGER;
  v_tips      INTEGER;
  v_in        INTEGER;
  v_out       INTEGER;
BEGIN
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE method = 'cash'), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'card'), 0)
  INTO v_cash, v_card
  FROM payments WHERE shift_id = p_shift_id;

  SELECT COUNT(DISTINCT order_id) INTO v_orders
  FROM payments WHERE shift_id = p_shift_id;

  SELECT COALESCE(SUM(tip_amount), 0) INTO v_tips
  FROM orders WHERE shift_id = p_shift_id AND status <> 'voided';

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'in'), 0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'out'), 0)
  INTO v_in, v_out
  FROM cash_movements WHERE shift_id = p_shift_id;

  RETURN json_build_object(
    'shift_id',      v_shift.id,
    'status',        v_shift.status,
    'opened_at',     v_shift.opened_at,
    'opening_float', v_shift.opening_float,
    'cash_sales',    v_cash,
    'card_sales',    v_card,
    'total_sales',   v_cash + v_card,
    'tips_total',    v_tips,
    'cash_in',       v_in,
    'cash_out',      v_out,
    'expected_cash', v_shift.opening_float + v_cash + v_in - v_out,
    'orders_count',  v_orders
  );
END $$;

-- ── close_shift: база 037 + cash_in/cash_out в expected и в Z ──
CREATE OR REPLACE FUNCTION close_shift(p_shift_id UUID, p_staff_id UUID, p_counted_cash INTEGER, p_note TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org         UUID := auth_org_id();
  v_shift       shifts%ROWTYPE;
  v_cash        INTEGER;  -- нетто (продажи − возвраты), как в 035
  v_card        INTEGER;
  v_gross_cash  INTEGER;
  v_gross_card  INTEGER;
  v_refunds     INTEGER;
  v_vat         INTEGER;
  v_orders      INTEGER;
  v_tips        INTEGER;
  v_in          INTEGER;
  v_out         INTEGER;
  v_expected    INTEGER;
  v_open_tables INTEGER;
  v_abandoned   INTEGER;
  v_z           INTEGER;
  v_closed_at   TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift already closed';
  END IF;

  -- Guard: открытые счета столов блокируют закрытие (032/035)
  SELECT COUNT(*) INTO v_open_tables
  FROM orders
  WHERE location_id = v_shift.location_id
    AND status = 'open'
    AND table_id IS NOT NULL;
  IF v_open_tables > 0 THEN
    RAISE EXCEPTION 'shift has open orders: %', v_open_tables;
  END IF;

  -- Брошенные counter-заказы аннулируем (035)
  UPDATE orders
  SET status = 'voided', voided_at = NOW(),
      void_reason = COALESCE(void_reason, 'abandoned at shift close')
  WHERE location_id = v_shift.location_id
    AND status = 'open'
    AND table_id IS NULL;
  GET DIAGNOSTICS v_abandoned = ROW_COUNT;

  -- Нетто + брутто/возвраты одним проходом по payments смены
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE method = 'cash'), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'card'), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'cash' AND amount > 0), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'card' AND amount > 0), 0),
    COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0),
    COUNT(DISTINCT order_id) FILTER (WHERE amount > 0)
  INTO v_cash, v_card, v_gross_cash, v_gross_card, v_refunds, v_orders
  FROM payments WHERE shift_id = p_shift_id;

  SELECT COALESCE(SUM(tip_amount), 0) INTO v_tips
  FROM orders WHERE shift_id = p_shift_id AND status <> 'voided';

  -- НДС продаж смены — из снапшотов заказов (инвариант №5)
  SELECT COALESCE(SUM(vat_amount), 0) INTO v_vat
  FROM orders WHERE shift_id = p_shift_id AND status <> 'voided';

  -- Движения наличных за смену (038)
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'in'), 0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'out'), 0)
  INTO v_in, v_out
  FROM cash_movements WHERE shift_id = p_shift_id;

  v_expected := v_shift.opening_float + v_cash + v_in - v_out;

  -- Непрерывный номер Z-отчёта по локации (паттерн 020)
  INSERT INTO z_counters (location_id, counter)
  VALUES (v_shift.location_id, 1)
  ON CONFLICT (location_id) DO UPDATE SET counter = z_counters.counter + 1
  RETURNING counter INTO v_z;

  UPDATE shifts SET
    status        = 'closed',
    closed_by     = p_staff_id,
    counted_cash  = p_counted_cash,
    expected_cash = v_expected,
    cash_diff     = p_counted_cash - v_expected,
    total_sales   = v_cash + v_card,
    orders_count  = v_orders,
    closed_at     = v_closed_at,
    close_note    = NULLIF(TRIM(p_note), ''),
    z_number      = v_z
  WHERE id = p_shift_id;

  RETURN json_build_object(
    'cash_sales',       v_cash,
    'card_sales',       v_card,
    'total_sales',      v_cash + v_card,
    'gross_cash',       v_gross_cash,
    'gross_card',       v_gross_card,
    'gross_total',      v_gross_cash + v_gross_card,
    'refunds_total',    v_refunds,
    'vat_total',        v_vat,
    'tips_total',       v_tips,
    'cash_in',          v_in,
    'cash_out',         v_out,
    'expected_cash',    v_expected,
    'counted_cash',     p_counted_cash,
    'cash_diff',        p_counted_cash - v_expected,
    'orders_count',     v_orders,
    'abandoned_voided', v_abandoned,
    'z_number',         v_z,
    'opened_at',        v_shift.opened_at,
    'closed_at',        v_closed_at,
    'opening_float',    v_shift.opening_float
  );
END $$;
