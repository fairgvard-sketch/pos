-- ============================================================
-- 033 TIPS — чаевые (טיפ) при оплате.
--
-- Принципы:
--   * tip_amount — снапшот на заказе. НЕ входит в total и в базу НДС:
--     чаевые не выручка и не облагаются מע"מ, в чеке идут отдельной
--     строкой после итога.
--   * Деньги чаевых проходят через payments вместе с оплатой:
--     сумма оплат должна покрыть total + tip. Наличные чаевые
--     оказываются в ящике → expected_cash сходится автоматически.
--   * Лояльность (начисление, total_spent) считается от total —
--     без чаевых, ничего не меняется.
--   * X/Z-отчёт показывает чаевые отдельной строкой (tips_total).
-- ============================================================

ALTER TABLE orders ADD COLUMN tip_amount INTEGER NOT NULL DEFAULT 0 CHECK (tip_amount >= 0);

-- ============================================================
-- pay_order — добавлен p_tip. Сигнатура меняется, старую версию
-- убираем, чтобы не осталось неоднозначной перегрузки (клиент
-- зовёт с двумя аргументами — DEFAULT покрывает).
-- Тело — 031 + чаевые.
-- ============================================================
DROP FUNCTION IF EXISTS pay_order(UUID, JSONB);

CREATE FUNCTION pay_order(p_order_id UUID, p_payments JSONB, p_tip INTEGER DEFAULT 0)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_loc    UUID := auth_location_id();
  v_order  orders%ROWTYPE;
  v_shift  UUID;
  v_pay    JSONB;
  v_sum    INTEGER := 0;
  v_tip    INTEGER := GREATEST(COALESCE(p_tip, 0), 0);
  -- лояльность
  v_guest    guests%ROWTYPE;
  v_mode     TEXT;
  v_goal     INTEGER;
  v_pct      NUMERIC(5,2);
  v_eligible INTEGER;
  v_stamps_d INTEGER := 0;  -- итоговое изменение штампов
  v_points_d INTEGER := 0;  -- итоговое изменение баллов (агороты)
  v_earn     INTEGER := 0;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
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

  -- Оплата покрывает итог + чаевые
  IF v_sum < v_order.total + v_tip THEN
    RAISE EXCEPTION 'insufficient payment: % < %', v_sum, v_order.total + v_tip;
  END IF;

  -- ── Лояльность: списать награду, начислить по режиму (от total, без чаевых) ─────
  IF v_order.guest_id IS NOT NULL THEN
    SELECT * INTO v_guest FROM guests WHERE id = v_order.guest_id FOR UPDATE;

    SELECT loyalty_mode, loyalty_stamps_goal, loyalty_points_percent
      INTO v_mode, v_goal, v_pct
    FROM locations WHERE id = v_order.location_id;

    -- Списание (баланс мог утечь с другого устройства — перепроверяем)
    IF v_order.loyalty_redeem = 'stamps' THEN
      IF v_guest.stamps < v_goal THEN
        RAISE EXCEPTION 'insufficient stamps';
      END IF;
      v_stamps_d := -v_goal;
      INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, stamps_delta)
      VALUES (v_org, v_guest.id, p_order_id, 'redeem', -v_goal);
    ELSIF v_order.loyalty_redeem = 'points' THEN
      IF v_guest.points < v_order.loyalty_discount THEN
        RAISE EXCEPTION 'insufficient points';
      END IF;
      v_points_d := -v_order.loyalty_discount;
      INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, points_delta)
      VALUES (v_org, v_guest.id, p_order_id, 'redeem', -v_order.loyalty_discount);
    END IF;

    -- Начисление по текущему режиму точки
    IF v_mode = 'stamps' THEN
      SELECT COALESCE(SUM(oi.qty), 0) INTO v_eligible
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE oi.order_id = p_order_id AND oi.voided_at IS NULL AND mc.loyalty_stamps;
      -- Подаренный напиток штамп не даёт
      v_earn := GREATEST(v_eligible - CASE WHEN v_order.loyalty_redeem = 'stamps' THEN 1 ELSE 0 END, 0);
      IF v_earn > 0 THEN
        v_stamps_d := v_stamps_d + v_earn;
        INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, stamps_delta)
        VALUES (v_org, v_guest.id, p_order_id, 'earn', v_earn);
      END IF;
    ELSIF v_mode = 'points' THEN
      v_earn := ROUND(v_order.total * v_pct / 100);
      IF v_earn > 0 THEN
        v_points_d := v_points_d + v_earn;
        INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, points_delta)
        VALUES (v_org, v_guest.id, p_order_id, 'earn', v_earn);
      END IF;
    END IF;

    UPDATE guests SET
      stamps        = stamps + v_stamps_d,
      points        = points + v_points_d,
      visits        = visits + 1,
      total_spent   = total_spent + v_order.total,
      last_visit_at = NOW()
    WHERE id = v_guest.id;
  END IF;

  UPDATE orders
  SET status = 'paid', paid_at = NOW(), shift_id = v_shift, tip_amount = v_tip
  WHERE id = p_order_id;

  RETURN json_build_object('order_id', p_order_id, 'paid', v_sum, 'tip', v_tip);
END $$;

REVOKE EXECUTE ON FUNCTION pay_order FROM anon, public;

-- ============================================================
-- shift_report — добавлена строка tips_total. cash/card_sales —
-- по-прежнему фактические деньги по способам (включают чаевые),
-- на них держится expected_cash; чаевые показываем отдельно.
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
  v_tips      INTEGER;
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

  RETURN json_build_object(
    'shift_id',      v_shift.id,
    'status',        v_shift.status,
    'opened_at',     v_shift.opened_at,
    'opening_float', v_shift.opening_float,
    'cash_sales',    v_cash,
    'card_sales',    v_card,
    'total_sales',   v_cash + v_card,
    'tips_total',    v_tips,
    'expected_cash', v_shift.opening_float + v_cash,
    'orders_count',  v_orders
  );
END $$;

-- ============================================================
-- close_shift — Z-отчёт тоже отдаёт tips_total (хранимые
-- колонки смены не меняем: чаевые восстановимы из orders).
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
  v_tips     INTEGER;
  v_expected INTEGER;
  v_open_orders INTEGER;
BEGIN
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift already closed';
  END IF;

  -- Guard 032: нельзя закрыть смену с неоплаченными счетами
  SELECT COUNT(*) INTO v_open_orders
  FROM orders WHERE location_id = v_shift.location_id AND status = 'open';
  IF v_open_orders > 0 THEN
    RAISE EXCEPTION 'shift has open orders: %', v_open_orders;
  END IF;

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
    'cash_sales',    v_cash,
    'card_sales',    v_card,
    'total_sales',   v_cash + v_card,
    'tips_total',    v_tips,
    'expected_cash', v_expected,
    'counted_cash',  p_counted_cash,
    'cash_diff',     p_counted_cash - v_expected,
    'orders_count',  v_orders
  );
END $$;
