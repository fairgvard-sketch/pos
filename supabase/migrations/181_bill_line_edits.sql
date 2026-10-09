-- ============================================================
-- 181 СЧЁТ СТОЛА: ПРАВКА ОТПРАВЛЕННЫХ ПОЗИЦИЙ
--
-- Концепция «отправить заказ и править в любой момент» (решение
-- владельца 09.10.2026). Отправленную на кухню позицию можно:
--   • убрать целиком или уменьшить количество — только с PIN менеджера
--     или владельца (окно открывает любой сотрудник, PIN вводит менеджер);
--   • перенести на другой стол — без PIN: деньги не теряются.
-- Добавить порцию — обычный дозаказ (append_to_order).
--
-- ФИНАНСОВЫЙ СЛЕД. Ничего не стирается: убранное — отменённая строка
-- (voided_at, voided_by, void_reason) плюс кто из менеджеров подтвердил
-- (void_approved_by). Частичная отмена — по образцу split_order: строка
-- уменьшается, на убранное количество создаётся копия и сразу
-- отменяется. Склад сходится существующими триггерами (047/077):
-- split +n, sale −n, void +n — итог +n, ровно убранное.
--
-- PIN менеджера проверяется на сервере тем же bcrypt и тем же лимитом
-- попыток, что вход (095). Неверный PIN — ok:false без исключения:
-- откат стёр бы след неудачи. Операции идемпотентны по op_uuid (op_log).
--
-- Кухня: экран кухни отменённое скрывает, перенесённое показывает под
-- новым столом сам; бумажные тикеты «ביטול» / «הועבר» печатает касса.
--
-- Обе операции — только онлайн: PIN менеджера проверяет сервер.
-- ============================================================

ALTER TABLE order_items
  ADD COLUMN void_approved_by UUID REFERENCES staff(id) ON DELETE SET NULL;

COMMENT ON COLUMN order_items.void_approved_by IS
  'Менеджер или владелец, подтвердивший PIN отмену отправленной позиции (181)';

-- ── Пересчёт итогов открытого заказа ────────────────────────
-- Как в append_to_order/void_order_item: скидка, округление, НДС.
CREATE FUNCTION _recalc_open_order(p_order_id UUID)
RETURNS orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order    orders%ROWTYPE;
  v_subtotal INTEGER;
  v_disc     INTEGER := 0;
  v_total    INTEGER;
  v_vat      INTEGER;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;

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
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  RETURN v_order;
END $$;

REVOKE ALL ON FUNCTION _recalc_open_order(UUID) FROM PUBLIC, anon, authenticated;

-- Строки кухонного тикета по id (имена, модификаторы, заметки)
CREATE FUNCTION _bill_ticket_lines(p_ids UUID[])
RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'qty',         i.qty,
      'name',        i.name,
      'variantName', i.variant_name,
      'modifiers',   COALESCE((SELECT jsonb_agg(m.name ORDER BY m.name)
                               FROM order_item_modifiers m
                               WHERE m.order_item_id = i.id), '[]'::JSONB),
      'notes',       COALESCE(i.notes, ''),
      'held',        i.held
    ) ORDER BY x.ord), '[]'::JSONB)
  FROM unnest(p_ids) WITH ORDINALITY AS x(id, ord)
  JOIN order_items i ON i.id = x.id
$$;

REVOKE ALL ON FUNCTION _bill_ticket_lines(UUID[]) FROM PUBLIC, anon, authenticated;

-- ── Убрать отправленную позицию (целиком или часть) ─────────
-- p_qty NULL — вся строка. Возвращает ok:false при неверном PIN.
CREATE FUNCTION void_bill_line(
  p_item_id       UUID,
  p_qty           INTEGER,
  p_reason        TEXT,
  p_manager_pin   TEXT,
  p_staff_session UUID,
  p_op_uuid       UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org     UUID := auth_org_id();
  v_loc     UUID := auth_location_id();
  v_staff   UUID;
  v_manager staff%ROWTYPE;
  v_prev    JSONB;
  v_line    order_items%ROWTYPE;
  v_order   orders%ROWTYPE;
  v_qty     INTEGER;
  v_void_id UUID;
  v_reason  TEXT := NULLIF(LEFT(btrim(COALESCE(p_reason, '')), 200), '');
  v_result  JSONB;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_org_capability('pos_operate');
  IF p_staff_session IS NULL THEN
    RAISE EXCEPTION 'staff session required';
  END IF;
  v_staff := require_staff_session(p_staff_session);
  IF p_op_uuid IS NULL THEN
    RAISE EXCEPTION 'op_uuid required';
  END IF;

  -- Повтор после таймаута: отмена уже проведена
  SELECT result INTO v_prev FROM op_log WHERE op_uuid = p_op_uuid AND org_id = v_org;
  IF FOUND THEN
    RETURN v_prev::JSON;
  END IF;

  -- PIN менеджера: блокировка проверяется до сверки хеша (как в 095)
  PERFORM pin_throttle_check();
  SELECT s.* INTO v_manager
  FROM staff s
  WHERE s.org_id = v_org
    AND s.is_active
    AND s.role IN ('owner', 'manager')
    AND (s.location_id IS NULL OR s.location_id = v_loc)
    AND p_manager_pin ~ '^[0-9]{4,8}$'
    AND s.pin_hash = crypt(p_manager_pin, s.pin_hash)
  LIMIT 1;
  IF NOT FOUND THEN
    PERFORM pin_throttle_fail();
    RETURN json_build_object('ok', FALSE, 'error', 'manager_pin_invalid');
  END IF;
  PERFORM pin_throttle_reset();

  SELECT * INTO v_line FROM order_items
  WHERE id = p_item_id AND org_id = v_org AND voided_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  SELECT * INTO v_order FROM orders
  WHERE id = v_line.order_id AND location_id = v_loc
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  v_qty := COALESCE(p_qty, v_line.qty);
  IF v_qty < 1 OR v_qty > v_line.qty THEN
    RAISE EXCEPTION 'invalid qty';
  END IF;

  IF v_qty = v_line.qty THEN
    UPDATE order_items
    SET voided_at = NOW(), voided_by = v_staff, void_reason = v_reason,
        void_approved_by = v_manager.id
    WHERE id = v_line.id;
    v_void_id := v_line.id;
  ELSE
    -- Часть: строка уменьшается, убранное — отдельная отменённая копия
    UPDATE order_items
    SET qty = qty - v_qty, line_total = unit_price * (qty - v_qty)
    WHERE id = v_line.id;

    INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                             name, variant_name, unit_price, qty, line_total, notes,
                             is_price_overridden, prep_status, ready_at,
                             course, held, fired_at, fired_by)
    VALUES (v_org, v_order.id, v_line.menu_item_id, v_line.variant_id, v_line.station_id,
            v_line.name, v_line.variant_name, v_line.unit_price, v_qty,
            v_line.unit_price * v_qty, v_line.notes,
            v_line.is_price_overridden, v_line.prep_status, v_line.ready_at,
            v_line.course, v_line.held, v_line.fired_at, v_line.fired_by)
    RETURNING id INTO v_void_id;

    INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta)
    SELECT org_id, v_void_id, modifier_id, name, price_delta
    FROM order_item_modifiers WHERE order_item_id = v_line.id;

    UPDATE order_items
    SET voided_at = NOW(), voided_by = v_staff, void_reason = v_reason,
        void_approved_by = v_manager.id
    WHERE id = v_void_id;
  END IF;

  v_order := _recalc_open_order(v_order.id);

  v_result := jsonb_build_object(
    'ok',           TRUE,
    'order_id',     v_order.id,
    'total',        v_order.total,
    'subtotal',     v_order.subtotal,
    'voided_id',    v_void_id,
    'approved_by',  v_manager.name,
    'table_label',  v_order.table_label,
    -- Придержанное кухня ещё не видела — тикет отмены ей не нужен
    'ticket_lines', _bill_ticket_lines(ARRAY[v_void_id])
  );

  INSERT INTO op_log (op_uuid, org_id, fn, result)
  VALUES (p_op_uuid, v_org, 'void_bill_line', v_result);

  RETURN v_result::JSON;
END $$;

REVOKE ALL ON FUNCTION void_bill_line(UUID, INTEGER, TEXT, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION void_bill_line(UUID, INTEGER, TEXT, TEXT, UUID, UUID) TO authenticated;

COMMENT ON FUNCTION void_bill_line(UUID, INTEGER, TEXT, TEXT, UUID, UUID) IS
  'Убрать отправленную позицию счёта стола целиком или частично по PIN менеджера (181)';

-- ── Перенести позиции на другой стол ────────────────────────
-- Целые строки; свободный стол получает новый счёт, занятый — дозаказ.
-- Опустевший счёт-источник закрывается как при объединении (014).
CREATE FUNCTION move_bill_lines(
  p_item_ids      UUID[],
  p_to_table_id   UUID,
  p_staff_session UUID,
  p_op_uuid       UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org     UUID := auth_org_id();
  v_loc     UUID := auth_location_id();
  v_staff   UUID;
  v_prev    JSONB;
  v_want    INTEGER;
  v_source  orders%ROWTYPE;
  v_target  orders%ROWTYPE;
  v_label   TEXT;
  v_open    JSON;
  v_moved   INTEGER;
  v_empty   BOOLEAN;
  v_result  JSONB;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_org_capability('pos_operate');
  IF p_staff_session IS NULL THEN
    RAISE EXCEPTION 'staff session required';
  END IF;
  v_staff := require_staff_session(p_staff_session);
  IF p_op_uuid IS NULL THEN
    RAISE EXCEPTION 'op_uuid required';
  END IF;

  SELECT result INTO v_prev FROM op_log WHERE op_uuid = p_op_uuid AND org_id = v_org;
  IF FOUND THEN
    RETURN v_prev::JSON;
  END IF;

  SELECT COUNT(DISTINCT x) INTO v_want FROM unnest(p_item_ids) x;
  IF COALESCE(v_want, 0) = 0 THEN
    RAISE EXCEPTION 'nothing to move';
  END IF;
  IF v_want > 100 THEN
    RAISE EXCEPTION 'too many items';
  END IF;

  -- Источник: счёт стола этой точки, в котором все переносимые строки
  SELECT o.* INTO v_source FROM orders o
  WHERE o.id = (SELECT i.order_id FROM order_items i
                WHERE i.id = p_item_ids[1] AND i.org_id = v_org)
    AND o.location_id = v_loc AND o.table_id IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_source.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;
  IF v_source.table_id = p_to_table_id THEN
    RAISE EXCEPTION 'same table';
  END IF;

  SELECT label INTO v_label FROM tables
  WHERE id = p_to_table_id AND location_id = v_loc AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table not found';
  END IF;

  -- Приёмник: открытый счёт стола или новый (та же функция, что у кассы)
  v_open := open_or_get_table_order_impl(p_to_table_id, v_staff, NULL, NULL);
  SELECT * INTO v_target FROM orders WHERE id = (v_open ->> 'order_id')::UUID FOR UPDATE;

  UPDATE order_items SET order_id = v_target.id
  WHERE id = ANY(p_item_ids) AND order_id = v_source.id AND voided_at IS NULL;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved <> v_want THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  v_empty := NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_source.id AND voided_at IS NULL
  );
  IF v_empty THEN
    -- Как при объединении: всё уехало до закрытия, складу возвращать нечего
    UPDATE orders
    SET status = 'voided', voided_at = NOW(),
        void_reason = 'moved to table ' || v_label,
        subtotal = 0, discount_amount = 0, total = 0, vat_amount = 0
    WHERE id = v_source.id
    RETURNING * INTO v_source;
  ELSE
    v_source := _recalc_open_order(v_source.id);
  END IF;
  v_target := _recalc_open_order(v_target.id);

  v_result := jsonb_build_object(
    'ok',              TRUE,
    'source_order_id', v_source.id,
    'source_total',    v_source.total,
    'source_empty',    v_empty,
    'target_order_id', v_target.id,
    'target_total',    v_target.total,
    'from_label',      v_source.table_label,
    'to_label',        v_label,
    'ticket_lines',    _bill_ticket_lines(p_item_ids)
  );

  INSERT INTO op_log (op_uuid, org_id, fn, result)
  VALUES (p_op_uuid, v_org, 'move_bill_lines', v_result);

  RETURN v_result::JSON;
END $$;

REVOKE ALL ON FUNCTION move_bill_lines(UUID[], UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION move_bill_lines(UUID[], UUID, UUID, UUID) TO authenticated;

COMMENT ON FUNCTION move_bill_lines(UUID[], UUID, UUID, UUID) IS
  'Перенести позиции открытого счёта на другой стол без потери денег (181)';
