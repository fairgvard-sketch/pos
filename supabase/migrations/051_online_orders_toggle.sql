-- ============================================================
-- 051 — Тумблер онлайн-заказов per-location (self-service).
--
-- Настройки → Обслуживание → «Онлайн-заказы»: владелец сам включает/
-- выключает приём заявок с сайта. Флаг живёт в locations.settings
-- (jsonb, паттерн 036): { "online_orders": { "enabled": false } }.
-- Отсутствие ключа = ВКЛЮЧЕНО (фича уже в бою у Bulochka).
--
-- Enforcement на сервере: submit_online_order отклоняет заявку кодом
-- 'disabled' (гость видит «онлайн-заказы недоступны», а не «закрыто»).
-- Витрина public-menu отдаёт accepting — страница гостя прячет
-- оформление заранее. Тело функции — копия 050 + одна проверка.
-- ============================================================

CREATE OR REPLACE FUNCTION submit_online_order(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_items       JSONB,
  p_pickup_at   TIMESTAMPTZ DEFAULT NULL,
  p_note        TEXT        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc       locations%ROWTYPE;
  v_existing  online_orders%ROWTYPE;
  v_name      TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone     TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note      TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_pickup    TIMESTAMPTZ := p_pickup_at;
  v_item      JSONB;
  v_mods      JSONB;
  v_mod_ids   UUID[];
  v_mod_id    UUID;
  v_mi        menu_items%ROWTYPE;
  v_cat_ok    BOOLEAN;
  v_variant   item_variants%ROWTYPE;
  v_mod       modifiers%ROWTYPE;
  v_qty       INTEGER;
  v_unit      INTEGER;
  v_line      INTEGER;
  v_subtotal  INTEGER := 0;
  v_out_items JSONB := '[]'::jsonb;
  v_id        UUID;
BEGIN
  -- Идемпотентность: повтор POST с тем же client_uuid → та же заявка
  SELECT * INTO v_existing FROM online_orders WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('online_id', v_existing.id, 'total', v_existing.total, 'duplicate', TRUE);
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE client_uuid = p_client_uuid) THEN
    RAISE EXCEPTION 'invalid_client_uuid';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  -- Тумблер (051): владелец выключил приём онлайн-заказов
  IF NOT COALESCE((v_loc.settings -> 'online_orders' ->> 'enabled')::BOOLEAN, TRUE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;

  -- Кофейня «открыта» = на точке открыта смена
  IF NOT EXISTS (SELECT 1 FROM shifts WHERE location_id = p_location_id AND status = 'open') THEN
    RAISE EXCEPTION 'closed';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;

  IF v_pickup IS NOT NULL AND v_pickup <= NOW() THEN
    v_pickup := NULL;
  END IF;
  IF v_pickup IS NOT NULL AND v_pickup > NOW() + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'invalid_pickup';
  END IF;

  IF (SELECT COUNT(*) FROM online_orders
      WHERE customer_phone = v_phone AND created_at > NOW() - INTERVAL '15 minutes') >= 3 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT COUNT(*) FROM online_orders
      WHERE location_id = p_location_id AND status = 'new') >= 30 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 30 THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 99 THEN
      RAISE EXCEPTION 'invalid_items';
    END IF;

    SELECT mi.* INTO v_mi FROM menu_items mi
      WHERE mi.id = (v_item ->> 'menu_item_id')::UUID AND mi.org_id = v_loc.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_items';
    END IF;
    SELECT (mc.is_active AND mc.location_id = p_location_id) INTO v_cat_ok
      FROM menu_categories mc WHERE mc.id = v_mi.category_id;
    IF NOT v_mi.is_available OR NOT COALESCE(v_cat_ok, FALSE) THEN
      RAISE EXCEPTION 'item_unavailable: %', v_mi.name;
    END IF;

    v_variant := NULL;
    IF v_item ->> 'variant_id' IS NOT NULL THEN
      SELECT * INTO v_variant FROM item_variants
        WHERE id = (v_item ->> 'variant_id')::UUID AND item_id = v_mi.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid_items';
      END IF;
      v_unit := v_variant.price;
    ELSE
      v_unit := v_mi.price;
    END IF;

    v_mods := '[]'::jsonb;
    v_mod_ids := '{}';
    IF v_item ? 'modifier_ids' THEN
      SELECT COALESCE(array_agg(DISTINCT x::UUID), '{}')
        INTO v_mod_ids
        FROM jsonb_array_elements_text(v_item -> 'modifier_ids') x;
      IF array_length(v_mod_ids, 1) > 10 THEN
        RAISE EXCEPTION 'invalid_items';
      END IF;
      FOREACH v_mod_id IN ARRAY v_mod_ids LOOP
        SELECT m.* INTO v_mod FROM modifiers m
          JOIN menu_item_modifier_groups mimg
            ON mimg.group_id = m.group_id AND mimg.item_id = v_mi.id
          WHERE m.id = v_mod_id AND m.org_id = v_loc.org_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'invalid_items';
        END IF;
        IF NOT v_mod.is_available THEN
          RAISE EXCEPTION 'item_unavailable: %', v_mod.name;
        END IF;
        v_unit := v_unit + v_mod.price_delta;
        v_mods := v_mods || jsonb_build_object('id', v_mod.id, 'name', v_mod.name, 'price_delta', v_mod.price_delta);
      END LOOP;
    END IF;

    v_line := v_unit * v_qty;
    v_subtotal := v_subtotal + v_line;

    v_out_items := v_out_items || jsonb_build_object(
      'menu_item_id', v_mi.id,
      'variant_id',   v_variant.id,
      'modifier_ids', to_jsonb(v_mod_ids),
      'qty',          v_qty,
      'notes',        NULLIF(LEFT(TRIM(COALESCE(v_item ->> 'notes', '')), 120), ''),
      'name',         v_mi.name,
      'variant_name', v_variant.name,
      'unit_price',   v_unit,
      'line_total',   v_line,
      'mods',         v_mods
    );
  END LOOP;

  INSERT INTO online_orders (org_id, location_id, client_uuid, customer_name, customer_phone,
                             pickup_at, note, items, subtotal, total)
  VALUES (v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
          v_pickup, v_note, v_out_items, v_subtotal, v_subtotal)
  RETURNING id INTO v_id;

  RETURN json_build_object('online_id', v_id, 'total', v_subtotal, 'duplicate', FALSE);
END $$;

REVOKE ALL ON FUNCTION submit_online_order FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_online_order TO service_role;
