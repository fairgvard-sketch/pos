-- ============================================================
-- 014 TABLE ACTIONS — операции над открытым счётом стола:
--   * move_table_order  — перенести счёт на другой (свободный) стол
--   * merge_table_orders — слить счёт-источник в счёт-приёмник
--
-- Инварианты (013):
--   * Один open-заказ на стол (частичный уникальный индекс).
--     → Перенос возможен только на свободный стол.
--     → Объединение: source void, все позиции переезжают в target,
--       итоги target пересчитываются из позиций (снапшот).
--   * Финансовый аудит цел: объединение не удаляет order_items,
--     а переносит их (order_id := target); source становится voided
--     и пустым (его позиции уже переехали).
-- ============================================================

-- ============================================================
-- RPC: move_table_order — сменить стол у открытого счёта.
-- Целевой стол должен существовать, быть нашим и СВОБОДНЫМ
-- (нет своего open-заказа) — иначе нарушится уникальный индекс.
-- ============================================================
CREATE OR REPLACE FUNCTION move_table_order(p_order_id UUID, p_to_table_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_order    orders%ROWTYPE;
  v_label    TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  -- Целевой стол существует и наш
  SELECT label INTO v_label FROM tables
  WHERE id = p_to_table_id AND org_id = v_org AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target table not found';
  END IF;

  -- Тот же стол — нечего делать
  IF v_order.table_id = p_to_table_id THEN
    RETURN json_build_object('order_id', p_order_id, 'table_id', p_to_table_id, 'moved', FALSE);
  END IF;

  -- Целевой стол должен быть свободен
  IF EXISTS (SELECT 1 FROM orders WHERE table_id = p_to_table_id AND status = 'open') THEN
    RAISE EXCEPTION 'target table busy';
  END IF;

  UPDATE orders
  SET table_id = p_to_table_id, table_label = v_label
  WHERE id = p_order_id;

  RETURN json_build_object('order_id', p_order_id, 'table_id', p_to_table_id, 'moved', TRUE);
END $$;

-- ============================================================
-- RPC: merge_table_orders — слить два открытых счёта в один.
-- Позиции source переезжают в target (order_id := target), модификаторы
-- едут вместе с ними. Скидка target сохраняется и пересчитывается
-- от нового подытога. Source становится voided (пустой, аудит-ссылка).
--
-- Ограничение: скидку source молча теряем (у объединённого счёта одна
-- скидка — на target). Если у source была скидка, она снимается —
-- клиент предупреждает пользователя.
-- ============================================================
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

  -- Позиции переезжают в target (не копия — перенос: аудит целого
  -- order_item сохраняется, меняется только order_id). Их модификаторы
  -- привязаны к order_item через FK, поэтому едут вместе с ними.
  UPDATE order_items SET order_id = p_target_id
  WHERE order_id = p_source_id;

  -- Source: void, помечаем причину для аудита
  UPDATE orders
  SET status = 'voided', voided_at = NOW(),
      void_reason = 'merged into ' || p_target_id::TEXT,
      subtotal = 0, discount_amount = 0, total = 0, vat_amount = 0
  WHERE id = p_source_id;

  -- Пересчёт снапшот-итогов target из его (теперь общих) активных позиций
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

  v_total := v_subtotal - v_disc;
  v_vat := ROUND(v_total * v_target.vat_rate / (100 + v_target.vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, discount_amount = v_disc, total = v_total, vat_amount = v_vat
  WHERE id = p_target_id;

  RETURN json_build_object('target_id', p_target_id, 'total', v_total);
END $$;

REVOKE EXECUTE ON FUNCTION move_table_order, merge_table_orders FROM anon, public;
