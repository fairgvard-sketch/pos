-- ============================================================
-- 041 PAY_ORDER + RECEIPT NUMBER — один сетевой заход на оплату.
--
-- Было: клиент звал pay_order, затем ВТОРЫМ RPC assign_receipt_number
-- (020) — два последовательных round-trip на каждой продаже
-- (+150–400мс на 4G между «Оплатить» и номером заказа).
--
-- Стало: pay_order присваивает сквозной фискальный номер сам,
-- в той же транзакции. Строка заказа уже под FOR UPDATE, статус
-- только что стал 'paid' — все инварианты 020 соблюдены:
--   * номер получает только оплаченный документ;
--   * непрерывность: void до оплаты номер не тратит;
--   * идемпотентность: повторный вызов не выдаст второй номер
--     (заказ уже не 'open' → 'order not open').
--
-- assign_receipt_number ОСТАЁТСЯ (идемпотентен): старые клиенты в
-- переходный период зовут его после pay_order и получают уже
-- присвоенный номер без инкремента счётчика.
--
-- Тело — 033 (чаевые + лояльность) + блок номера перед RETURN.
-- ============================================================

CREATE OR REPLACE FUNCTION pay_order(p_order_id UUID, p_payments JSONB, p_tip INTEGER DEFAULT 0)
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
  -- фискальный номер (020, теперь в той же транзакции)
  v_receipt  INTEGER;
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

  -- ── Фискальный номер (020): атомарный инкремент счётчика локации ──
  -- Заказ заперт FOR UPDATE и получает 'paid' ниже — двойное присвоение
  -- исключено (повторный вызов упадёт на 'order not open' выше).
  INSERT INTO receipt_counters (location_id, counter)
  VALUES (v_order.location_id, 1)
  ON CONFLICT (location_id)
  DO UPDATE SET counter = receipt_counters.counter + 1
  RETURNING counter INTO v_receipt;

  UPDATE orders
  SET status = 'paid', paid_at = NOW(), shift_id = v_shift, tip_amount = v_tip,
      receipt_number = v_receipt
  WHERE id = p_order_id;

  RETURN json_build_object(
    'order_id', p_order_id,
    'paid', v_sum,
    'tip', v_tip,
    'receipt_number', v_receipt
  );
END $$;

REVOKE EXECUTE ON FUNCTION pay_order FROM anon, public;
