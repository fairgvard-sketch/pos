-- ============================================================
-- 034 ROUND TOTALS — итог заказа со скидкой/лояльностью округляется
-- до ближайшего целого шекеля (по правилам математики).
--
-- Запрос бизнеса: «сумма должна округляться до полной, если
-- добавляешь скидки». Мелочь (агороты) в итоге на кассе неудобна —
-- при скидке/лояльности подгоняем итог к круглому числу шекелей.
--
-- Принципы:
--   * Округляем ИТОГ (не саму скидку) до ближайшего шекеля:
--     total := round(total/100)*100. Скидка вбирает «хвост» до целого
--     шекеля — гость платит круглую сумму, аудит цел (снапшот согласован).
--   * Округление вверх не может поднять итог ВЫШЕ суммы до вычета
--     (иначе скидка ушла бы в минус): результат ограничен потолком.
--   * Округляем ТОЛЬКО когда есть скидка ИЛИ вычет лояльности.
--     Заказ без скидок = сумма позиций как есть (там уже точные цены).
--   * НДС считается ОТ округлённого итога (снапшот согласован с чеком).
--   * Чаевые округляются на клиенте (roundTipToWholeTotal): tip вне
--     total и вне базы НДС, серверу подгонять нечего.
--   * Клиентский discountAmount() — зеркало round_order_total(): при
--     скидке итог = round. Иначе optimistic-итог разойдётся со снапшотом.
--
-- Все функции, считающие снапшот-итог заказа, переопределяются на
-- эту помощницу: place_order, append_to_order, void_order_item,
-- set_order_discount, split_order, merge_table_orders, apply_loyalty.
-- ============================================================

-- Округление итога до ближайшего целого шекеля, только при наличии
-- вычета. p_pre_cut — сумма ДО вычета (потолок: округление вверх не
-- поднимает итог выше неё). Итог не уходит ниже нуля.
CREATE OR REPLACE FUNCTION round_order_total(p_total INTEGER, p_pre_cut INTEGER, p_has_discount BOOLEAN)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_total <= 0 THEN 0
    WHEN p_has_discount THEN LEAST(ROUND(p_total / 100.0) * 100, p_pre_cut)
    ELSE p_total
  END;
$$;

-- Старая двухаргументная версия (округление вниз) больше не используется
DROP FUNCTION IF EXISTS round_order_total(INTEGER, BOOLEAN);

-- ── place_order (012 + округление) ──────────────────────────
CREATE OR REPLACE FUNCTION place_order(
  p_client_uuid   UUID,
  p_staff_id      UUID,
  p_order_type    TEXT,
  p_customer_name TEXT,
  p_items         JSONB,
  p_discount      JSONB DEFAULT NULL,
  p_table_label   TEXT  DEFAULT NULL
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

  INSERT INTO order_counters (location_id, day, counter)
  VALUES (v_loc, (NOW() AT TIME ZONE (SELECT timezone FROM locations WHERE id = v_loc))::date, 1)
  ON CONFLICT (location_id, day)
  DO UPDATE SET counter = order_counters.counter + 1
  RETURNING counter INTO v_number;

  INSERT INTO orders (org_id, location_id, staff_id, client_uuid, daily_number,
                      order_type, customer_name, status, vat_rate, shift_id, table_label)
  VALUES (v_org, v_loc, p_staff_id, p_client_uuid, v_number,
          p_order_type, NULLIF(TRIM(p_customer_name), ''), 'open', v_vat_rate, v_shift, v_table)
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

  -- Итог с округлением вниз до целого шекеля (только при реальном вычете:
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

REVOKE EXECUTE ON FUNCTION place_order(UUID, UUID, TEXT, TEXT, JSONB, JSONB, TEXT) FROM anon, public;

-- ── set_order_discount (024 + округление) ───────────────────
CREATE OR REPLACE FUNCTION set_order_discount(
  p_order_id UUID,
  p_type     TEXT,
  p_value    INTEGER DEFAULT NULL,
  p_reason   TEXT    DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_order    orders%ROWTYPE;
  v_subtotal INTEGER;
  v_disc     INTEGER;
  v_total    INTEGER;
  v_vat      INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_type IS NOT NULL AND p_type NOT IN ('percent', 'fixed') THEN
    RAISE EXCEPTION 'invalid discount type';
  END IF;
  IF p_type IS NOT NULL AND (p_value IS NULL OR p_value < 0) THEN
    RAISE EXCEPTION 'invalid discount value';
  END IF;
  IF p_type = 'percent' AND p_value > 100 THEN
    RAISE EXCEPTION 'invalid discount percent';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;

  v_disc := 0;
  IF p_type = 'percent' THEN
    v_disc := ROUND(v_subtotal * p_value / 100.0);
  ELSIF p_type = 'fixed' THEN
    v_disc := p_value;
  END IF;
  IF v_disc > v_subtotal THEN v_disc := v_subtotal; END IF;

  v_total := round_order_total(v_subtotal - v_disc, v_subtotal, v_disc > 0);
  IF v_disc > 0 THEN v_disc := v_subtotal - v_total; END IF;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders SET
    discount_type   = p_type,
    discount_value  = CASE WHEN p_type IS NULL THEN NULL ELSE p_value END,
    discount_reason = CASE WHEN p_type IS NULL THEN NULL ELSE NULLIF(TRIM(p_reason), '') END,
    subtotal = v_subtotal, discount_amount = v_disc,
    total = v_total, vat_amount = v_vat
  WHERE id = p_order_id;

  RETURN json_build_object('total', v_total, 'discount_amount', v_disc, 'subtotal', v_subtotal);
END $$;

REVOKE EXECUTE ON FUNCTION set_order_discount(UUID, TEXT, INTEGER, TEXT) FROM anon, public;

-- ── void_order_item (015 + округление) ──────────────────────
CREATE OR REPLACE FUNCTION void_order_item(p_item_id UUID, p_staff_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_order_id  UUID;
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

  SELECT order_id INTO v_order_id FROM order_items
  WHERE id = p_item_id AND org_id = v_org AND voided_at IS NULL;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'item not found or already voided';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = v_order_id AND org_id = v_org FOR UPDATE;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  UPDATE order_items
  SET voided_at = NOW(), voided_by = p_staff_id, void_reason = NULLIF(TRIM(p_reason), '')
  WHERE id = p_item_id;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = v_order_id AND voided_at IS NULL;

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
  WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'total', v_total, 'subtotal', v_subtotal);
END $$;

REVOKE EXECUTE ON FUNCTION void_order_item FROM anon, public;

-- ── append_to_order (015 + округление) ──────────────────────
CREATE OR REPLACE FUNCTION append_to_order(
  p_order_id UUID,
  p_staff_id UUID,
  p_items    JSONB
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
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order has no items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org;
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

  RETURN json_build_object('order_id', p_order_id, 'total', v_total, 'subtotal', v_subtotal);
END $$;

-- ── split_order (021 + округление обеих частей) ─────────────
CREATE OR REPLACE FUNCTION split_order(
  p_order_id UUID,
  p_staff_id UUID,
  p_items    JSONB
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_src       orders%ROWTYPE;
  v_new_id    UUID;
  v_item      JSONB;
  v_row       order_items%ROWTYPE;
  v_move_qty  INTEGER;
  v_new_oi    UUID;
  v_src_sub   INTEGER;
  v_new_sub   INTEGER;
  v_disc      INTEGER;
  v_total     INTEGER;
  v_vat       INTEGER;
  v_remaining INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'nothing to split';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_src FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_src.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  INSERT INTO orders (org_id, location_id, staff_id, client_uuid, daily_number,
                      order_type, customer_name, status, vat_rate, shift_id, table_label)
  VALUES (v_org, v_src.location_id, p_staff_id, gen_random_uuid(), v_src.daily_number,
          v_src.order_type, v_src.customer_name, 'open', v_src.vat_rate, v_src.shift_id, v_src.table_label)
  RETURNING id INTO v_new_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_row FROM order_items
    WHERE id = (v_item ->> 'item_id')::UUID AND order_id = p_order_id
      AND org_id = v_org AND voided_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'item not found in order';
    END IF;

    v_move_qty := COALESCE((v_item ->> 'qty')::INTEGER, v_row.qty);
    IF v_move_qty < 1 OR v_move_qty > v_row.qty THEN
      RAISE EXCEPTION 'invalid split qty';
    END IF;

    IF v_move_qty = v_row.qty THEN
      UPDATE order_items SET order_id = v_new_id WHERE id = v_row.id;
    ELSE
      UPDATE order_items
      SET qty = qty - v_move_qty, line_total = unit_price * (qty - v_move_qty)
      WHERE id = v_row.id;

      INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                               name, variant_name, unit_price, qty, line_total, notes,
                               is_price_overridden, prep_status, ready_at)
      VALUES (v_org, v_new_id, v_row.menu_item_id, v_row.variant_id, v_row.station_id,
              v_row.name, v_row.variant_name, v_row.unit_price, v_move_qty,
              v_row.unit_price * v_move_qty, v_row.notes,
              v_row.is_price_overridden, v_row.prep_status, v_row.ready_at)
      RETURNING id INTO v_new_oi;

      INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta)
      SELECT org_id, v_new_oi, modifier_id, name, price_delta
      FROM order_item_modifiers WHERE order_item_id = v_row.id;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(line_total), 0) INTO v_src_sub
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;
  IF v_src_sub = 0 THEN
    RAISE EXCEPTION 'cannot split all items';
  END IF;

  -- Итоги исходного (скидка остаётся тут, округляется как в остальных)
  v_disc := 0;
  IF v_src.discount_type = 'percent' THEN
    v_disc := ROUND(v_src_sub * v_src.discount_value / 100.0);
  ELSIF v_src.discount_type = 'fixed' THEN
    v_disc := v_src.discount_value;
  END IF;
  IF v_disc > v_src_sub THEN v_disc := v_src_sub; END IF;
  v_total := round_order_total(v_src_sub - v_disc, v_src_sub, v_disc > 0);
  IF v_disc > 0 THEN v_disc := v_src_sub - v_total; END IF;
  v_vat := ROUND(v_total * v_src.vat_rate / (100 + v_src.vat_rate));
  UPDATE orders SET subtotal = v_src_sub, discount_amount = v_disc, total = v_total, vat_amount = v_vat
  WHERE id = p_order_id;
  v_remaining := v_total;

  -- Итоги нового (без скидки — округление не применяется)
  SELECT COALESCE(SUM(line_total), 0) INTO v_new_sub
  FROM order_items WHERE order_id = v_new_id AND voided_at IS NULL;
  v_vat := ROUND(v_new_sub * v_src.vat_rate / (100 + v_src.vat_rate));
  UPDATE orders SET subtotal = v_new_sub, total = v_new_sub, vat_amount = v_vat
  WHERE id = v_new_id;

  RETURN json_build_object(
    'new_order_id', v_new_id,
    'new_total', v_new_sub,
    'daily_number', v_src.daily_number,
    'remaining_total', v_remaining
  );
END $$;

REVOKE EXECUTE ON FUNCTION split_order(UUID, UUID, JSONB) FROM anon, public;

-- ── merge_table_orders (014 + округление) ───────────────────
CREATE OR REPLACE FUNCTION merge_table_orders(p_source_id UUID, p_target_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_source    orders%ROWTYPE;
  v_target    orders%ROWTYPE;
  v_subtotal  INTEGER;
  v_disc      INTEGER;
  v_total     INTEGER;
  v_vat       INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_source_id = p_target_id THEN
    RAISE EXCEPTION 'cannot merge order into itself';
  END IF;

  SELECT * INTO v_source FROM orders WHERE id = p_source_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source order not found';
  END IF;
  SELECT * INTO v_target FROM orders WHERE id = p_target_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target order not found';
  END IF;
  IF v_source.status <> 'open' OR v_target.status <> 'open' THEN
    RAISE EXCEPTION 'both orders must be open';
  END IF;

  UPDATE order_items SET order_id = p_target_id
  WHERE order_id = p_source_id;

  UPDATE orders
  SET status = 'voided', voided_at = NOW(),
      void_reason = 'merged into ' || p_target_id::TEXT,
      subtotal = 0, discount_amount = 0, total = 0, vat_amount = 0
  WHERE id = p_source_id;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = p_target_id AND voided_at IS NULL;

  v_disc := 0;
  IF v_target.discount_type = 'percent' THEN
    v_disc := ROUND(v_subtotal * v_target.discount_value / 100.0);
  ELSIF v_target.discount_type = 'fixed' THEN
    v_disc := v_target.discount_value;
  END IF;
  IF v_disc > v_subtotal THEN
    v_disc := v_subtotal;
  END IF;

  v_total := round_order_total(v_subtotal - v_disc, v_subtotal, v_disc > 0);
  IF v_disc > 0 THEN v_disc := v_subtotal - v_total; END IF;
  v_vat := ROUND(v_total * v_target.vat_rate / (100 + v_target.vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, discount_amount = v_disc, total = v_total, vat_amount = v_vat
  WHERE id = p_target_id;

  RETURN json_build_object('target_id', p_target_id, 'total', v_total);
END $$;

REVOKE EXECUTE ON FUNCTION move_table_order, merge_table_orders FROM anon, public;

-- ── apply_loyalty (031 + округление при скидке ИЛИ вычете лояльности) ──
CREATE OR REPLACE FUNCTION apply_loyalty(
  p_order_id UUID,
  p_guest_id UUID,
  p_redeem   JSONB DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_order    orders%ROWTYPE;
  v_guest    guests%ROWTYPE;
  v_goal     INTEGER;
  v_subtotal INTEGER;
  v_disc     INTEGER := 0;
  v_loy      INTEGER := 0;
  v_redeem   TEXT := NULL;
  v_free     INTEGER;
  v_amount   INTEGER;
  v_total    INTEGER;
  v_vat      INTEGER;
  v_has_cut  BOOLEAN;
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

  IF p_guest_id IS NOT NULL THEN
    SELECT * INTO v_guest FROM guests WHERE id = p_guest_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'guest not found';
    END IF;
  END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;

  IF v_order.discount_type = 'percent' THEN
    v_disc := ROUND(v_subtotal * v_order.discount_value / 100.0);
  ELSIF v_order.discount_type = 'fixed' THEN
    v_disc := v_order.discount_value;
  END IF;
  IF v_disc > v_subtotal THEN v_disc := v_subtotal; END IF;

  IF p_guest_id IS NOT NULL AND p_redeem IS NOT NULL AND (p_redeem ->> 'type') IS NOT NULL THEN
    v_redeem := p_redeem ->> 'type';

    IF v_redeem = 'stamps' THEN
      SELECT loyalty_stamps_goal INTO v_goal FROM locations WHERE id = v_order.location_id;
      IF v_guest.stamps < v_goal THEN
        RAISE EXCEPTION 'insufficient stamps';
      END IF;
      SELECT MIN(oi.unit_price) INTO v_free
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE oi.order_id = p_order_id AND oi.voided_at IS NULL AND mc.loyalty_stamps;
      IF v_free IS NULL THEN
        RAISE EXCEPTION 'no stampable item in order';
      END IF;
      v_loy := LEAST(v_free, v_subtotal - v_disc);

    ELSIF v_redeem = 'points' THEN
      v_amount := NULLIF(p_redeem ->> 'amount', '')::INTEGER;
      IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'invalid redeem amount';
      END IF;
      IF v_amount > v_guest.points THEN
        RAISE EXCEPTION 'insufficient points';
      END IF;
      v_loy := LEAST(v_amount, v_subtotal - v_disc);

    ELSE
      RAISE EXCEPTION 'invalid redeem type';
    END IF;
  END IF;

  -- Округляем итог, если есть ручная скидка ИЛИ вычет лояльности.
  -- «Хвост» до целого шекеля забирает лояльность (не портим ручную
  -- скидку, введённую кассиром явным числом).
  v_has_cut := (v_disc > 0) OR (v_loy > 0);
  v_total := round_order_total(v_subtotal - v_disc - v_loy, v_subtotal - v_disc, v_has_cut);
  IF v_loy > 0 THEN
    v_loy := v_subtotal - v_disc - v_total;
  ELSIF v_disc > 0 THEN
    v_disc := v_subtotal - v_total;
  END IF;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders SET
    guest_id         = p_guest_id,
    loyalty_redeem   = v_redeem,
    loyalty_discount = v_loy,
    subtotal         = v_subtotal,
    discount_amount  = v_disc,
    total            = v_total,
    vat_amount       = v_vat
  WHERE id = p_order_id;

  RETURN json_build_object('total', v_total, 'loyalty_discount', v_loy);
END $$;

REVOKE EXECUTE ON FUNCTION apply_loyalty FROM anon, public;
