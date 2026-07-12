-- ============================================================
-- 055 ONLINE ORDER TYPE — гость выбирает тип заказа (здесь / с
-- собой / доставка), владелец включает варианты в настройках.
--
-- Модель:
--   * online_orders.order_type — что выбрал гость. Значения те же,
--     что у orders.order_type (here/takeaway/delivery, 043).
--     Доставка несёт адрес (delivery_address).
--   * Какие типы предлагать гостю — в locations.settings jsonb:
--     online_orders.order_types = ['here','takeaway','delivery'].
--     Отсутствие ключа = ['here','takeaway'] (дефолт для точек,
--     где владелец ещё не настраивал; см. submit ниже).
--   * submit_online_order валидирует выбранный тип по этому списку
--     (нельзя прислать выключенный тип) и требует адрес у доставки.
--   * accept_online_order передаёт сохранённый тип в place_order
--     (раньше был хардкод 'takeaway'). Адрес доставки копируется на
--     настоящий заказ (orders.delivery_address) — его видит касса.
-- ============================================================

-- ── Стейджинг: тип заказа и адрес доставки ───────────────────
ALTER TABLE online_orders
  ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'takeaway'
    CHECK (order_type IN ('here', 'takeaway', 'delivery'));
ALTER TABLE online_orders
  ADD COLUMN IF NOT EXISTS delivery_address TEXT;

-- ── Настоящий заказ: адрес доставки (для сайта, source='site') ─
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_address TEXT;

-- ============================================================
-- submit_online_order (пересоздание): +p_order_type, +p_delivery_address.
-- Тип валидируется по locations.settings.online_orders.order_types;
-- отсутствие ключа = ['here','takeaway']. Доставка требует адрес.
-- ============================================================
CREATE OR REPLACE FUNCTION submit_online_order(
  p_location_id      UUID,
  p_client_uuid      UUID,
  p_name             TEXT,
  p_phone            TEXT,
  p_items            JSONB,
  p_pickup_at        TIMESTAMPTZ DEFAULT NULL,
  p_note             TEXT        DEFAULT NULL,
  p_order_type       TEXT        DEFAULT 'takeaway',
  p_delivery_address TEXT        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc       locations%ROWTYPE;
  v_existing  online_orders%ROWTYPE;
  v_name      TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone     TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note      TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_pickup    TIMESTAMPTZ := p_pickup_at;
  v_type      TEXT := COALESCE(NULLIF(TRIM(p_order_type), ''), 'takeaway');
  v_addr      TEXT := NULLIF(LEFT(TRIM(COALESCE(p_delivery_address, '')), 200), '');
  v_types     TEXT[];
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

  IF NOT EXISTS (SELECT 1 FROM shifts WHERE location_id = p_location_id AND status = 'open') THEN
    RAISE EXCEPTION 'closed';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;

  -- Тип заказа: должен быть в списке, включённом владельцем.
  -- Ключ отсутствует ИЛИ пустой список → дефолт ['here','takeaway'].
  -- (ARRAY(SELECT ...) по отсутствующему ключу даёт '{}', не NULL —
  --  поэтому проверяем длину, а не COALESCE.)
  v_types := ARRAY(
    SELECT jsonb_array_elements_text(v_loc.settings -> 'online_orders' -> 'order_types')
  );
  IF v_types IS NULL OR array_length(v_types, 1) IS NULL THEN
    v_types := ARRAY['here', 'takeaway'];
  END IF;
  IF v_type NOT IN ('here', 'takeaway', 'delivery') OR NOT (v_type = ANY (v_types)) THEN
    RAISE EXCEPTION 'invalid_order_type';
  END IF;
  IF v_type = 'delivery' AND v_addr IS NULL THEN
    RAISE EXCEPTION 'invalid_address';
  END IF;
  -- Адрес имеет смысл только для доставки
  IF v_type <> 'delivery' THEN
    v_addr := NULL;
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
                             pickup_at, note, items, subtotal, total, order_type, delivery_address)
  VALUES (v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
          v_pickup, v_note, v_out_items, v_subtotal, v_subtotal, v_type, v_addr)
  RETURNING id INTO v_id;

  RETURN json_build_object('online_id', v_id, 'total', v_subtotal, 'duplicate', FALSE);
END $$;

REVOKE ALL ON FUNCTION submit_online_order FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_online_order TO service_role;

-- Прежняя 7-аргументная сигнатура (до p_order_type) остаётся в pg_proc
-- перегрузкой — снимаем, чтобы Edge Function однозначно резолвил новую.
DROP FUNCTION IF EXISTS submit_online_order(UUID, UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT);

-- ============================================================
-- accept_online_order (пересоздание): тип заказа берётся из заявки,
-- не хардкод. Адрес доставки копируется на настоящий заказ.
-- ============================================================
CREATE OR REPLACE FUNCTION accept_online_order(
  p_online_id UUID,
  p_staff_id  UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_oo       online_orders%ROWTYPE;
  v_items    JSONB;
  v_res      JSON;
  v_order_id UUID;
  v_o        orders%ROWTYPE;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_oo FROM online_orders
    WHERE id = p_online_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'online order not found';
  END IF;
  IF v_oo.status = 'accepted' THEN
    SELECT * INTO v_o FROM orders WHERE id = v_oo.order_id;
    RETURN json_build_object('order_id', v_o.id, 'daily_number', v_o.daily_number, 'total', v_o.total, 'duplicate', TRUE);
  END IF;
  IF v_oo.status <> 'new' THEN
    RAISE EXCEPTION 'already decided';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'menu_item_id', e -> 'menu_item_id',
    'variant_id',   e -> 'variant_id',
    'modifier_ids', COALESCE(e -> 'modifier_ids', '[]'::jsonb),
    'qty',          e -> 'qty',
    'notes',        e -> 'notes'
  )) INTO v_items
  FROM jsonb_array_elements(v_oo.items) e;

  v_res := place_order(
    p_client_uuid   := v_oo.client_uuid,
    p_staff_id      := p_staff_id,
    p_order_type    := v_oo.order_type,
    p_customer_name := v_oo.customer_name,
    p_items         := v_items
  );
  IF (v_res ->> 'duplicate')::BOOLEAN THEN
    RAISE EXCEPTION 'client uuid conflict';
  END IF;
  v_order_id := (v_res ->> 'order_id')::UUID;

  UPDATE orders
  SET source = 'site',
      customer_phone = v_oo.customer_phone,
      pickup_at = v_oo.pickup_at,
      delivery_address = v_oo.delivery_address
  WHERE id = v_order_id;

  UPDATE online_orders
  SET status = 'accepted', order_id = v_order_id, decided_by = p_staff_id, decided_at = NOW()
  WHERE id = p_online_id;

  RETURN json_build_object(
    'order_id', v_order_id,
    'daily_number', (v_res ->> 'daily_number')::INTEGER,
    'total', (v_res ->> 'total')::INTEGER,
    'duplicate', FALSE
  );
END $$;

REVOKE EXECUTE ON FUNCTION accept_online_order FROM anon, public;

-- ============================================================
-- get_online_order_status (пересоздание): отдаём тип заказа гостю
-- (страница может подтвердить «доставка на …»).
-- ============================================================
CREATE OR REPLACE FUNCTION get_online_order_status(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_oo online_orders%ROWTYPE;
  v_o  orders%ROWTYPE;
BEGIN
  SELECT * INTO v_oo FROM online_orders WHERE client_uuid = p_client_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_oo.order_id IS NOT NULL THEN
    SELECT * INTO v_o FROM orders WHERE id = v_oo.order_id;
  END IF;
  RETURN json_build_object(
    'status',        v_oo.status,
    'reject_reason', v_oo.reject_reason,
    'total',         COALESCE(v_o.total, v_oo.total),
    'daily_number',  v_o.daily_number,
    'order_status',  v_o.status,
    'order_type',    v_oo.order_type,
    'created_at',    v_oo.created_at
  );
END $$;

REVOKE ALL ON FUNCTION get_online_order_status FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_online_order_status TO service_role;
