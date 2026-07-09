-- ============================================================
-- 035 CLOSE SHIFT — брошенные counter-заказы больше не блокируют
-- закрытие смены; блокируют только реальные счета столов.
--
-- Проблема (из боя): смена не закрывалась с ошибкой «есть открытые
-- заказы», хотя на экране заказов/столов пусто. Причина — брошенные
-- open-заказы: place_order создаёт заказ status='open' СРАЗУ, а
-- pay_order переводит в 'paid'. Если оплата не дошла (сбой сети,
-- аварийное закрытие APK, зависший сплит) и клиентский void
-- (cancelPayFlow) не отработал — заказ навсегда остаётся 'open'.
-- Его нигде не видно: в зал попадают только заказы с table_id,
-- в очередь бариста — только 'paid'. Но guard 032 считал ЛЮБОЙ
-- open-заказ локации и блокировал закрытие.
--
-- Решение:
--   * Счета столов (table_id IS NOT NULL) — настоящая причина
--     «зависания»: их нельзя оплатить после закрытия смены.
--     Их по-прежнему нужно закрыть/оплатить/отменить вручную —
--     guard на них остаётся.
--   * Брошенные counter-заказы (table_id IS NULL) — черновики без
--     оплаты. При закрытии смены их безопасно автоматически
--     аннулировать (status='voided', аудит цел — не DELETE).
--     Это устраняет блокировку и не оставляет мусор.
-- ============================================================

CREATE OR REPLACE FUNCTION close_shift(p_shift_id UUID, p_staff_id UUID, p_counted_cash INTEGER, p_note TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org         UUID := auth_org_id();
  v_shift       shifts%ROWTYPE;
  v_cash        INTEGER;
  v_card        INTEGER;
  v_orders      INTEGER;
  v_tips        INTEGER;
  v_expected    INTEGER;
  v_open_tables INTEGER;
  v_abandoned   INTEGER;
BEGIN
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift already closed';
  END IF;

  -- Guard: закрывать нельзя, только если есть открытые СЧЕТА СТОЛОВ
  -- (их оплата требует открытой смены — их нужно закрыть вручную).
  SELECT COUNT(*) INTO v_open_tables
  FROM orders
  WHERE location_id = v_shift.location_id
    AND status = 'open'
    AND table_id IS NOT NULL;
  IF v_open_tables > 0 THEN
    RAISE EXCEPTION 'shift has open orders: %', v_open_tables;
  END IF;

  -- Брошенные counter-заказы (без стола, оплата не дошла) —
  -- аннулируем, чтобы не блокировали закрытие и не копились.
  UPDATE orders
  SET status = 'voided', voided_at = NOW(),
      void_reason = COALESCE(void_reason, 'abandoned at shift close')
  WHERE location_id = v_shift.location_id
    AND status = 'open'
    AND table_id IS NULL;
  GET DIAGNOSTICS v_abandoned = ROW_COUNT;

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE method = 'cash'), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'card'), 0),
    COUNT(DISTINCT order_id)
  INTO v_cash, v_card, v_orders
  FROM payments WHERE shift_id = p_shift_id;

  SELECT COALESCE(SUM(tip_amount), 0) INTO v_tips
  FROM orders WHERE shift_id = p_shift_id AND status <> 'voided';

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
    'cash_sales',      v_cash,
    'card_sales',      v_card,
    'total_sales',     v_cash + v_card,
    'tips_total',      v_tips,
    'expected_cash',   v_expected,
    'counted_cash',    p_counted_cash,
    'cash_diff',       p_counted_cash - v_expected,
    'orders_count',    v_orders,
    'abandoned_voided', v_abandoned
  );
END $$;

-- ============================================================
-- Разовая чистка УЖЕ зависших брошенных counter-заказов —
-- чтобы текущая смена закрылась без ожидания следующего цикла.
-- Счета столов не трогаем. Фильтр по возрасту (> 10 минут) —
-- чтобы не задеть заказ в АКТИВНОМ потоке оплаты прямо сейчас.
-- ============================================================
UPDATE orders
SET status = 'voided', voided_at = NOW(),
    void_reason = COALESCE(void_reason, 'abandoned (035 cleanup)')
WHERE status = 'open'
  AND table_id IS NULL
  AND created_at < NOW() - INTERVAL '10 minutes';
