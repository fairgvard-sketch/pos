-- ============================================================
-- 105 CAPABILITY ENFORCEMENT — серверные гейты по capabilities
-- (Phase 3 плана product separation).
--
-- Гейты переезжают с продуктов на capabilities (карта — 103):
--   public QR Menu        -> public_menu          (Edge public-menu)
--   приём заказа + статус -> online_orders        (submit/get_online_order_status)
--   веб-инбокс заказов    -> orders_desk          (set_online_order_status_web)
--   публичная бронь       -> public_reservations  (submit/availability/status)
--   веб-стол хостес       -> reservations_desk    (set_reservation_status_web)
--   работа кассы          -> pos_operate          (open_shift, place/pay/open/append)
--   POS-отчёты            -> pos_reports          (sales_report)
--   каталог               -> catalog_manage       (save_menu_item, reorder_menu)
--
-- Правила:
--   * отсутствие возможности — стабильный код ошибки `module_disabled`;
--   * выключение продукта блокирует его чтения/записи, но НЕ трогает
--     данные: повторная выдача возвращает доступ к сохранённому;
--   * закрытие смены и фискальный экспорт (uf_export_*) сознательно
--     НЕ гейтятся: завершение открытой смены и выгрузка фискальной
--     истории обязаны работать даже у приостановленной организации;
--   * ANGLE Orders даёт public_menu без покупки Menu (карта 103);
--   * все существующие организации получили полный набор продуктов
--     бэкфиллом 100 — для них поведение не меняется.
--
-- Тела заимствованных функций скопированы дословно из последних
-- определений (089/092/099/072/100/101/102, обёртки 086); в каждом
-- изменены только строки гейта. save_menu_item/reorder_menu получают
-- capability-гейт приёмом 068/086: rename в *_impl + тонкая обёртка.
--
-- ⚠️ ТРЕБУЕТ 104 (product_activation_requests), 103 (capabilities).
-- ============================================================

-- ── Хелпер: гейт возможности текущей организации ─────────────
CREATE OR REPLACE FUNCTION require_org_capability(p_capability TEXT)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT org_has_capability(auth_org_id(), p_capability) THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
END $$;

REVOKE ALL ON FUNCTION require_org_capability(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION require_org_capability(TEXT) TO authenticated, service_role;

-- ── Гейты публичной витрины для Edge public-menu ─────────────
-- Один RPC вместо трёх обращений: функция под service_role внутри Deno.
CREATE OR REPLACE FUNCTION org_public_menu_gates(p_org UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'public_menu',   org_has_capability(p_org, 'public_menu'),
    'online_orders', org_has_capability(p_org, 'online_orders'),
    'pos',           org_has_product(p_org, 'pos')
  )
$$;

REVOKE ALL ON FUNCTION org_public_menu_gates(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION org_public_menu_gates(UUID) TO service_role;

-- ============================================================
-- submit_online_order: тело 101 дословно; гейт модуля переведён на
-- capability online_orders (105).
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
  -- Режим обслуживания (101): POS-точка требует открытую смену (как
  -- раньше); standalone живёт без смен — доступность решают тумблер и
  -- пауза (проверены выше) плюс недельное расписание online_hours_open.
  v_mode := online_fulfilment_mode(v_loc.org_id, v_loc.settings);
  IF v_mode = 'pos' THEN
    IF NOT EXISTS (
      SELECT 1 FROM shifts WHERE location_id = p_location_id AND status = 'open'
    ) THEN
      RAISE EXCEPTION 'closed';
    END IF;
  ELSIF NOT online_hours_open(v_loc.settings, v_loc.timezone) THEN
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
-- submit_reservation: тело 100 дословно; гейт модуля переведён на
-- capability public_reservations (105), по-прежнему ДО settings-тумблера.
-- ============================================================
CREATE OR REPLACE FUNCTION submit_reservation(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_reserved_at TIMESTAMPTZ,
  p_note        TEXT DEFAULT NULL,
  p_zone_id     UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_existing reservations%ROWTYPE;
  v_name     TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone    TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note     TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_open     TEXT;
  v_close    TEXT;
  v_local    TIME;
  v_max      INTEGER;
  v_instant  BOOLEAN;
  v_combine  BOOLEAN;
  v_dur      INTEGER;
  v_buffer   INTEGER;
  v_tables   UUID[];
  v_table    UUID := NULL;
  v_hold     UUID[] := '{}';
  v_status   TEXT := 'new';
  v_dep_amt  INTEGER := 0;
  v_dep_st   TEXT := 'none';
  v_id       UUID;
BEGIN
  -- Идемпотентность
  SELECT * INTO v_existing FROM reservations WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('reservation_id', v_existing.id, 'duplicate', TRUE,
                             'status', v_existing.status);
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  -- Capability-гейт (105): публичная бронь — public_reservations.
  -- ДО settings-тумблера: module_disabled ≠ disabled.
  IF NOT org_has_capability(v_loc.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  v_rsv := v_loc.settings -> 'reservations';

  IF NOT COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;
  v_max := GREATEST(1, LEAST(200, COALESCE((v_rsv ->> 'max_party')::INTEGER, 20)));
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > v_max THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_reserved_at IS NULL
     OR p_reserved_at < NOW() + INTERVAL '30 minutes'
     OR p_reserved_at > NOW() + INTERVAL '30 days' THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;
  -- Зона (072): пожелание гостя; обязана быть живой зоной этой точки
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  -- Часы приёма (059)
  v_open  := NULLIF(v_rsv ->> 'open', '');
  v_close := NULLIF(v_rsv ->> 'close', '');
  IF v_open IS NOT NULL AND v_close IS NOT NULL THEN
    v_local := (p_reserved_at AT TIME ZONE v_loc.timezone)::time;
    IF v_local < v_open::time OR v_local > v_close::time THEN
      RAISE EXCEPTION 'outside_hours';
    END IF;
  END IF;

  -- Анти-спам
  IF (SELECT COUNT(*) FROM reservations
      WHERE customer_phone = v_phone AND created_at > NOW() - INTERVAL '15 minutes') >= 3 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT COUNT(*) FROM reservations
      WHERE location_id = p_location_id AND status = 'new') >= 30 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  v_instant := COALESCE((v_rsv ->> 'instant')::BOOLEAN, FALSE);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_dur     := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);

  -- Депозит-плейсхолдер (без оплаты)
  IF COALESCE((v_rsv ->> 'deposit_required')::BOOLEAN, FALSE)
     AND p_party_size >= COALESCE((v_rsv ->> 'deposit_from_party')::INTEGER, 1) THEN
    v_dep_amt := GREATEST(0, COALESCE((v_rsv ->> 'deposit_amount')::INTEGER, 0));
    IF v_dep_amt > 0 THEN
      v_dep_st := 'required';
    END IF;
  END IF;

  IF v_instant THEN
    -- Подбор стола(ов) под окно визита — в выбранной зоне, если задана
    v_tables := _pick_tables(p_location_id, p_party_size, p_reserved_at, v_dur,
                             v_buffer, v_combine, NULL, p_zone_id);
    IF array_length(v_tables, 1) IS NULL THEN
      RAISE EXCEPTION 'full_slot';
    END IF;
    v_table  := v_tables[1];
    v_hold   := v_tables[2:array_length(v_tables, 1)];  -- пусто для одиночного
    v_status := 'confirmed';
  END IF;

  -- INSERT. EXCLUDE-констрейнт ловит гонку (два инстант-гостя на один стол):
  -- при конфликте — отдаём full_slot, а не 500.
  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, note, duration_min, table_id, hold_table_ids,
      auto, status, decided_at, deposit_amount, deposit_status, zone_id)
    VALUES (
      v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
      p_party_size, p_reserved_at, v_note, v_dur, v_table, COALESCE(v_hold, '{}'),
      v_instant, v_status, CASE WHEN v_instant THEN NOW() END, v_dep_amt, v_dep_st,
      p_zone_id)
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'full_slot';
  END;

  RETURN json_build_object(
    'reservation_id', v_id,
    'duplicate', FALSE,
    'status', v_status,
    'deposit_status', v_dep_st,
    'deposit_amount', v_dep_amt
  );
END $$;

REVOKE ALL ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID) TO service_role;

-- ── get_online_order_status: тело 099 дословно + capability-гейт ──
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
  -- Capability-гейт (105): статус заявки — часть продукта Orders.
  IF NOT org_has_capability(v_oo.org_id, 'online_orders') THEN
    RAISE EXCEPTION 'module_disabled';
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

-- ── reservation_availability: тело 072 дословно + capability-гейт ──
CREATE OR REPLACE FUNCTION reservation_availability(
  p_location_id UUID,
  p_date        DATE,
  p_party       INTEGER,
  p_zone_id     UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_tz       TEXT;
  v_open     TIME := '07:00';
  v_close    TIME := '23:45';
  v_step     INTEGER := 15;
  v_dur      INTEGER := 90;
  v_buffer   INTEGER := 0;
  v_combine  BOOLEAN := FALSE;
  v_min_at   TIMESTAMPTZ := NOW() + INTERVAL '30 minutes';
  v_slots    JSONB := '[]'::jsonb;
  v_t        TIME;
  v_m        INTEGER;
  v_to       INTEGER;
  v_at       TIMESTAMPTZ;
  v_free     BOOLEAN;
BEGIN
  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;
  -- Capability-гейт (105): live-доступность — часть публичной брони.
  IF NOT org_has_capability(v_loc.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  v_tz  := v_loc.timezone;
  v_rsv := v_loc.settings -> 'reservations';

  IF NOT COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;
  IF p_party IS NULL OR p_party < 1 OR p_party > 200 THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  v_open    := COALESCE(NULLIF(v_rsv ->> 'open', '')::TIME, v_open);
  v_close   := COALESCE(NULLIF(v_rsv ->> 'close', '')::TIME, v_close);
  v_step    := GREATEST(5, COALESCE((v_rsv ->> 'slot_min')::INTEGER, v_step));
  v_dur      := COALESCE((v_rsv ->> 'duration_min')::INTEGER, v_dur);
  v_buffer   := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, v_buffer);
  v_combine  := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);

  -- Итерация по минутам от полуночи, НЕ по TIME: TIME заворачивается через
  -- полночь ('23:45' + 15 мин = '00:00'), и `WHILE v_t <= v_close` при
  -- close >= 23:45 не завершался никогда (баг 063).
  v_m  := EXTRACT(HOUR FROM v_open)::int * 60 + EXTRACT(MINUTE FROM v_open)::int;
  v_to := EXTRACT(HOUR FROM v_close)::int * 60 + EXTRACT(MINUTE FROM v_close)::int;
  WHILE v_m <= v_to LOOP
    v_t := make_time(v_m / 60, v_m % 60, 0);
    -- Локальное время слота → момент в UTC для сравнения с бронями
    v_at := (p_date + v_t) AT TIME ZONE v_tz;
    IF v_at >= v_min_at THEN
      v_free := array_length(
        _pick_tables(p_location_id, p_party, v_at, v_dur, v_buffer, v_combine, NULL, p_zone_id), 1
      ) IS NOT NULL;
      v_slots := v_slots || jsonb_build_object(
        'time', to_char(v_t, 'HH24:MI'),
        'free', v_free
      );
    END IF;
    v_m := v_m + v_step;
  END LOOP;

  RETURN json_build_object(
    'date', p_date,
    'slot_min', v_step,
    'slots', v_slots
  );
END $$;

REVOKE ALL ON FUNCTION reservation_availability(UUID, DATE, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reservation_availability(UUID, DATE, INTEGER, UUID) TO service_role;

-- ── get_reservation_status: тело 072 дословно + capability-гейт ──
CREATE OR REPLACE FUNCTION get_reservation_status(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r reservations%ROWTYPE;
  v_table_label TEXT;
  v_zone_name   TEXT;
BEGIN
  SELECT * INTO v_r FROM reservations WHERE client_uuid = p_client_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  -- Capability-гейт (105): статус брони — часть публичной брони.
  IF NOT org_has_capability(v_r.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  IF v_r.table_id IS NOT NULL THEN
    SELECT label INTO v_table_label FROM tables WHERE id = v_r.table_id;
  END IF;
  IF v_r.zone_id IS NOT NULL THEN
    SELECT name INTO v_zone_name FROM table_zones WHERE id = v_r.zone_id;
  END IF;
  RETURN json_build_object(
    'status',        v_r.status,          -- new | confirmed | rejected | cancelled
    'reject_reason', v_r.reject_reason,
    'reserved_at',   v_r.reserved_at,
    'party_size',    v_r.party_size,
    'customer_name', v_r.customer_name,
    'table_label',   v_table_label,
    'zone_name',     v_zone_name,
    'created_at',    v_r.created_at
  );
END $$;

REVOKE ALL ON FUNCTION get_reservation_status(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_reservation_status(UUID) TO service_role;

-- ── Переводы статусов из веб-кабинета (standalone) ───────────
CREATE OR REPLACE FUNCTION set_online_order_status_web(
  p_location_id UUID,
  p_online_id   UUID,
  p_status      TEXT,
  p_reason      TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member  organization_members%ROWTYPE;
  v_loc     locations%ROWTYPE;
  v_oo      online_orders%ROWTYPE;
  v_mode    TEXT;
  v_allowed TEXT[];
BEGIN
  -- Только веб-членство owner/manager (091/096): кассовый поток остаётся
  -- на accept/reject_online_order с PIN-сессией — здесь его не подменяем.
  IF auth_backoffice_role() IS NULL
     OR auth_backoffice_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  SELECT * INTO v_member
  FROM organization_members
  WHERE auth_user_id = auth.uid() AND org_id = auth_org_id() AND is_active
  LIMIT 1;
  IF v_member.id IS NULL THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  PERFORM assert_backoffice_location(p_location_id);

  -- Capability-гейт (105): веб-инбокс заказов — orders_desk.
  IF NOT org_has_capability(auth_org_id(), 'orders_desk') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  v_mode := online_fulfilment_mode(v_loc.org_id, v_loc.settings);
  IF v_mode <> 'standalone' THEN
    -- Жизненный цикл POS-точки живёт на кассе: веб не создаёт и не
    -- трогает её операционные записи (инвариант «режимы не смешиваются»).
    RAISE EXCEPTION 'pos_mode';
  END IF;

  SELECT * INTO v_oo
  FROM online_orders
  WHERE id = p_online_id
    AND org_id = auth_org_id()
    AND location_id = p_location_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_oo.order_id IS NOT NULL THEN
    -- Заявка уже конвертирована в POS-заказ — финансовый контур неприкасаем.
    RAISE EXCEPTION 'pos_mode';
  END IF;

  -- Ретрай той же кнопки после таймаута — no-op, не ошибка.
  IF v_oo.status = p_status THEN
    RETURN json_build_object(
      'online_id', v_oo.id, 'status', v_oo.status, 'duplicate', TRUE
    );
  END IF;

  -- CASE в присваивании, не в IF-условии: сплиттер CLI ломается на
  -- CASE…END внутри условия plpgsql (грабли 076).
  v_allowed := CASE v_oo.status
    WHEN 'new'       THEN ARRAY['accepted', 'rejected']
    WHEN 'accepted'  THEN ARRAY['preparing', 'ready', 'completed', 'cancelled']
    WHEN 'preparing' THEN ARRAY['ready', 'completed', 'cancelled']
    WHEN 'ready'     THEN ARRAY['completed', 'cancelled']
    ELSE ARRAY[]::TEXT[]
  END;
  IF NOT (p_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;

  UPDATE online_orders SET
    status = p_status,
    reject_reason = CASE
      WHEN p_status IN ('rejected', 'cancelled')
        THEN NULLIF(LEFT(TRIM(COALESCE(p_reason, '')), 200), '')
      ELSE reject_reason
    END,
    decided_by_member = v_member.id,
    decided_at = NOW()
  WHERE id = v_oo.id;

  RETURN json_build_object('online_id', v_oo.id, 'status', p_status);
END $$;

REVOKE ALL ON FUNCTION set_online_order_status_web(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_online_order_status_web(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION set_online_order_status_web(UUID, UUID, TEXT, TEXT) IS
  'Standalone-инбокс кабинета: переводы статусов онлайн-заявки без POS. Только owner/manager-членство, только standalone-режим точки, заявки с order_id неприкасаемы.';

-- ── Переводы статусов из веб-кабинета ────────────────────────
CREATE OR REPLACE FUNCTION set_reservation_status_web(
  p_location_id UUID,
  p_id          UUID,
  p_status      TEXT,
  p_reason      TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member  organization_members%ROWTYPE;
  v_r       reservations%ROWTYPE;
  v_allowed TEXT[];
BEGIN
  -- Только веб-членство owner/manager: кассовый поток остаётся на
  -- accept/reject_reservation с PIN-сессией.
  IF auth_backoffice_role() IS NULL
     OR auth_backoffice_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  SELECT * INTO v_member
  FROM organization_members
  WHERE auth_user_id = auth.uid() AND org_id = auth_org_id() AND is_active
  LIMIT 1;
  IF v_member.id IS NULL THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  PERFORM assert_backoffice_location(p_location_id);

  -- Capability-гейт (105): веб-стол хостес — reservations_desk.
  IF NOT org_has_capability(auth_org_id(), 'reservations_desk') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  SELECT * INTO v_r
  FROM reservations
  WHERE id = p_id
    AND org_id = auth_org_id()
    AND location_id = p_location_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.order_id IS NOT NULL THEN
    -- Гость уже посажен в POS-заказ (057) — визит живёт на кассе.
    RAISE EXCEPTION 'pos_mode';
  END IF;

  -- Ретрай той же кнопки после таймаута — no-op, не ошибка.
  IF v_r.status = p_status THEN
    RETURN json_build_object(
      'reservation_id', v_r.id, 'status', v_r.status, 'duplicate', TRUE
    );
  END IF;

  -- CASE в присваивании, не в IF-условии (грабли сплиттера CLI, 076).
  v_allowed := CASE v_r.status
    WHEN 'new'       THEN ARRAY['confirmed', 'rejected', 'cancelled']
    WHEN 'confirmed' THEN ARRAY['cancelled', 'completed', 'no_show']
    ELSE ARRAY[]::TEXT[]
  END;
  IF NOT (p_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'invalid_transition';
  END IF;

  UPDATE reservations SET
    status = p_status,
    reject_reason = CASE
      WHEN p_status IN ('rejected', 'cancelled')
        THEN NULLIF(LEFT(TRIM(COALESCE(p_reason, '')), 200), '')
      ELSE reject_reason
    END,
    cancelled_at = CASE
      WHEN p_status = 'cancelled' THEN NOW()
      ELSE cancelled_at
    END,
    decided_by_member = v_member.id,
    decided_at = NOW()
  WHERE id = v_r.id;

  RETURN json_build_object('reservation_id', v_r.id, 'status', p_status);
END $$;

REVOKE ALL ON FUNCTION set_reservation_status_web(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_reservation_status_web(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION set_reservation_status_web(UUID, UUID, TEXT, TEXT) IS
  'Веб-стол хостес: переводы статусов брони без POS. Owner/manager-членство, модуль reservations; брони с order_id (посажены на кассе) неприкасаемы. Терминальные completed/no_show освобождают окно стола (вне предикатов движка доступности — сознательно).';

-- ── sales_report: тело 089 дословно + capability-гейт pos_reports ──
CREATE OR REPLACE FUNCTION sales_report(
  p_from TIMESTAMPTZ,
  p_to   TIMESTAMPTZ,
  p_tz   TEXT DEFAULT 'Asia/Jerusalem',
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Веб-владелец бэкофиса подтверждён членством (088) — PIN-сессия не нужна.
  -- Иначе прежний путь: staff-сессия с правом 'manage'.
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  -- Capability-гейт (105): POS-отчёты — pos_reports.
  PERFORM require_org_capability('pos_reports');

  WITH sold AS (
    SELECT * FROM orders
    WHERE status IN ('paid', 'fulfilled', 'refunded')
      AND paid_at >= p_from AND paid_at < p_to
  ),
  pays AS (
    SELECT * FROM payments
    WHERE created_at >= p_from AND created_at < p_to
  ),
  active_items AS (
    SELECT oi.*
    FROM order_items oi
    JOIN sold o ON o.id = oi.order_id
    WHERE oi.voided_at IS NULL
  )
  SELECT jsonb_build_object(
    'summary', (
      SELECT jsonb_build_object(
        'gross_sales',   COALESCE(SUM(total), 0),
        'discounts',     COALESCE(SUM(discount_amount), 0),
        'vat',           COALESCE(SUM(vat_amount), 0),
        'orders_count',  COUNT(*),
        'avg_check',     COALESCE(ROUND(AVG(total)), 0)::int,
        'refunds',       (SELECT COALESCE(-SUM(amount), 0) FROM pays WHERE amount < 0),
        'refunds_count', (SELECT COUNT(DISTINCT order_id) FROM pays WHERE amount < 0)
      )
      FROM sold
    ),
    'by_method', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('method', method, 'amount', amount, 'count', cnt)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        -- Сумма включает отрицательные возвраты → чистая по каждому способу
        SELECT method, SUM(amount) AS amount,
               COUNT(*) FILTER (WHERE amount > 0) AS cnt
        FROM pays
        GROUP BY method
      ) m
    ),
    'by_hour', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('hour', hour, 'amount', amount, 'count', cnt)
        ORDER BY hour), '[]'::jsonb)
      FROM (
        SELECT EXTRACT(HOUR FROM paid_at AT TIME ZONE p_tz)::int AS hour,
               SUM(total) AS amount, COUNT(*) AS cnt
        FROM sold
        GROUP BY 1
      ) h
    ),
    'by_day', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('day', to_char(day, 'YYYY-MM-DD'), 'amount', amount, 'count', cnt)
        ORDER BY day), '[]'::jsonb)
      FROM (
        SELECT (paid_at AT TIME ZONE p_tz)::date AS day,
               SUM(total) AS amount, COUNT(*) AS cnt
        FROM sold
        GROUP BY 1
      ) d
    ),
    'top_items', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('name', name, 'qty', qty, 'amount', amount)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        -- Группировка по снапшоту имени: чек-история не зависит от правок меню
        SELECT name, SUM(qty) AS qty, SUM(line_total) AS amount
        FROM active_items
        GROUP BY name
        ORDER BY amount DESC
        LIMIT 15
      ) ti
    ),
    'by_category', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('category', category, 'qty', qty, 'amount', amount)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        SELECT COALESCE(mc.name, '—') AS category,
               SUM(ai.qty) AS qty, SUM(ai.line_total) AS amount
        FROM active_items ai
        LEFT JOIN menu_items mi ON mi.id = ai.menu_item_id
        LEFT JOIN menu_categories mc ON mc.id = mi.category_id
        GROUP BY 1
      ) c
    ),
    'by_staff', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('name', name, 'amount', amount, 'count', cnt)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        SELECT s.name, SUM(o.total) AS amount, COUNT(*) AS cnt
        FROM sold o
        JOIN staff s ON s.id = o.staff_id
        GROUP BY s.name
      ) st
    )
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION sales_report FROM anon, public;
GRANT EXECUTE ON FUNCTION sales_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID) TO authenticated;

-- ── open_shift: тело 008 дословно + capability-гейт pos_operate ──
CREATE OR REPLACE FUNCTION open_shift(p_staff_id UUID, p_opening_float INTEGER)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
  v_id  UUID;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  -- Capability-гейт (105): новая смена — pos_operate. Закрытие смены
  -- сознательно не гейтится: открытую смену надо уметь завершить.
  PERFORM require_org_capability('pos_operate');
  IF EXISTS (SELECT 1 FROM shifts WHERE location_id = v_loc AND status = 'open') THEN
    RAISE EXCEPTION 'shift already open';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  INSERT INTO shifts (org_id, location_id, opened_by, opening_float)
  VALUES (v_org, v_loc, p_staff_id, GREATEST(0, COALESCE(p_opening_float, 0)))
  RETURNING id INTO v_id;

  RETURN json_build_object('shift_id', v_id);
END $$;

REVOKE ALL ON FUNCTION open_shift(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION open_shift(UUID, INTEGER) TO authenticated, service_role;

-- ── Горячий поток: обёртки 086 дословно + capability-гейт ────
-- Гейт стоит В ОБЁРТКЕ (импл не тронут): pos_operate проверяется до
-- мягкой проверки staff-сессии, ошибка стабильна — module_disabled.
CREATE OR REPLACE FUNCTION place_order(
  p_client_uuid   UUID,
  p_staff_id      UUID,
  p_order_type    TEXT,
  p_customer_name TEXT,
  p_items         JSONB,
  p_discount      JSONB       DEFAULT NULL,
  p_table_label   TEXT        DEFAULT NULL,
  p_placed_at     TIMESTAMPTZ DEFAULT NULL,
  p_staff_session UUID        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_org_capability('pos_operate');
  PERFORM require_staff_session(p_staff_session);
  RETURN place_order_impl(p_client_uuid, p_staff_id, p_order_type, p_customer_name,
                          p_items, p_discount, p_table_label, p_placed_at);
END $$;

REVOKE EXECUTE ON FUNCTION place_order(UUID, UUID, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_order(UUID, UUID, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ, UUID)
  TO authenticated;

CREATE OR REPLACE FUNCTION pay_order(
  p_order_id      UUID,
  p_payments      JSONB,
  p_tip           INTEGER     DEFAULT 0,
  p_payment_uuid  UUID        DEFAULT NULL,
  p_paid_at       TIMESTAMPTZ DEFAULT NULL,
  p_staff_session UUID        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_org_capability('pos_operate');
  PERFORM require_staff_session(p_staff_session);
  RETURN pay_order_impl(p_order_id, p_payments, p_tip, p_payment_uuid, p_paid_at);
END $$;

REVOKE EXECUTE ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pay_order(UUID, JSONB, INTEGER, UUID, TIMESTAMPTZ, UUID)
  TO authenticated;

CREATE OR REPLACE FUNCTION open_or_get_table_order(
  p_table_id      UUID,
  p_staff_id      UUID,
  p_client_uuid   UUID        DEFAULT NULL,
  p_opened_at     TIMESTAMPTZ DEFAULT NULL,
  p_staff_session UUID        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_org_capability('pos_operate');
  PERFORM require_staff_session(p_staff_session);
  RETURN open_or_get_table_order_impl(p_table_id, p_staff_id, p_client_uuid, p_opened_at);
END $$;

REVOKE EXECUTE ON FUNCTION open_or_get_table_order(UUID, UUID, UUID, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION open_or_get_table_order(UUID, UUID, UUID, TIMESTAMPTZ, UUID)
  TO authenticated;

CREATE OR REPLACE FUNCTION append_to_order(
  p_order_id      UUID,
  p_staff_id      UUID,
  p_items         JSONB,
  p_op_uuid       UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_org_capability('pos_operate');
  PERFORM require_staff_session(p_staff_session);
  RETURN append_to_order_impl(p_order_id, p_staff_id, p_items, p_op_uuid);
END $$;

REVOKE EXECUTE ON FUNCTION append_to_order(UUID, UUID, JSONB, UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION append_to_order(UUID, UUID, JSONB, UUID, UUID)
  TO authenticated;

-- ── Каталог: save_menu_item / reorder_menu под catalog_manage ─
-- Приём 068/086: текущие определения (092) переименовываются в *_impl
-- и закрываются от клиентов; наружу — тонкие обёртки с capability-гейтом.
-- Сигнатуры не меняются: касса и веб-кабинет зовут те же функции.
ALTER FUNCTION reorder_menu(TEXT, JSONB, UUID) RENAME TO reorder_menu_impl;
REVOKE EXECUTE ON FUNCTION reorder_menu_impl(TEXT, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION reorder_menu(p_kind TEXT, p_ids JSONB, p_staff_session UUID DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_org_capability('catalog_manage');
  PERFORM reorder_menu_impl(p_kind, p_ids, p_staff_session);
END $$;

REVOKE ALL ON FUNCTION reorder_menu(TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reorder_menu(TEXT, JSONB, UUID) TO authenticated, service_role;

ALTER FUNCTION save_menu_item(JSONB, JSONB, JSONB, UUID, UUID, JSONB)
  RENAME TO save_menu_item_impl;
REVOKE EXECUTE ON FUNCTION save_menu_item_impl(JSONB, JSONB, JSONB, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION save_menu_item(
  p_item JSONB,
  p_variants JSONB DEFAULT '[]'::jsonb,
  p_group_ids JSONB DEFAULT '[]'::jsonb,
  p_item_id UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL,
  p_supplies JSONB DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_org_capability('catalog_manage');
  RETURN save_menu_item_impl(p_item, p_variants, p_group_ids, p_item_id,
                             p_staff_session, p_supplies);
END $$;

REVOKE ALL ON FUNCTION save_menu_item(JSONB, JSONB, JSONB, UUID, UUID, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_menu_item(JSONB, JSONB, JSONB, UUID, UUID, JSONB)
  TO authenticated, service_role;

-- ── get_backoffice_context: + capabilities/account_type/заявки ─
-- Тело 100 дословно; payload дополнен аддитивно (сигнатура прежняя):
--   products         — ЭФФЕКТИВНЫЕ продукты (lifecycle 103, не сырые строки);
--   capabilities     — эффективные возможности (навигация Phase 4);
--   account_type     — customer/developer/demo (бейдж Developer workspace);
--   product_requests — pending-заявки на активацию (Pending activation);
--   product_sources  — источник эффективного гранта (карточка Developer).
CREATE OR REPLACE FUNCTION get_backoffice_context()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_org       UUID := auth_org_id();
  v_member    organization_members%ROWTYPE;
  v_payload   JSONB;
BEGIN
  IF v_uid IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_member
  FROM organization_members
  WHERE auth_user_id = v_uid
    AND org_id = v_org
    AND is_active
  LIMIT 1;

  IF v_member.id IS NULL THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;

  SELECT jsonb_build_object(
    'member', jsonb_build_object(
      'id', v_member.id,
      'role', v_member.role,
      'display_name', v_member.display_name
    ),
    'organization', jsonb_build_object(
      'id', o.id,
      'name', o.name
    ),
    'account_type', o.account_type,
    'products', COALESCE((
      SELECT jsonb_agg(pc.key ORDER BY pc.key)
      FROM product_catalog pc
      WHERE org_has_product(o.id, pc.key)
    ), '[]'::JSONB),
    'capabilities', COALESCE((
      SELECT jsonb_agg(DISTINCT cap.capability)
      FROM organization_products op
      JOIN product_catalog pc2 ON pc2.key = op.product AND pc2.is_active
      JOIN product_capabilities cap ON cap.product = op.product
      WHERE op.org_id = o.id
        AND op.is_active
        AND op.status IN ('active', 'trialing')
        AND op.starts_at <= NOW()
        AND (op.expires_at IS NULL OR op.expires_at > NOW())
    ), '[]'::JSONB),
    'product_requests', COALESCE((
      SELECT jsonb_agg(r.product ORDER BY r.product)
      FROM product_activation_requests r
      WHERE r.org_id = o.id AND r.status = 'pending'
    ), '[]'::JSONB),
    'product_sources', COALESCE((
      SELECT jsonb_object_agg(op.product, op.source)
      FROM organization_products op
      WHERE op.org_id = o.id AND org_has_product(o.id, op.product)
    ), '{}'::JSONB),
    'locations', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', l.id,
          'name', l.name,
          'currency', l.currency,
          'timezone', l.timezone
        ) ORDER BY l.created_at
      )
      FROM locations l
      WHERE l.org_id = o.id
    ), '[]'::JSONB),
    'counts', jsonb_build_object(
      'locations', (SELECT COUNT(*) FROM locations l WHERE l.org_id = o.id),
      'staff', (SELECT COUNT(*) FROM staff s WHERE s.org_id = o.id AND s.is_active),
      'devices', (SELECT COUNT(*) FROM devices d WHERE d.org_id = o.id)
    )
  ) INTO v_payload
  FROM orgs o
  WHERE o.id = v_org;

  RETURN v_payload;
END;
$$;

REVOKE ALL ON FUNCTION get_backoffice_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_backoffice_context() TO authenticated;

COMMENT ON FUNCTION require_org_capability(TEXT) IS
  'Гейт возможности текущей организации (auth_org_id): отсутствие — стабильная ошибка module_disabled.';
COMMENT ON FUNCTION org_public_menu_gates(UUID) IS
  'Гейты публичной витрины для Edge public-menu: public_menu/online_orders (capabilities) + pos (дефолт режима обслуживания).';
