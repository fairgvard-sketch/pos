-- ============================================================
-- 099 QR TABLE ORDERING — единый публичный заказ для QR стола,
-- QR стойки и обычной ссылки.
--
-- Безопасность:
--   * в QR никогда не попадает внутренний table_id — только отдельный
--     непрозрачный public_token;
--   * location_id, активность и статус стола проверяются на сервере;
--   * цены и доступность позиций по-прежнему считает БД;
--   * за столом контакт гостя не обязателен, антиспам идёт по столу.
--
-- Принятие:
--   * без стола → прежний counter-заказ через place_order;
--   * со столом → открыть/получить счёт стола и атомарно добавить
--     позиции через append_to_order. Повтор принятия идемпотентен.
-- ============================================================

-- ── Непрозрачный публичный идентификатор стола ──────────────
ALTER TABLE tables ADD COLUMN IF NOT EXISTS public_token UUID;
UPDATE tables SET public_token = gen_random_uuid() WHERE public_token IS NULL;
ALTER TABLE tables ALTER COLUMN public_token SET DEFAULT gen_random_uuid();
ALTER TABLE tables ALTER COLUMN public_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_public_token ON tables(public_token);

-- ── Контекст и атрибуция заявки ─────────────────────────────
ALTER TABLE online_orders
  ADD COLUMN IF NOT EXISTS table_id UUID REFERENCES tables(id) ON DELETE SET NULL;
ALTER TABLE online_orders
  ADD COLUMN IF NOT EXISTS table_label TEXT;
ALTER TABLE online_orders
  ADD COLUMN IF NOT EXISTS order_channel TEXT NOT NULL DEFAULT 'link'
    CHECK (order_channel IN ('link', 'counter_qr', 'table_qr', 'website', 'social'));

CREATE INDEX IF NOT EXISTS idx_online_orders_table_created
  ON online_orders(table_id, created_at) WHERE table_id IS NOT NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_channel TEXT
    CHECK (order_channel IS NULL OR order_channel IN ('link', 'counter_qr', 'table_qr', 'website', 'social'));

-- Старая 9-аргументная сигнатура должна исчезнуть: PostgREST иначе
-- видит две перегрузки submit_online_order.
DROP FUNCTION IF EXISTS submit_online_order(
  UUID, UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, TEXT, TEXT
);

-- ============================================================
-- Публичная заявка: сервер разрешает table-token, снапшотит label,
-- возвращает прежний JSON-контракт.
-- ============================================================
CREATE FUNCTION submit_online_order(
  p_location_id      UUID,
  p_client_uuid      UUID,
  p_name             TEXT,
  p_phone            TEXT,
  p_items            JSONB,
  p_pickup_at        TIMESTAMPTZ DEFAULT NULL,
  p_note             TEXT        DEFAULT NULL,
  p_order_type       TEXT        DEFAULT 'takeaway',
  p_delivery_address TEXT        DEFAULT NULL,
  p_table_token      UUID        DEFAULT NULL,
  p_order_channel    TEXT        DEFAULT 'link'
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc       locations%ROWTYPE;
  v_table     tables%ROWTYPE;
  v_existing  online_orders%ROWTYPE;
  v_name      TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone     TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note      TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_pickup    TIMESTAMPTZ := p_pickup_at;
  v_type      TEXT := COALESCE(NULLIF(TRIM(p_order_type), ''), 'takeaway');
  v_addr      TEXT := NULLIF(LEFT(TRIM(COALESCE(p_delivery_address, '')), 200), '');
  v_channel   TEXT := COALESCE(NULLIF(TRIM(p_order_channel), ''), 'link');
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
  -- Идемпотентность POST.
  SELECT * INTO v_existing FROM online_orders WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object(
      'online_id', v_existing.id,
      'total', v_existing.total,
      'duplicate', TRUE
    );
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE client_uuid = p_client_uuid) THEN
    RAISE EXCEPTION 'invalid_client_uuid';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  -- Возвращаем enforcement, потерянный при пересоздании функции в 058.
  IF NOT COALESCE((v_loc.settings -> 'online_orders' ->> 'enabled')::BOOLEAN, TRUE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;
  IF COALESCE(
    (v_loc.settings -> 'online_orders' ->> 'paused_until')::TIMESTAMPTZ > NOW(),
    FALSE
  ) THEN
    RAISE EXCEPTION 'paused';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM shifts WHERE location_id = p_location_id AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'closed';
  END IF;

  IF v_channel NOT IN ('link', 'counter_qr', 'table_qr', 'website', 'social') THEN
    RAISE EXCEPTION 'invalid_order_channel';
  END IF;

  -- QR стола: доверяем только токену, label и id берём из БД.
  IF p_table_token IS NOT NULL THEN
    SELECT * INTO v_table
    FROM tables
    WHERE public_token = p_table_token
      AND location_id = p_location_id
      AND org_id = v_loc.org_id
      AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_table';
    END IF;
    IF v_table.status = 'disabled'
       OR NOT COALESCE(
         (v_loc.settings -> 'online_orders' ->> 'table_ordering_enabled')::BOOLEAN,
         TRUE
       ) THEN
      RAISE EXCEPTION 'table_ordering_disabled';
    END IF;

    v_type := 'here';
    v_name := COALESCE(NULLIF(v_name, ''), v_table.label);
    v_phone := '';
    v_pickup := NULL;
    v_addr := NULL;
    v_channel := 'table_qr';
  ELSE
    IF LENGTH(v_name) < 1 THEN
      RAISE EXCEPTION 'invalid_name';
    END IF;
    IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
      RAISE EXCEPTION 'invalid_phone';
    END IF;

    -- Тип заказа без стола должен быть включён владельцем.
    v_types := ARRAY(
      SELECT jsonb_array_elements_text(
        v_loc.settings -> 'online_orders' -> 'order_types'
      )
    );
    IF v_types IS NULL OR array_length(v_types, 1) IS NULL THEN
      v_types := ARRAY['here', 'takeaway'];
    END IF;
    IF v_type NOT IN ('here', 'takeaway', 'delivery')
       OR NOT (v_type = ANY (v_types)) THEN
      RAISE EXCEPTION 'invalid_order_type';
    END IF;
    IF v_type = 'delivery' AND v_addr IS NULL THEN
      RAISE EXCEPTION 'invalid_address';
    END IF;
    IF v_type <> 'delivery' THEN
      v_addr := NULL;
    END IF;

    IF v_pickup IS NOT NULL AND v_pickup <= NOW() THEN
      v_pickup := NULL;
    END IF;
    IF v_pickup IS NOT NULL AND v_pickup > NOW() + INTERVAL '24 hours' THEN
      RAISE EXCEPTION 'invalid_pickup';
    END IF;
  END IF;

  -- За столом несколько гостей могут заказывать параллельно, поэтому
  -- лимит мягче телефонного, но всё равно режет автоматический спам.
  IF p_table_token IS NOT NULL THEN
    IF (
      SELECT COUNT(*) FROM online_orders
      WHERE table_id = v_table.id
        AND created_at > NOW() - INTERVAL '5 minutes'
    ) >= 10 THEN
      RAISE EXCEPTION 'rate_limited';
    END IF;
  ELSIF (
    SELECT COUNT(*) FROM online_orders
    WHERE customer_phone = v_phone
      AND created_at > NOW() - INTERVAL '15 minutes'
  ) >= 3 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF (
    SELECT COUNT(*) FROM online_orders
    WHERE location_id = p_location_id AND status = 'new'
  ) >= 30 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) < 1
     OR jsonb_array_length(p_items) > 30 THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  -- Цены, варианты и модификаторы считаются только из текущего каталога.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 99 THEN
      RAISE EXCEPTION 'invalid_items';
    END IF;

    SELECT mi.* INTO v_mi
    FROM menu_items mi
    WHERE mi.id = (v_item ->> 'menu_item_id')::UUID
      AND mi.org_id = v_loc.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_items';
    END IF;

    SELECT (mc.is_active AND mc.location_id = p_location_id) INTO v_cat_ok
    FROM menu_categories mc
    WHERE mc.id = v_mi.category_id;
    IF NOT v_mi.is_available OR NOT COALESCE(v_cat_ok, FALSE) THEN
      RAISE EXCEPTION 'item_unavailable: %', v_mi.name;
    END IF;

    v_variant := NULL;
    IF v_item ->> 'variant_id' IS NOT NULL THEN
      SELECT * INTO v_variant
      FROM item_variants
      WHERE id = (v_item ->> 'variant_id')::UUID
        AND item_id = v_mi.id;
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
        SELECT m.* INTO v_mod
        FROM modifiers m
        JOIN menu_item_modifier_groups mimg
          ON mimg.group_id = m.group_id
         AND mimg.item_id = v_mi.id
        WHERE m.id = v_mod_id
          AND m.org_id = v_loc.org_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'invalid_items';
        END IF;
        IF NOT v_mod.is_available THEN
          RAISE EXCEPTION 'item_unavailable: %', v_mod.name;
        END IF;
        v_unit := v_unit + v_mod.price_delta;
        v_mods := v_mods || jsonb_build_object(
          'id', v_mod.id,
          'name', v_mod.name,
          'price_delta', v_mod.price_delta
        );
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

  INSERT INTO online_orders (
    org_id, location_id, client_uuid, customer_name, customer_phone,
    pickup_at, note, items, subtotal, total, order_type, delivery_address,
    table_id, table_label, order_channel
  )
  VALUES (
    v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
    v_pickup, v_note, v_out_items, v_subtotal, v_subtotal, v_type, v_addr,
    v_table.id, v_table.label, v_channel
  )
  RETURNING id INTO v_id;

  RETURN json_build_object(
    'online_id', v_id,
    'total', v_subtotal,
    'duplicate', FALSE
  );
END $$;

REVOKE ALL ON FUNCTION submit_online_order(
  UUID, UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_online_order(
  UUID, UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT
) TO service_role;

-- ============================================================
-- Принятие заявки: стол получает дозаказ, ссылка/стойка — отдельный
-- counter-заказ. Вся операция выполняется одной транзакцией.
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
  v_table_order_existed BOOLEAN := FALSE;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_oo
  FROM online_orders
  WHERE id = p_online_id AND org_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'online order not found';
  END IF;
  IF v_oo.status = 'accepted' THEN
    SELECT * INTO v_o FROM orders WHERE id = v_oo.order_id;
    RETURN json_build_object(
      'order_id', v_o.id,
      'daily_number', v_o.daily_number,
      'total', v_o.total,
      'duplicate', TRUE
    );
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
  ))
  INTO v_items
  FROM jsonb_array_elements(v_oo.items) e;

  IF v_oo.table_id IS NOT NULL THEN
    -- Новый QR-заказ открывает счёт; следующий QR-заказ того же стола
    -- становится дозаказом в уже открытый счёт.
    v_res := open_or_get_table_order(
      p_table_id      := v_oo.table_id,
      p_staff_id      := p_staff_id,
      p_client_uuid   := v_oo.client_uuid,
      p_opened_at     := v_oo.created_at,
      p_staff_session := NULL
    );
    v_order_id := (v_res ->> 'order_id')::UUID;
    v_table_order_existed := COALESCE((v_res ->> 'existing')::BOOLEAN, FALSE);

    PERFORM append_to_order(
      p_order_id      := v_order_id,
      p_staff_id      := p_staff_id,
      p_items         := v_items,
      p_op_uuid       := v_oo.client_uuid,
      p_staff_session := NULL
    );
  ELSE
    v_res := place_order(
      p_client_uuid   := v_oo.client_uuid,
      p_staff_id      := p_staff_id,
      p_order_type    := v_oo.order_type,
      p_customer_name := v_oo.customer_name,
      p_items         := v_items,
      p_staff_session := NULL
    );
    IF (v_res ->> 'duplicate')::BOOLEAN THEN
      RAISE EXCEPTION 'client uuid conflict';
    END IF;
    v_order_id := (v_res ->> 'order_id')::UUID;
  END IF;

  UPDATE orders
  SET source = CASE
        -- Не превращаем весь ранее открытый POS-счёт стола в online revenue:
        -- QR здесь лишь добавил новые строки в смешанный счёт.
        WHEN v_oo.table_id IS NOT NULL AND v_table_order_existed THEN source
        ELSE 'site'
      END,
      customer_phone = COALESCE(NULLIF(v_oo.customer_phone, ''), customer_phone),
      pickup_at = v_oo.pickup_at,
      delivery_address = v_oo.delivery_address,
      order_channel = v_oo.order_channel
  WHERE id = v_order_id;

  UPDATE online_orders
  SET status = 'accepted',
      order_id = v_order_id,
      decided_by = p_staff_id,
      decided_at = NOW()
  WHERE id = p_online_id;

  SELECT * INTO v_o FROM orders WHERE id = v_order_id;
  RETURN json_build_object(
    'order_id', v_o.id,
    'daily_number', v_o.daily_number,
    'total', v_o.total,
    'duplicate', FALSE
  );
END $$;

REVOKE EXECUTE ON FUNCTION accept_online_order(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_online_order(UUID, UUID) TO authenticated;

-- ── Статус гостю: добавляем table_label и атрибуцию ─────────
CREATE OR REPLACE FUNCTION get_online_order_status(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_oo   online_orders%ROWTYPE;
  v_o    orders%ROWTYPE;
  v_oo_s JSONB;
  v_min  INTEGER;
  v_max  INTEGER;
BEGIN
  SELECT * INTO v_oo
  FROM online_orders
  WHERE client_uuid = p_client_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_oo.order_id IS NOT NULL THEN
    SELECT * INTO v_o FROM orders WHERE id = v_oo.order_id;
  END IF;

  SELECT settings -> 'online_orders'
  INTO v_oo_s
  FROM locations
  WHERE id = v_oo.location_id;
  v_min := COALESCE(
    (v_oo_s ->> 'prep_min')::INTEGER,
    (v_oo_s ->> 'prep_minutes')::INTEGER,
    0
  );
  v_max := COALESCE(
    (v_oo_s ->> 'prep_max')::INTEGER,
    (v_oo_s ->> 'prep_minutes')::INTEGER,
    0
  );

  RETURN json_build_object(
    'status',        v_oo.status,
    'reject_reason', v_oo.reject_reason,
    -- У стола настоящий счёт может содержать несколько QR-дозаказов;
    -- конкретному гостю показываем сумму именно его заявки.
    'total',         CASE
                       WHEN v_oo.table_id IS NOT NULL THEN v_oo.total
                       ELSE COALESCE(v_o.total, v_oo.total)
                     END,
    'daily_number',  v_o.daily_number,
    'order_status',  v_o.status,
    'order_type',    v_oo.order_type,
    'table_label',   v_oo.table_label,
    'order_channel', v_oo.order_channel,
    'created_at',    v_oo.created_at,
    'decided_at',    v_oo.decided_at,
    'prep_min',      v_min,
    'prep_max',      v_max
  );
END $$;

REVOKE ALL ON FUNCTION get_online_order_status(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_online_order_status(UUID) TO service_role;

COMMENT ON COLUMN tables.public_token IS
  'Непрозрачный токен для публичного QR стола; внутренний table_id наружу не отдаётся.';
COMMENT ON COLUMN online_orders.order_channel IS
  'Атрибуция публичной заявки: link/counter_qr/table_qr/website/social.';
