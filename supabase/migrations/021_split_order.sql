-- ============================================================
-- 021 SPLIT ORDER — раздельная оплата по позициям (отдельные чеки).
--
-- Гость платит только за свои позиции → они выделяются в НОВЫЙ заказ
-- со своим фискальным номером (receipt_number при оплате) и чеком.
-- Каждый плательщик получает свой документ — корректно для Израиля.
--
-- Правила:
--   * Только open-заказ (до оплаты). Оплаченное не расщепляется.
--   * Частичное qty поддерживается: «1 из 2 капучино» — исходная строка
--     уменьшается, копия с нужным qty уезжает в новый заказ (+модификаторы).
--     Допустимо: open-заказ — ещё черновик, не финансовый документ.
--   * Нельзя перенести ВСЁ (остаток не может быть пустым).
--   * daily_number наследуется: физически это один заказ в очереди
--     бариста (два тикета #42 с разными позициями).
--   * Для стола: новый заказ НЕ привязан к столу (unique «один open на
--     стол» цел; стол продолжает держать остаток счёта).
--   * Скидка остаётся на исходном заказе (пересчитывается от остатка);
--     новый заказ уходит без скидки. Клиент предупреждает.
-- ============================================================

CREATE OR REPLACE FUNCTION split_order(
  p_order_id UUID,
  p_staff_id UUID,
  p_items    JSONB   -- [{ "item_id": UUID, "qty": N }]
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

  -- Новый заказ: наследует мету, daily_number тот же (один физический заказ),
  -- стол не наследует (unique open-per-table)
  INSERT INTO orders (org_id, location_id, staff_id, client_uuid, daily_number,
                      order_type, customer_name, status, vat_rate, shift_id, table_label)
  VALUES (v_org, v_src.location_id, p_staff_id, gen_random_uuid(), v_src.daily_number,
          v_src.order_type, v_src.customer_name, 'open', v_src.vat_rate, v_src.shift_id, v_src.table_label)
  RETURNING id INTO v_new_id;

  -- Перенос позиций
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
      -- Целиком: строка просто переезжает (модификаторы едут по FK)
      UPDATE order_items SET order_id = v_new_id WHERE id = v_row.id;
    ELSE
      -- Частично: уменьшить исходную, скопировать в новый заказ
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

  -- Остаток не может быть пустым
  SELECT COALESCE(SUM(line_total), 0) INTO v_src_sub
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;
  IF v_src_sub = 0 THEN
    RAISE EXCEPTION 'cannot split all items';
  END IF;

  -- Итоги исходного (скидка остаётся тут, пересчёт от остатка)
  v_disc := 0;
  IF v_src.discount_type = 'percent' THEN
    v_disc := ROUND(v_src_sub * v_src.discount_value / 100.0);
  ELSIF v_src.discount_type = 'fixed' THEN
    v_disc := v_src.discount_value;
  END IF;
  IF v_disc > v_src_sub THEN v_disc := v_src_sub; END IF;
  v_total := v_src_sub - v_disc;
  v_vat := ROUND(v_total * v_src.vat_rate / (100 + v_src.vat_rate));
  UPDATE orders SET subtotal = v_src_sub, discount_amount = v_disc, total = v_total, vat_amount = v_vat
  WHERE id = p_order_id;
  v_remaining := v_total;

  -- Итоги нового (без скидки)
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
