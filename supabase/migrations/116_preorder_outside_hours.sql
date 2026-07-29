-- ============================================================
-- 116. Предзаказ вне часов работы — «закрыто сейчас» ≠ «закрыто вообще».
--
-- Мотив: 112 сделал расписание общим гейтом приёма и проверял его ТОЛЬКО
-- на NOW(). Из-за этого заведение, закрывшееся вечером, переставало
-- принимать и заказы на завтра: витрина предлагала слоты завтрашнего
-- окна (buildPickupSlots строит горизонт на двое суток), гость выбирал
-- 09:00, а submit_online_order падал с 'closed' ещё до проверки
-- pickup_at. Приём заказов пропадал ровно тогда, когда предзаказ нужнее
-- всего — ночью и в выходной.
--
-- Правило теперь разделено по смыслу:
--   • pickup_at IS NULL («как можно скорее») — требует, чтобы точка была
--     открыта ПРЯМО СЕЙЧАС: готовить некому, заявка ушла бы в пустоту;
--   • pickup_at IS NOT NULL (заказ ко времени) — требует, чтобы точка
--     была открыта В ЭТОТ МОМЕНТ. Часы «сейчас» роли не играют: смысл
--     предзаказа в том, что его оформляют заранее.
-- Лимит 24 часов и обнуление прошедшего времени сохранены, поэтому
-- горизонт предзаказа не расширяется — меняется только то, обязана ли
-- точка быть открытой в момент оформления.
--
-- Заказ за столом (table_token) остаётся строго «сейчас»: гость физически
-- сидит в зале, предзаказ за столик смысла не имеет. Ему pickup_at
-- обнуляется выше по телу, поэтому он попадает под ветку «сейчас».
--
-- Пауза с кассы (054) и тумблер (051) на предзаказ по-прежнему влияют:
-- это ручное «мы не принимаем», а не расписание.
--
-- Тело 112 повторено дословно (forward-only, CREATE OR REPLACE) — изменён
-- только блок гейтов между 'paused' и проверкой order_channel, плюс
-- перенос проверки pickup_at выше, чтобы обе ветки читались рядом.
--
-- ⚠️ ТРЕБУЕТ 112 (online_hours_open_at, submit_online_order v13).
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
  v_mode      TEXT;
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

  -- Capability-гейт (105): приём гостевых заказов — online_orders.
  IF NOT org_has_capability(v_loc.org_id, 'online_orders') THEN
    RAISE EXCEPTION 'module_disabled';
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

  -- Нормализация выбранного времени до гейтов (116): прошедшее время =
  -- «как можно скорее», иначе заявка на 5 минут назад считалась бы
  -- предзаказом и обходила проверку «открыто сейчас».
  IF p_table_token IS NULL THEN
    IF v_pickup IS NOT NULL AND v_pickup <= NOW() THEN
      v_pickup := NULL;
    END IF;
    IF v_pickup IS NOT NULL AND v_pickup > NOW() + INTERVAL '24 hours' THEN
      RAISE EXCEPTION 'invalid_pickup';
    END IF;
  END IF;

  -- (116) Часы работы: «сейчас» и «ко времени» — разные вопросы.
  IF v_pickup IS NULL THEN
    -- Заказ на сейчас: точка обязана быть открыта в этот момент.
    IF NOT online_hours_open(v_loc.settings, v_loc.timezone) THEN
      RAISE EXCEPTION 'closed';
    END IF;
    -- Режим обслуживания (101): POS-точка дополнительно требует открытую
    -- смену — приёмка заявки живёт на кассе. Standalone обслуживается из
    -- веб-инбокса, там смен нет.
    v_mode := online_fulfilment_mode(v_loc.org_id, v_loc.settings);
    IF v_mode = 'pos' THEN
      IF NOT EXISTS (
        SELECT 1 FROM shifts WHERE location_id = p_location_id AND status = 'open'
      ) THEN
        RAISE EXCEPTION 'closed';
      END IF;
    END IF;
  ELSE
    -- Предзаказ: значение имеют часы в выбранный момент, а не текущие.
    -- Смена тоже не проверяется — к моменту выдачи её откроют.
    IF NOT online_hours_open_at(v_loc.settings, v_loc.timezone, v_pickup) THEN
      RAISE EXCEPTION 'pickup_outside_hours';
    END IF;
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

COMMENT ON FUNCTION submit_online_order(
  UUID, UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT
) IS
  'Приём гостевой заявки. Заказ «на сейчас» требует открытых часов (и смены для POS); предзаказ на будущее время — только попадания pickup_at внутрь часов работы (116).';
