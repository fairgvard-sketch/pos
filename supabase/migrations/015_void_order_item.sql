-- ============================================================
-- 015 VOID ORDER ITEM — снять позицию с ОТКРЫТОГО счёта (мягко).
--
-- Позиция в open-заказе — ещё не финансовая запись (оплаты не было,
-- чек не пробит). Снятие законно, но делаем его АУДИРУЕМЫМ:
-- строка не удаляется, а помечается voided (кто/когда/почему) и
-- перестаёт участвовать в итогах и в очереди готовки.
--
-- Инварианты:
--   * Void только для позиций open-заказа. Оплаченный/отменённый
--     счёт не трогаем (там возврат — отдельная операция после MVP).
--   * Итоги заказа пересчитываются из НЕ-voided позиций (снапшот),
--     скидка/НДС по той же формуле, что append_to_order (013).
--   * order_item_modifiers остаются (аудит целой позиции цел).
-- ============================================================

-- Идемпотентно: миграцию могли применять частично
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by   UUID REFERENCES staff(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- Активные (не снятые) позиции — частичный индекс для выборок очереди/итогов
CREATE INDEX IF NOT EXISTS idx_order_items_active ON order_items(order_id) WHERE voided_at IS NULL;

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

  -- Позиция наша и ещё активна
  SELECT order_id INTO v_order_id FROM order_items
  WHERE id = p_item_id AND org_id = v_org AND voided_at IS NULL;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'item not found or already voided';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = v_order_id AND org_id = v_org FOR UPDATE;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';  -- снять позицию можно только с открытого счёта
  END IF;

  -- Мягкий void: строка остаётся, но помечена
  UPDATE order_items
  SET voided_at = NOW(), voided_by = p_staff_id, void_reason = NULLIF(TRIM(p_reason), '')
  WHERE id = p_item_id;

  -- Пересчёт снапшот-итогов заказа по АКТИВНЫМ позициям
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

  v_total := v_subtotal - v_disc;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, discount_amount = v_disc, total = v_total, vat_amount = v_vat
  WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'total', v_total, 'subtotal', v_subtotal);
END $$;

REVOKE EXECUTE ON FUNCTION void_order_item FROM anon, public;

-- ============================================================
-- Согласование существующих RPC с void: пересчёты итогов и очередь
-- должны игнорировать снятые (voided) позиции.
-- ============================================================

-- append_to_order (013): пересчёт итогов только по активным позициям.
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

  -- Пересчёт снапшот-итогов ВСЕГО заказа из его АКТИВНЫХ позиций
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

  v_total := v_subtotal - v_disc_amount;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, discount_amount = v_disc_amount,
      total = v_total, vat_amount = v_vat
  WHERE id = p_order_id;

  RETURN json_build_object('order_id', p_order_id, 'total', v_total, 'subtotal', v_subtotal);
END $$;

-- mark_item_ready (010): «все позиции готовы» считаем среди АКТИВНЫХ.
CREATE OR REPLACE FUNCTION mark_item_ready(p_item_id UUID, p_ready BOOLEAN DEFAULT TRUE)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_order_id UUID;
  v_pending  INTEGER;
  v_status   TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE order_items
  SET prep_status = CASE WHEN p_ready THEN 'ready' ELSE 'pending' END,
      ready_at    = CASE WHEN p_ready THEN NOW() ELSE NULL END
  WHERE id = p_item_id AND org_id = v_org AND voided_at IS NULL
  RETURNING order_id INTO v_order_id;

  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  SELECT COUNT(*) INTO v_pending
  FROM order_items
  WHERE order_id = v_order_id AND prep_status = 'pending' AND voided_at IS NULL;

  IF v_pending = 0 THEN
    UPDATE orders SET status = 'fulfilled', fulfilled_at = NOW()
    WHERE id = v_order_id AND status = 'paid'
    RETURNING status INTO v_status;
  ELSE
    UPDATE orders SET status = 'paid', fulfilled_at = NULL
    WHERE id = v_order_id AND status = 'fulfilled'
    RETURNING status INTO v_status;
  END IF;

  IF v_status IS NULL THEN
    SELECT status INTO v_status FROM orders WHERE id = v_order_id;
  END IF;

  RETURN json_build_object('order_id', v_order_id, 'order_status', v_status, 'pending_items', v_pending);
END $$;

-- mark_order_ready (010): готовим только активные позиции.
CREATE OR REPLACE FUNCTION mark_order_ready(p_order_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE order_items
  SET prep_status = 'ready', ready_at = NOW()
  WHERE order_id = p_order_id AND org_id = v_org AND prep_status = 'pending' AND voided_at IS NULL;

  UPDATE orders SET status = 'fulfilled', fulfilled_at = NOW()
  WHERE id = p_order_id AND org_id = v_org AND status = 'paid';

  RETURN json_build_object('order_id', p_order_id, 'order_status', 'fulfilled');
END $$;

REVOKE EXECUTE ON FUNCTION append_to_order, mark_item_ready, mark_order_ready FROM anon, public;
