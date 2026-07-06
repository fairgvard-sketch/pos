-- ============================================================
-- 009 — place_order привязывает заказ к открытой смене.
-- Продажа возможна только при открытой смене (иначе выручку
-- некуда свести). Пересоздаём функцию целиком.
-- ============================================================
CREATE OR REPLACE FUNCTION place_order(
  p_client_uuid   UUID,
  p_staff_id      UUID,
  p_order_type    TEXT,
  p_customer_name TEXT,
  p_items         JSONB
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
  v_qty       INTEGER;
  v_line      INTEGER;
  v_subtotal  INTEGER := 0;
  v_total     INTEGER;
  v_vat       INTEGER;
  v_oi_id     UUID;
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

  -- Продажа только при открытой смене
  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  SELECT vat_rate INTO v_vat_rate FROM locations WHERE id = v_loc;

  INSERT INTO order_counters (location_id, day, counter)
  VALUES (v_loc, (NOW() AT TIME ZONE (SELECT timezone FROM locations WHERE id = v_loc))::date, 1)
  ON CONFLICT (location_id, day)
  DO UPDATE SET counter = order_counters.counter + 1
  RETURNING counter INTO v_number;

  INSERT INTO orders (org_id, location_id, staff_id, client_uuid, daily_number,
                      order_type, customer_name, status, vat_rate, shift_id)
  VALUES (v_org, v_loc, p_staff_id, p_client_uuid, v_number,
          p_order_type, NULLIF(TRIM(p_customer_name), ''), 'open', v_vat_rate, v_shift)
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_menu_item FROM menu_items
      WHERE id = (v_item ->> 'menu_item_id')::UUID AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'menu item not found: %', v_item ->> 'menu_item_id';
    END IF;

    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'invalid qty';
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

    v_line := v_unit * v_qty;
    v_subtotal := v_subtotal + v_line;

    INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                             name, variant_name, unit_price, qty, line_total, notes)
    VALUES (v_org, v_order_id, v_menu_item.id, v_variant.id, v_menu_item.station_id,
            v_menu_item.name, v_variant.name, v_unit, v_qty, v_line,
            NULLIF(TRIM(v_item ->> 'notes'), ''))
    RETURNING id INTO v_oi_id;

    IF v_item ? 'modifier_ids' THEN
      INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta)
      SELECT v_org, v_oi_id, m.id, m.name, m.price_delta
      FROM modifiers m
      WHERE m.id IN (SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID);
    END IF;
  END LOOP;

  v_total := v_subtotal;
  v_vat := ROUND(v_total * v_vat_rate / (100 + v_vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, total = v_total, vat_amount = v_vat
  WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'daily_number', v_number, 'total', v_total, 'duplicate', FALSE);
END $$;
