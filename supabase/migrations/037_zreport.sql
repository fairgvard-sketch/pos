-- ============================================================
-- 037 Z-REPORT — печатный отчёт закрытия смены (Израиль).
--
-- Требования к דו"ח Z: сквозная нумерация Z-отчётов по локации
-- (отдельный счётчик, как receipt_counters из 020), брутто-продажи,
-- возвраты отдельной строкой, НДС за смену. Сейчас cash/card_sales —
-- НЕТТО (возвраты лежат в payments отрицательными строками, 025/028),
-- для отчёта нужно показать раздельно.
--
-- close_shift дополнительно возвращает:
--   z_number     — номер Z-отчёта (непрерывный по локации)
--   gross_cash / gross_card / gross_total — продажи БЕЗ вычета возвратов
--   refunds_total — сумма возвратов за смену (положительное число)
--   vat_total    — НДС из оплаченных в смену заказов (снапшоты vat_amount)
--   opened_at / closed_at / opening_float — для шапки печатного отчёта
-- Формулы 032/035 (expected_cash = opening_float + нетто-наличные,
-- guard столов, авто-void брошенных counter-заказов) не меняются.
-- ============================================================

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS z_number INTEGER;

CREATE TABLE IF NOT EXISTS z_counters (
  location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  counter     INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE z_counters ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_z_number
  ON shifts(location_id, z_number) WHERE z_number IS NOT NULL;

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

  v_expected := v_shift.opening_float + v_cash;

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
