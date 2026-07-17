-- ============================================================
-- 079 STOCK TAKE V2 — инвентаризация: расхождение в деньгах.
--
-- Тело stock_take из 077 без изменений логики; RETURN дополняется
-- итогами расхождения по себестоимости:
--
--   * shortage_value — сумма недостач (|value| строк с дельтой < 0);
--   * surplus_value  — сумма излишков (value строк с дельтой > 0).
--
-- Клиент показывает итог сразу после пересчёта — слепой подсчёт
-- (UI не подсказывает ожидаемый остаток) остаётся честным, а деньги
-- видны мгновенно, не через отчёт. Старый клиент лишние поля JSON
-- просто не читает. Сигнатура прежняя, гранты сохраняются.
-- ============================================================

CREATE OR REPLACE FUNCTION stock_take(
  p_staff_id UUID,
  p_items    JSONB,
  p_note     TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org     UUID := auth_org_id();
  v_loc     UUID := auth_location_id();
  v_item    JSONB;
  v_kind    TEXT;
  v_id      UUID;
  v_counted INTEGER;
  v_max     INTEGER;
  v_old     INTEGER;
  v_name    TEXT;
  v_cost    INTEGER;
  v_unit    TEXT;
  v_value   BIGINT;
  v_short   BIGINT := 0;
  v_surp    BIGINT := 0;
  v_count   INTEGER := 0;
  v_batch   UUID := gen_random_uuid();
  v_note    TEXT := NULLIF(TRIM(p_note), '');
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'stock_take');
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'nothing to count';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_kind    := COALESCE(v_item ->> 'kind', 'menu');
    v_counted := (v_item ->> 'counted')::INTEGER;
    IF v_kind = 'supply' THEN
      v_max := 10000000;
    ELSE
      v_max := 99999;
    END IF;
    IF v_counted IS NULL OR v_counted < 0 OR v_counted > v_max THEN
      RAISE EXCEPTION 'invalid counted';
    END IF;

    IF v_kind = 'supply' THEN
      v_id := (v_item ->> 'supply_item_id')::UUID;
      SELECT stock, name, cost, unit INTO v_old, v_name, v_cost, v_unit FROM supply_items
      WHERE id = v_id AND org_id = v_org FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'supply item not found';
      END IF;
      UPDATE supply_items SET stock = v_counted WHERE id = v_id;
      v_value := movement_value(v_counted - COALESCE(v_old, 0), v_cost, v_unit);
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, value, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'count', v_counted - COALESCE(v_old, 0), v_counted,
              v_cost, v_value, v_note, p_staff_id, v_batch);
    ELSE
      v_id := (v_item ->> 'menu_item_id')::UUID;
      SELECT stock, name, cost INTO v_old, v_name, v_cost FROM menu_items
      WHERE id = v_id AND org_id = v_org FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'menu item not found';
      END IF;
      UPDATE menu_items SET stock = v_counted, track_inventory = TRUE WHERE id = v_id;
      v_value := movement_value(v_counted - COALESCE(v_old, 0), v_cost, NULL);
      INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, value, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'count', v_counted - COALESCE(v_old, 0), v_counted,
              v_cost, v_value, v_note, p_staff_id, v_batch);
    END IF;

    IF v_value < 0 THEN
      v_short := v_short - v_value;
    ELSIF v_value > 0 THEN
      v_surp := v_surp + v_value;
    END IF;
    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object(
    'batch_id', v_batch,
    'items', v_count,
    'shortage_value', v_short,
    'surplus_value', v_surp
  );
END $$;

REVOKE EXECUTE ON FUNCTION stock_take FROM anon, public;
