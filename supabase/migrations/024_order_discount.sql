-- ============================================================
-- 024 ORDER DISCOUNT — скидка на СУЩЕСТВУЮЩИЙ открытый счёт.
--
-- Скидка из корзины применялась только при создании заказа
-- (place_order). Счёт стола — уже существующий open-заказ: ставим/
-- снимаем скидку на нём напрямую, итоги пересчитываются из активных
-- позиций (та же формула, что append_to_order/void_order_item).
-- Последующий дозаказ сохранит скидку: append пересчитает её от
-- нового подытога (тип/значение хранятся на заказе).
-- ============================================================

CREATE OR REPLACE FUNCTION set_order_discount(
  p_order_id UUID,
  p_type     TEXT,              -- 'percent' | 'fixed' | NULL = снять скидку
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
    RAISE EXCEPTION 'order not open';  -- оплаченное не трогаем (аудит)
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

  v_total := v_subtotal - v_disc;
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
