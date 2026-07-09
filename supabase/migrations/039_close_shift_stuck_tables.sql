-- ============================================================
-- 039 CLOSE SHIFT — зависшие столовые заказы не блокируют закрытие.
--
-- Инцидент (из боя): смена не закрывалась с «shift has open orders»,
-- хотя в зале ВСЕ столы свободны. Причина — заказ status='open' со
-- table_id, которого зал не показывает:
--   * стол удалён/переименован после открытия счёта (orders.table_id
--     ссылается на несуществующий tables.id — «осиротевший» заказ);
--   * счёт стола завис ПУСТЫМ (зашли на стол, ничего не заказали,
--     вышли не через кнопку — 0 активных позиций).
-- Оба — мусор, а не реальная работа: зал их не рисует (рисует только
-- по текущим столам), гость за ними не сидит. Но guard 035 считал
-- ЛЮБОЙ open-заказ со столом и блокировал закрытие.
--
-- Решение: блокируют закрытие только НАСТОЯЩИЕ счета — open, есть
-- активные позиции, И стол существует. Пустые и осиротевшие столовые
-- заказы (как и брошенные counter-заказы из 035) авто-аннулируются
-- при закрытии (status='voided', аудит цел — не DELETE).
--
-- База — close_shift из 038 (движение наличных, Z-отчёт). Меняется
-- только блок guard/авто-void; формулы и возвращаемый JSON те же.
-- ============================================================

CREATE OR REPLACE FUNCTION close_shift(p_shift_id UUID, p_staff_id UUID, p_counted_cash INTEGER, p_note TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org         UUID := auth_org_id();
  v_shift       shifts%ROWTYPE;
  v_cash        INTEGER;
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

  -- Guard: блокируют только НАСТОЯЩИЕ счета столов — open, стол
  -- существует И есть хотя бы одна активная (не voided) позиция.
  SELECT COUNT(*) INTO v_open_tables
  FROM orders o
  WHERE o.location_id = v_shift.location_id
    AND o.status = 'open'
    AND o.table_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM tables t WHERE t.id = o.table_id)
    AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.voided_at IS NULL);
  IF v_open_tables > 0 THEN
    RAISE EXCEPTION 'shift has open orders: %', v_open_tables;
  END IF;

  -- Авто-аннулируем мусор: брошенные counter-заказы (035) + пустые и
  -- осиротевшие столовые заказы (039). «Пустой» = нет активных позиций;
  -- «осиротевший» = стол не существует.
  UPDATE orders o
  SET status = 'voided', voided_at = NOW(),
      void_reason = COALESCE(void_reason, 'abandoned at shift close')
  WHERE o.location_id = v_shift.location_id
    AND o.status = 'open'
    AND (
      o.table_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM tables t WHERE t.id = o.table_id)
      OR NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.voided_at IS NULL)
    );
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

  SELECT COALESCE(SUM(vat_amount), 0) INTO v_vat
  FROM orders WHERE shift_id = p_shift_id AND status <> 'voided';

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'in'), 0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'out'), 0)
  INTO v_in, v_out
  FROM cash_movements WHERE shift_id = p_shift_id;

  v_expected := v_shift.opening_float + v_cash + v_in - v_out;

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

-- ── Разовая чистка уже зависших пустых/осиротевших столовых заказов,
--    чтобы текущая смена закрылась сразу, без ожидания цикла. Реальные
--    непустые счета на существующих столах НЕ трогаем. Фильтр по
--    возрасту (> 5 минут) — чтобы не задеть счёт в активном потоке.
UPDATE orders o
SET status = 'voided', voided_at = NOW(),
    void_reason = COALESCE(void_reason, 'stuck open table order (039 cleanup)')
WHERE o.status = 'open'
  AND o.table_id IS NOT NULL
  AND o.created_at < NOW() - INTERVAL '5 minutes'
  AND (
    NOT EXISTS (SELECT 1 FROM tables t WHERE t.id = o.table_id)
    OR NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.voided_at IS NULL)
  );
