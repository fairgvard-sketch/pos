-- ============================================================
-- 042 OFFLINE IDEMPOTENCY — фундамент офлайн-очереди (фаза 7).
--
-- Касса копит операции локально при обрыве сети и проигрывает их
-- при восстановлении. Replay обязан быть безопасным: повтор любой
-- операции из очереди НЕ дублирует деньги/строки и возвращает тот же
-- результат, что и первый вызов (включая фискальный receipt_number).
--
-- Механика:
--   * op_log — универсальный журнал идемпотентности: op_uuid (генерирует
--     касса) → сохранённый результат первого вызова. Проверка в начале
--     RPC, запись В ТОЙ ЖЕ транзакции, что мутация: «платёж прошёл,
--     а дедуп-записи нет» невозможно.
--   * clamp_client_ts — «честное» время операции с кассы (продажа была
--     в 10:00, replay в 14:00 → paid_at/created_at = 10:00), с защитой
--     от кривых часов устройства.
--   * place_order уже идемпотентен по orders.client_uuid (004) — op_log
--     ему не нужен, добавляется только p_placed_at.
--   * Все новые параметры с DEFAULT NULL — задеплоенные клиенты
--     продолжают работать. DROP старых сигнатур обязателен: два
--     overload ломают разрешение имён в PostgREST (грабли 033).
--
-- Смена при replay: платёж падает в ТЕКУЩУЮ открытую смену (клиент
-- блокирует закрытие смены при непустой очереди; если смену всё же
-- закрыли с другого устройства — 'no open shift' → операция помечается
-- failed, ручное разрешение: открыть смену и повторить).
-- ============================================================

-- ── Журнал идемпотентности ───────────────────────────────────
CREATE TABLE op_log (
  op_uuid    UUID PRIMARY KEY,                    -- генерирует касса
  org_id     UUID NOT NULL REFERENCES orgs(id),
  fn         TEXT NOT NULL,                       -- 'pay_order' | 'append_to_order' | ...
  result     JSONB NOT NULL,                      -- точный JSON первого ответа
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_op_log_created ON op_log(created_at);

-- Доступ только из SECURITY DEFINER функций: RLS включён, политик нет.
ALTER TABLE op_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON op_log FROM anon, authenticated, public;

-- ── Честное время операции с защитой от кривых часов ────────
-- NULL / из будущего (>10 мин) / старше 7 дней → NOW().
CREATE OR REPLACE FUNCTION clamp_client_ts(p_ts TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_ts IS NULL                          THEN NOW()
    WHEN p_ts > NOW() + INTERVAL '10 minutes'  THEN NOW()
    WHEN p_ts < NOW() - INTERVAL '7 days'      THEN NOW()
    ELSE p_ts
  END;
$$;

-- ============================================================
-- pay_order (041 + идемпотентность + честное paid_at)
-- Повтор с тем же p_payment_uuid возвращает ТОТ ЖЕ результат,
-- включая уже присвоенный receipt_number — счётчик не тратится.
-- ============================================================
DROP FUNCTION IF EXISTS pay_order(UUID, JSONB, INTEGER);

CREATE FUNCTION pay_order(
  p_order_id     UUID,
  p_payments     JSONB,
  p_tip          INTEGER     DEFAULT 0,
  p_payment_uuid UUID        DEFAULT NULL,  -- ключ идемпотентности (op_log)
  p_paid_at      TIMESTAMPTZ DEFAULT NULL   -- честное время оплаты с кассы
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
  v_stamps_d INTEGER := 0;  -- итоговое изменение штампов
  v_points_d INTEGER := 0;  -- итоговое изменение баллов (агороты)
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
  -- исключено (повторный вызов упадёт на 'order not open' выше,
  -- а с p_payment_uuid вернёт сохранённый ответ из op_log).
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

REVOKE EXECUTE ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ) FROM anon, public;

-- ============================================================
-- place_order (034 + честное placed_at)
-- Идемпотентность прежняя — по orders.client_uuid (004).
-- daily_number нумеруется в ДЕНЬ продажи (placed_at в таймзоне точки):
-- офлайн-заказ, доехавший после полуночи, получает номер своего дня.
-- ============================================================
DROP FUNCTION IF EXISTS place_order(UUID, UUID, TEXT, TEXT, JSONB, JSONB, TEXT);

CREATE FUNCTION place_order(
  p_client_uuid   UUID,
  p_staff_id      UUID,
  p_order_type    TEXT,
  p_customer_name TEXT,
  p_items         JSONB,
  p_discount      JSONB       DEFAULT NULL,
  p_table_label   TEXT        DEFAULT NULL,
  p_placed_at     TIMESTAMPTZ DEFAULT NULL  -- честное время оформления с кассы
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_loc       UUID := auth_location_id();
  v_existing  orders%ROWTYPE;
  v_shift     UUID;
  v_vat_rate  NUMERIC(5,2);
  v_number    INTEGER;
  v_order_id  UUID;
  v_placed_at TIMESTAMPTZ := clamp_client_ts(p_placed_at);
  v_item      JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_variant   item_variants%ROWTYPE;
  v_mod       modifiers%ROWTYPE;
  v_mod_id    UUID;
  v_unit      INTEGER;
  v_override  INTEGER;
  v_is_custom BOOLEAN;
  v_name      TEXT;
  v_qty       INTEGER;
  v_line      INTEGER;
  v_subtotal  INTEGER := 0;
  v_oi_id     UUID;
  v_table     TEXT;
  v_disc_type   TEXT := NULL;
  v_disc_value  INTEGER := NULL;
  v_disc_reason TEXT := NULL;
  v_disc_amount INTEGER := 0;
  v_total     INTEGER;
  v_vat       INTEGER;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_existing FROM orders WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('order_id', v_existing.id, 'daily_number', v_existing.daily_number, 'total', v_existing.total, 'duplicate', TRUE);
  END IF;

  IF p_order_type NOT IN ('here', 'takeaway') THEN
    RAISE EXCEPTION 'invalid order type';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order has no items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  SELECT vat_rate INTO v_vat_rate FROM locations WHERE id = v_loc;

  v_table := NULLIF(TRIM(p_table_label), '');

  -- Счётчик дня продажи (не дня replay)
  INSERT INTO order_counters (location_id, day, counter)
  VALUES (v_loc, (v_placed_at AT TIME ZONE (SELECT timezone FROM locations WHERE id = v_loc))::date, 1)
  ON CONFLICT (location_id, day)
  DO UPDATE SET counter = order_counters.counter + 1
  RETURNING counter INTO v_number;

  INSERT INTO orders (org_id, location_id, staff_id, client_uuid, daily_number,
                      order_type, customer_name, status, vat_rate, shift_id, table_label,
                      created_at)
  VALUES (v_org, v_loc, p_staff_id, p_client_uuid, v_number,
          p_order_type, NULLIF(TRIM(p_customer_name), ''), 'open', v_vat_rate, v_shift, v_table,
          v_placed_at)
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;

    v_override := NULLIF(v_item ->> 'unit_price_override', '')::INTEGER;
    v_is_custom := (v_item ->> 'menu_item_id') IS NULL;

    IF v_is_custom THEN
      IF v_override IS NULL OR v_override < 0 THEN
        RAISE EXCEPTION 'custom item requires unit_price_override';
      END IF;
      v_name := NULLIF(TRIM(v_item ->> 'custom_name'), '');
      IF v_name IS NULL THEN
        RAISE EXCEPTION 'custom item requires name';
      END IF;

      v_unit := v_override;
      v_line := v_unit * v_qty;
      v_subtotal := v_subtotal + v_line;

      INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                               name, variant_name, unit_price, qty, line_total, notes,
                               is_price_overridden)
      VALUES (v_org, v_order_id, NULL, NULL, NULL,
              v_name, NULL, v_unit, v_qty, v_line,
              NULLIF(TRIM(v_item ->> 'notes'), ''), TRUE);
      CONTINUE;
    END IF;

    SELECT * INTO v_menu_item FROM menu_items
      WHERE id = (v_item ->> 'menu_item_id')::UUID AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'menu item not found: %', v_item ->> 'menu_item_id';
    END IF;

    v_variant := NULL;
    IF v_item ->> 'variant_id' IS NOT NULL THEN
      SELECT * INTO v_variant FROM item_variants
        WHERE id = (v_item ->> 'variant_id')::UUID AND item_id = v_menu_item.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'variant not found';
      END IF;
      v_unit := v_variant.price;
    ELSE
      v_unit := v_menu_item.price;
    END IF;

    IF v_item ? 'modifier_ids' THEN
      FOR v_mod_id IN SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID LOOP
        SELECT * INTO v_mod FROM modifiers WHERE id = v_mod_id AND org_id = v_org;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'modifier not found';
        END IF;
        v_unit := v_unit + v_mod.price_delta;
      END LOOP;
    END IF;

    IF v_override IS NOT NULL THEN
      IF v_override < 0 THEN
        RAISE EXCEPTION 'invalid price override';
      END IF;
      v_unit := v_override;
    END IF;

    v_line := v_unit * v_qty;
    v_subtotal := v_subtotal + v_line;

    INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                             name, variant_name, unit_price, qty, line_total, notes,
                             is_price_overridden)
    VALUES (v_org, v_order_id, v_menu_item.id, v_variant.id, v_menu_item.station_id,
            v_menu_item.name, v_variant.name, v_unit, v_qty, v_line,
            NULLIF(TRIM(v_item ->> 'notes'), ''), v_override IS NOT NULL)
    RETURNING id INTO v_oi_id;

    IF v_item ? 'modifier_ids' THEN
      INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta)
      SELECT v_org, v_oi_id, m.id, m.name, m.price_delta
      FROM modifiers m
      WHERE m.id IN (SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID);
    END IF;
  END LOOP;

  -- ── Скидка на заказ ──────────────────────────────────
  IF p_discount IS NOT NULL AND (p_discount ->> 'type') IS NOT NULL THEN
    v_disc_type   := p_discount ->> 'type';
    v_disc_value  := NULLIF(p_discount ->> 'value', '')::INTEGER;
    v_disc_reason := NULLIF(TRIM(p_discount ->> 'reason'), '');

    IF v_disc_type NOT IN ('percent', 'fixed') THEN
      RAISE EXCEPTION 'invalid discount type';
    END IF;
    IF v_disc_value IS NULL OR v_disc_value < 0 THEN
      RAISE EXCEPTION 'invalid discount value';
    END IF;

    IF v_disc_type = 'percent' THEN
      IF v_disc_value > 100 THEN
        RAISE EXCEPTION 'discount percent out of range';
      END IF;
      v_disc_amount := ROUND(v_subtotal * v_disc_value / 100.0);
    ELSE
      v_disc_amount := v_disc_value;
    END IF;

    IF v_disc_amount > v_subtotal THEN
      v_disc_amount := v_subtotal;
    END IF;
  END IF;

  -- Итог с округлением до целого шекеля (только при реальном вычете:
  -- нулевая скидка, напр. 0%, итог не трогает). Скидка вбирает «хвост»:
  -- discount_amount = subtotal − round(total).
  v_total := round_order_total(v_subtotal - v_disc_amount, v_subtotal, v_disc_amount > 0);
  IF v_disc_amount > 0 THEN
    v_disc_amount := v_subtotal - v_total;
  END IF;
  v_vat := ROUND(v_total * v_vat_rate / (100 + v_vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal,
      discount_type = v_disc_type,
      discount_value = v_disc_value,
      discount_amount = v_disc_amount,
      discount_reason = v_disc_reason,
      total = v_total,
      vat_amount = v_vat
  WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'daily_number', v_number, 'total', v_total, 'duplicate', FALSE);
END $$;

REVOKE EXECUTE ON FUNCTION place_order(UUID, UUID, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ) FROM anon, public;

-- ============================================================
-- append_to_order (034 + идемпотентность по p_op_uuid)
-- Replay дозаказа не дублирует строки: повтор возвращает тот же ответ.
-- ============================================================
DROP FUNCTION IF EXISTS append_to_order(UUID, UUID, JSONB);

CREATE FUNCTION append_to_order(
  p_order_id UUID,
  p_staff_id UUID,
  p_items    JSONB,
  p_op_uuid  UUID DEFAULT NULL  -- ключ идемпотентности (op_log)
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_order     orders%ROWTYPE;
  v_item      JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_variant   item_variants%ROWTYPE;
  v_mod       modifiers%ROWTYPE;
  v_mod_id    UUID;
  v_unit      INTEGER;
  v_override  INTEGER;
  v_is_custom BOOLEAN;
  v_name      TEXT;
  v_qty       INTEGER;
  v_line      INTEGER;
  v_oi_id     UUID;
  v_subtotal  INTEGER;
  v_disc_amount INTEGER;
  v_total     INTEGER;
  v_vat       INTEGER;
  v_result    JSONB;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Идемпотентность: этот дозаказ уже проведён → тот же ответ, без мутаций
  IF p_op_uuid IS NOT NULL THEN
    SELECT result INTO v_result FROM op_log
    WHERE op_uuid = p_op_uuid AND org_id = v_org;
    IF FOUND THEN
      RETURN v_result::JSON;
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order has no items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;

    v_override := NULLIF(v_item ->> 'unit_price_override', '')::INTEGER;
    v_is_custom := (v_item ->> 'menu_item_id') IS NULL;

    IF v_is_custom THEN
      IF v_override IS NULL OR v_override < 0 THEN
        RAISE EXCEPTION 'custom item requires unit_price_override';
      END IF;
      v_name := NULLIF(TRIM(v_item ->> 'custom_name'), '');
      IF v_name IS NULL THEN
        RAISE EXCEPTION 'custom item requires name';
      END IF;
      v_unit := v_override;
      v_line := v_unit * v_qty;

      INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                               name, variant_name, unit_price, qty, line_total, notes,
                               is_price_overridden)
      VALUES (v_org, p_order_id, NULL, NULL, NULL,
              v_name, NULL, v_unit, v_qty, v_line,
              NULLIF(TRIM(v_item ->> 'notes'), ''), TRUE);
      CONTINUE;
    END IF;

    SELECT * INTO v_menu_item FROM menu_items
      WHERE id = (v_item ->> 'menu_item_id')::UUID AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'menu item not found';
    END IF;

    v_variant := NULL;
    IF v_item ->> 'variant_id' IS NOT NULL THEN
      SELECT * INTO v_variant FROM item_variants
        WHERE id = (v_item ->> 'variant_id')::UUID AND item_id = v_menu_item.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'variant not found';
      END IF;
      v_unit := v_variant.price;
    ELSE
      v_unit := v_menu_item.price;
    END IF;

    IF v_item ? 'modifier_ids' THEN
      FOR v_mod_id IN SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID LOOP
        SELECT * INTO v_mod FROM modifiers WHERE id = v_mod_id AND org_id = v_org;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'modifier not found';
        END IF;
        v_unit := v_unit + v_mod.price_delta;
      END LOOP;
    END IF;

    IF v_override IS NOT NULL THEN
      IF v_override < 0 THEN
        RAISE EXCEPTION 'invalid price override';
      END IF;
      v_unit := v_override;
    END IF;

    v_line := v_unit * v_qty;

    INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                             name, variant_name, unit_price, qty, line_total, notes,
                             is_price_overridden)
    VALUES (v_org, p_order_id, v_menu_item.id, v_variant.id, v_menu_item.station_id,
            v_menu_item.name, v_variant.name, v_unit, v_qty, v_line,
            NULLIF(TRIM(v_item ->> 'notes'), ''), v_override IS NOT NULL)
    RETURNING id INTO v_oi_id;

    IF v_item ? 'modifier_ids' THEN
      INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta)
      SELECT v_org, v_oi_id, m.id, m.name, m.price_delta
      FROM modifiers m
      WHERE m.id IN (SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID);
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;

  v_disc_amount := 0;
  IF v_order.discount_type = 'percent' THEN
    v_disc_amount := ROUND(v_subtotal * v_order.discount_value / 100.0);
  ELSIF v_order.discount_type = 'fixed' THEN
    v_disc_amount := v_order.discount_value;
  END IF;
  IF v_disc_amount > v_subtotal THEN
    v_disc_amount := v_subtotal;
  END IF;

  v_total := round_order_total(v_subtotal - v_disc_amount, v_subtotal, v_disc_amount > 0);
  IF v_disc_amount > 0 THEN v_disc_amount := v_subtotal - v_total; END IF;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, discount_amount = v_disc_amount,
      total = v_total, vat_amount = v_vat
  WHERE id = p_order_id;

  v_result := jsonb_build_object('order_id', p_order_id, 'total', v_total, 'subtotal', v_subtotal);

  IF p_op_uuid IS NOT NULL THEN
    INSERT INTO op_log (op_uuid, org_id, fn, result)
    VALUES (p_op_uuid, v_org, 'append_to_order', v_result);
  END IF;

  RETURN v_result::JSON;
END $$;

REVOKE EXECUTE ON FUNCTION append_to_order(UUID, UUID, JSONB, UUID) FROM anon, public;

-- ============================================================
-- open_or_get_table_order (013 + client_uuid как локальный ключ кассы)
-- Порядок поиска:
--   1) p_client_uuid задан и заказ с ним существует → вернуть (replay);
--   2) у стола есть открытый счёт → вернуть (прежняя семантика);
--   3) создать новый с client_uuid кассы и честным created_at.
-- ============================================================
DROP FUNCTION IF EXISTS open_or_get_table_order(UUID, UUID);

CREATE FUNCTION open_or_get_table_order(
  p_table_id    UUID,
  p_staff_id    UUID,
  p_client_uuid UUID        DEFAULT NULL,  -- локальный ключ заказа с кассы
  p_opened_at   TIMESTAMPTZ DEFAULT NULL   -- честное время открытия стола
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_loc       UUID := auth_location_id();
  v_shift     UUID;
  v_vat_rate  NUMERIC(5,2);
  v_number    INTEGER;
  v_order     orders%ROWTYPE;
  v_label     TEXT;
  v_opened_at TIMESTAMPTZ := clamp_client_ts(p_opened_at);
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  -- Replay: заказ с этим client_uuid уже создан → вернуть его
  IF p_client_uuid IS NOT NULL THEN
    SELECT * INTO v_order FROM orders
    WHERE client_uuid = p_client_uuid AND org_id = v_org;
    IF FOUND THEN
      RETURN json_build_object('order_id', v_order.id, 'daily_number', v_order.daily_number,
                               'total', v_order.total, 'existing', TRUE);
    END IF;
  END IF;

  -- Стол существует и наш
  SELECT label INTO v_label FROM tables
  WHERE id = p_table_id AND org_id = v_org AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table not found';
  END IF;

  -- Уже есть открытый счёт → вернуть его
  SELECT * INTO v_order FROM orders
  WHERE table_id = p_table_id AND status = 'open';
  IF FOUND THEN
    RETURN json_build_object('order_id', v_order.id, 'daily_number', v_order.daily_number,
                             'total', v_order.total, 'existing', TRUE);
  END IF;

  -- Продажа только при открытой смене
  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  SELECT vat_rate INTO v_vat_rate FROM locations WHERE id = v_loc;

  -- Счётчик дня открытия (не дня replay)
  INSERT INTO order_counters (location_id, day, counter)
  VALUES (v_loc, (v_opened_at AT TIME ZONE (SELECT timezone FROM locations WHERE id = v_loc))::date, 1)
  ON CONFLICT (location_id, day)
  DO UPDATE SET counter = order_counters.counter + 1
  RETURNING counter INTO v_number;

  INSERT INTO orders (org_id, location_id, staff_id, client_uuid, daily_number,
                      order_type, status, vat_rate, shift_id, table_id, table_label,
                      created_at)
  VALUES (v_org, v_loc, p_staff_id, COALESCE(p_client_uuid, gen_random_uuid()), v_number,
          'here', 'open', v_vat_rate, v_shift, p_table_id, v_label,
          v_opened_at)
  RETURNING * INTO v_order;

  RETURN json_build_object('order_id', v_order.id, 'daily_number', v_order.daily_number,
                           'total', 0, 'existing', FALSE);
END $$;

REVOKE EXECUTE ON FUNCTION open_or_get_table_order(UUID, UUID, UUID, TIMESTAMPTZ) FROM anon, public;

-- ============================================================
-- void_table_order (013 → толерантный к replay)
-- Уже voided → тихий no-op (повтор из очереди — не ошибка).
-- Оплаченный/выданный → ошибка: деньги существуют, void невозможен —
-- операция всплывёт как failed и требует ручного разбора.
-- ============================================================
CREATE OR REPLACE FUNCTION void_table_order(p_order_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_order orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM orders
  WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status = 'voided' THEN
    RETURN;  -- идемпотентно: уже отменён
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order already paid';
  END IF;

  UPDATE orders
  SET status = 'voided', voided_at = NOW(), void_reason = NULLIF(TRIM(p_reason), '')
  WHERE id = p_order_id;
END $$;

-- ============================================================
-- void_order_item (034 → толерантный к replay)
-- Строка уже отменена → вернуть текущие снапшот-итоги заказа
-- (повтор из очереди — не ошибка). «Не найдена» — по-прежнему ошибка.
-- ============================================================
CREATE OR REPLACE FUNCTION void_order_item(p_item_id UUID, p_staff_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_item      order_items%ROWTYPE;
  v_order     orders%ROWTYPE;
  v_subtotal  INTEGER;
  v_disc      INTEGER;
  v_total     INTEGER;
  v_vat       INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_item FROM order_items
  WHERE id = p_item_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = v_item.order_id AND org_id = v_org FOR UPDATE;

  -- Replay: строка уже отменена → итоги уже пересчитаны, вернуть их
  IF v_item.voided_at IS NOT NULL THEN
    RETURN json_build_object('order_id', v_order.id, 'total', v_order.total, 'subtotal', v_order.subtotal);
  END IF;

  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  UPDATE order_items
  SET voided_at = NOW(), voided_by = p_staff_id, void_reason = NULLIF(TRIM(p_reason), '')
  WHERE id = p_item_id;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = v_order.id AND voided_at IS NULL;

  v_disc := 0;
  IF v_order.discount_type = 'percent' THEN
    v_disc := ROUND(v_subtotal * v_order.discount_value / 100.0);
  ELSIF v_order.discount_type = 'fixed' THEN
    v_disc := v_order.discount_value;
  END IF;
  IF v_disc > v_subtotal THEN
    v_disc := v_subtotal;
  END IF;

  v_total := round_order_total(v_subtotal - v_disc, v_subtotal, v_disc > 0);
  IF v_disc > 0 THEN v_disc := v_subtotal - v_total; END IF;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, discount_amount = v_disc, total = v_total, vat_amount = v_vat
  WHERE id = v_order.id;

  RETURN json_build_object('order_id', v_order.id, 'total', v_total, 'subtotal', v_subtotal);
END $$;

REVOKE EXECUTE ON FUNCTION void_table_order, void_order_item FROM anon, public;

-- ── Естественно идемпотентные (op_uuid не нужен) ─────────────
-- set_order_discount: абсолютная установка скидки — повтор даёт тот же итог.
-- set_table_status, mark_item_ready, mark_order_ready: абсолютная установка
-- состояния — повтор no-op.
COMMENT ON FUNCTION set_order_discount(UUID, TEXT, INTEGER, TEXT) IS
  'Идемпотентна для offline-replay: абсолютная установка скидки (042)';
