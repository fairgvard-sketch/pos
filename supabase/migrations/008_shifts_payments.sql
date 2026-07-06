-- ============================================================
-- 008 SHIFTS & PAYMENTS — смены и приём оплаты.
--
-- Принципы:
--   * Смена = рабочий сеанс кассы: открытие с разменом,
--     закрытие с пересчётом наличных. Все продажи привязаны
--     к открытой смене (shift_id на заказе).
--   * Платёж — отдельная запись (не поле заказа). Разные способы,
--     сплит, будущие возвраты — всё как строки в payments.
--   * Финансовые записи НЕ удаляются и НЕ меняются задним числом:
--     расхождение при закрытии фиксируется как cash_diff, а не
--     подгонкой сумм.
--   * X-отчёт — срез открытой смены (без закрытия).
--     Z-отчёт — снимок на момент закрытия (хранится в shift).
-- ============================================================

-- ── SHIFTS ──────────────────────────────────────────────────
CREATE TABLE shifts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id),
  opened_by      UUID NOT NULL REFERENCES staff(id),
  closed_by      UUID REFERENCES staff(id),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opening_float  INTEGER NOT NULL DEFAULT 0,   -- размен на старте, агороты
  -- Снимок при закрытии (Z-отчёт):
  counted_cash   INTEGER,                       -- пересчитанные наличные в кассе
  expected_cash  INTEGER,                       -- ожидалось = размен + нал.выручка
  cash_diff      INTEGER,                       -- counted - expected (недостача/излишек)
  total_sales    INTEGER,                       -- сумма всех оплат за смену
  orders_count   INTEGER,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at      TIMESTAMPTZ,
  close_note     TEXT
);

-- Одна открытая смена на точку
CREATE UNIQUE INDEX idx_one_open_shift ON shifts (location_id) WHERE status = 'open';
CREATE INDEX idx_shifts_org ON shifts(org_id);

-- ── PAYMENTS ────────────────────────────────────────────────
CREATE TABLE payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shift_id    UUID REFERENCES shifts(id),
  method      TEXT NOT NULL CHECK (method IN ('cash', 'card')),
  amount      INTEGER NOT NULL,                 -- сколько оплачено этим способом
  tendered    INTEGER,                          -- сколько дал клиент (нал), для сдачи
  change_due  INTEGER,                          -- сдача
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_org   ON payments(org_id);
CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_shift ON payments(shift_id);

-- Заказ знает свою смену (для отчёта и привязки)
ALTER TABLE orders ADD COLUMN shift_id UUID REFERENCES shifts(id);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE shifts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY shifts_select ON shifts FOR SELECT TO authenticated
  USING (org_id = auth_org_id());
CREATE POLICY payments_select ON payments FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

-- Запись — только через RPC
REVOKE INSERT, UPDATE, DELETE ON shifts   FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON payments FROM authenticated;

-- ============================================================
-- RPC: open_shift — открыть смену с разменом
-- ============================================================
CREATE OR REPLACE FUNCTION open_shift(p_staff_id UUID, p_opening_float INTEGER)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
  v_id  UUID;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM shifts WHERE location_id = v_loc AND status = 'open') THEN
    RAISE EXCEPTION 'shift already open';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  INSERT INTO shifts (org_id, location_id, opened_by, opening_float)
  VALUES (v_org, v_loc, p_staff_id, GREATEST(0, COALESCE(p_opening_float, 0)))
  RETURNING id INTO v_id;

  RETURN json_build_object('shift_id', v_id);
END $$;

-- ============================================================
-- RPC: current_shift — открытая смена точки (или NULL)
-- ============================================================
CREATE OR REPLACE FUNCTION current_shift()
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc UUID := auth_location_id();
  v_shift shifts%ROWTYPE;
BEGIN
  SELECT * INTO v_shift FROM shifts
  WHERE location_id = v_loc AND status = 'open'
  ORDER BY opened_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN row_to_json(v_shift);
END $$;

-- ============================================================
-- RPC: pay_order — принять оплату и закрыть заказ (paid).
-- p_payments: [{ "method":"cash|card", "amount":1400,
--                "tendered":2000, "change_due":600 }]
-- Сумма оплат должна покрывать total заказа.
-- ============================================================
CREATE OR REPLACE FUNCTION pay_order(p_order_id UUID, p_payments JSONB)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_loc    UUID := auth_location_id();
  v_order  orders%ROWTYPE;
  v_shift  UUID;
  v_pay    JSONB;
  v_sum    INTEGER := 0;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  FOR v_pay IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    IF (v_pay ->> 'method') NOT IN ('cash', 'card') THEN
      RAISE EXCEPTION 'invalid payment method';
    END IF;
    v_sum := v_sum + (v_pay ->> 'amount')::INTEGER;
    INSERT INTO payments (org_id, order_id, shift_id, method, amount, tendered, change_due)
    VALUES (v_org, p_order_id, v_shift, v_pay ->> 'method',
            (v_pay ->> 'amount')::INTEGER,
            NULLIF(v_pay ->> 'tendered', '')::INTEGER,
            NULLIF(v_pay ->> 'change_due', '')::INTEGER);
  END LOOP;

  IF v_sum < v_order.total THEN
    RAISE EXCEPTION 'insufficient payment: % < %', v_sum, v_order.total;
  END IF;

  UPDATE orders
  SET status = 'paid', paid_at = NOW(), shift_id = v_shift
  WHERE id = p_order_id;

  RETURN json_build_object('order_id', p_order_id, 'paid', v_sum);
END $$;

-- ============================================================
-- RPC: shift_report — X/Z отчёт по смене (расчёт из payments)
-- Работает и для открытой (X), и для закрытой (Z) смены.
-- ============================================================
CREATE OR REPLACE FUNCTION shift_report(p_shift_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_shift     shifts%ROWTYPE;
  v_cash      INTEGER;
  v_card      INTEGER;
  v_orders    INTEGER;
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

  RETURN json_build_object(
    'shift_id',      v_shift.id,
    'status',        v_shift.status,
    'opened_at',     v_shift.opened_at,
    'opening_float', v_shift.opening_float,
    'cash_sales',    v_cash,
    'card_sales',    v_card,
    'total_sales',   v_cash + v_card,
    'expected_cash', v_shift.opening_float + v_cash,
    'orders_count',  v_orders
  );
END $$;

-- ============================================================
-- RPC: close_shift — закрыть смену с пересчётом наличных
-- ============================================================
CREATE OR REPLACE FUNCTION close_shift(p_shift_id UUID, p_staff_id UUID, p_counted_cash INTEGER, p_note TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_shift    shifts%ROWTYPE;
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

REVOKE EXECUTE ON FUNCTION open_shift, current_shift, pay_order, shift_report, close_shift FROM anon, public;
