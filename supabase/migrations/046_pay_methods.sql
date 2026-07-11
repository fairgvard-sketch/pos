-- ============================================================
-- 046 PAY METHODS — обеденные кошельки Cibus / Tenbis (10bis) / Bit
-- как способы оплаты + задел под Cardcom EMV.
--
-- Зачем: кофейня у офисов в Израиле живёт на обеденных кошельках —
-- в будни это заметная доля выручки. Учётная версия (без API):
-- кассир проводит оплату кошельком на стороннем устройстве/приложении
-- и фиксирует способ в кассе — сверка с выплатами Pluxee/10bis идёт
-- по разбивке способов в X/Z-отчёте.
--
-- Что меняется:
--   * payments.method / refunds.method: + 'cibus' | 'tenbis' | 'bit';
--   * pay_order / issue_refund принимают новые способы (правило
--     возврата «тем же способом» 030 покрывает их автоматически);
--   * shift_report / close_shift: + method_sales / method_gross —
--     разбивка по КАЖДОМУ способу (для сверки), total_sales теперь
--     сумма ВСЕХ способов (не только cash+card); expected_cash
--     по-прежнему считается только от наличных;
--   * задел Cardcom: nullable-поля транзакции на payments
--     (provider/provider_ref/card_last4/auth_code) — их заполнит
--     интеграция с пинпадом, учётная логика уже готова их хранить.
--
-- Тела pay_order (042) / issue_refund (044) / shift_report (038) /
-- close_shift (044) копируются, сигнатуры НЕ меняются → CREATE OR
-- REPLACE (без DROP, PostgREST-overload не возникает).
--
-- ⚠️ ТРЕБУЕТ ПРИМЕНЁННОЙ 044: сигнатуры issue_refund/close_shift здесь
-- 044-е (с p_staff_session) и вызывается require_staff_perm. Применение
-- 046 БЕЗ 044 создаст overload-дубли и сломает PostgREST.
-- ============================================================

-- ── Новые способы в constraint'ах ────────────────────────────
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('cash', 'card', 'cibus', 'tenbis', 'bit'));

ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_method_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_method_check
  CHECK (method IN ('cash', 'card', 'cibus', 'tenbis', 'bit'));

-- ── Задел Cardcom EMV: реквизиты карточной транзакции ────────
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider     TEXT,  -- 'cardcom' | ...
  ADD COLUMN IF NOT EXISTS provider_ref TEXT,  -- id транзакции у провайдера
  ADD COLUMN IF NOT EXISTS card_last4   TEXT,  -- последние 4 цифры (на чек)
  ADD COLUMN IF NOT EXISTS auth_code    TEXT;  -- код авторизации

-- ============================================================
-- pay_order (тело 042, шире список способов)
-- ============================================================
CREATE OR REPLACE FUNCTION pay_order(
  p_order_id     UUID,
  p_payments     JSONB,
  p_tip          INTEGER     DEFAULT 0,
  p_payment_uuid UUID        DEFAULT NULL,
  p_paid_at      TIMESTAMPTZ DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_loc    UUID := auth_location_id();
  v_order  orders%ROWTYPE;
  v_shift  UUID;
  v_pay    JSONB;
  v_sum    INTEGER := 0;
  v_tip    INTEGER := GREATEST(COALESCE(p_tip, 0), 0);
  v_paid_at TIMESTAMPTZ := clamp_client_ts(p_paid_at);
  v_result JSONB;
  -- лояльность
  v_guest    guests%ROWTYPE;
  v_mode     TEXT;
  v_goal     INTEGER;
  v_pct      NUMERIC(5,2);
  v_eligible INTEGER;
  v_stamps_d INTEGER := 0;
  v_points_d INTEGER := 0;
  v_earn     INTEGER := 0;
  -- фискальный номер (020, в той же транзакции)
  v_receipt  INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Идемпотентность: этот платёж уже проведён → тот же ответ, без мутаций
  IF p_payment_uuid IS NOT NULL THEN
    SELECT result INTO v_result FROM op_log
    WHERE op_uuid = p_payment_uuid AND org_id = v_org;
    IF FOUND THEN
      RETURN v_result::JSON;
    END IF;
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
    IF (v_pay ->> 'method') NOT IN ('cash', 'card', 'cibus', 'tenbis', 'bit') THEN
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

  -- ── Фискальный номер (020): атомарный инкремент счётчика локации ──
  INSERT INTO receipt_counters (location_id, counter)
  VALUES (v_order.location_id, 1)
  ON CONFLICT (location_id)
  DO UPDATE SET counter = receipt_counters.counter + 1
  RETURNING counter INTO v_receipt;

  UPDATE orders
  SET status = 'paid', paid_at = v_paid_at, shift_id = v_shift, tip_amount = v_tip,
      receipt_number = v_receipt
  WHERE id = p_order_id;

  v_result := jsonb_build_object(
    'order_id', p_order_id,
    'paid', v_sum,
    'tip', v_tip,
    'receipt_number', v_receipt
  );

  IF p_payment_uuid IS NOT NULL THEN
    INSERT INTO op_log (op_uuid, org_id, fn, result)
    VALUES (p_payment_uuid, v_org, 'pay_order', v_result);
  END IF;

  RETURN v_result::JSON;
END $$;

-- ============================================================
-- issue_refund (тело 044, шире список способов; правило
-- «возврат тем же способом» покрывает кошельки автоматически)
-- ============================================================
CREATE OR REPLACE FUNCTION issue_refund(
  p_refund_id UUID,
  p_order_id  UUID,
  p_staff_id  UUID,
  p_amount    INTEGER,
  p_method    TEXT,
  p_reason    TEXT  DEFAULT NULL,
  p_items     JSONB DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
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
  PERFORM require_staff_perm(p_staff_session, 'refund');
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  IF p_method NOT IN ('cash', 'card', 'cibus', 'tenbis', 'bit') THEN
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

-- ============================================================
-- shift_report (тело 038 + method_sales, total_sales по всем способам)
-- ============================================================
CREATE OR REPLACE FUNCTION shift_report(p_shift_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_shift     shifts%ROWTYPE;
  v_cash      INTEGER;
  v_card      INTEGER;
  v_total     INTEGER;
  v_orders    INTEGER;
  v_tips      INTEGER;
  v_in        INTEGER;
  v_out       INTEGER;
  v_methods   JSONB;
BEGIN
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE method = 'cash'), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'card'), 0),
    COALESCE(SUM(amount), 0)
  INTO v_cash, v_card, v_total
  FROM payments WHERE shift_id = p_shift_id;

  -- Нетто по каждому способу (для сверки кошельков): {"cash":..,"cibus":..}
  SELECT COALESCE(jsonb_object_agg(m.method, m.net), '{}'::jsonb) INTO v_methods
  FROM (
    SELECT method, SUM(amount) AS net
    FROM payments WHERE shift_id = p_shift_id GROUP BY method
  ) m;

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
    'method_sales',  v_methods,
    'total_sales',   v_total,
    'tips_total',    v_tips,
    'cash_in',       v_in,
    'cash_out',      v_out,
    'expected_cash', v_shift.opening_float + v_cash + v_in - v_out,
    'orders_count',  v_orders
  );
END $$;

-- ============================================================
-- close_shift (тело 044 + method_gross, total_sales по всем способам;
-- expected_cash по-прежнему только от наличных)
-- ============================================================
CREATE OR REPLACE FUNCTION close_shift(
  p_shift_id      UUID,
  p_staff_id      UUID,
  p_counted_cash  INTEGER,
  p_note          TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org         UUID := auth_org_id();
  v_shift       shifts%ROWTYPE;
  v_cash        INTEGER;
  v_card        INTEGER;
  v_total_net   INTEGER;
  v_gross_cash  INTEGER;
  v_gross_card  INTEGER;
  v_gross_total INTEGER;
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
  v_methods     JSONB;
  v_closed_at   TIMESTAMPTZ := NOW();
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'close_shift');

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

  -- Авто-аннулируем мусор (035/039)
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
    COALESCE(SUM(amount), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'cash' AND amount > 0), 0),
    COALESCE(SUM(amount) FILTER (WHERE method = 'card' AND amount > 0), 0),
    COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0),
    COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0),
    COUNT(DISTINCT order_id) FILTER (WHERE amount > 0)
  INTO v_cash, v_card, v_total_net, v_gross_cash, v_gross_card, v_gross_total, v_refunds, v_orders
  FROM payments WHERE shift_id = p_shift_id;

  -- Брутто по каждому способу — для Z-отчёта и сверки кошельков
  SELECT COALESCE(jsonb_object_agg(m.method, m.gross), '{}'::jsonb) INTO v_methods
  FROM (
    SELECT method, SUM(amount) AS gross
    FROM payments WHERE shift_id = p_shift_id AND amount > 0 GROUP BY method
  ) m;

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
    total_sales   = v_total_net,
    orders_count  = v_orders,
    closed_at     = v_closed_at,
    close_note    = NULLIF(TRIM(p_note), ''),
    z_number      = v_z
  WHERE id = p_shift_id;

  RETURN json_build_object(
    'cash_sales',       v_cash,
    'card_sales',       v_card,
    'total_sales',      v_total_net,
    'gross_cash',       v_gross_cash,
    'gross_card',       v_gross_card,
    'gross_total',      v_gross_total,
    'method_gross',     v_methods,
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
