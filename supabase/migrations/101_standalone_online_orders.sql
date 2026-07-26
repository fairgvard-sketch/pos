-- ============================================================
-- 101 STANDALONE ONLINE ORDERS — приём и обслуживание онлайн-заказов
-- без ANGLE POS (Phase 3 standalone digital products).
--
-- «Точка принимает заказы» отделено от «на кассе открыта смена»:
--   1) online_fulfilment_mode(org, settings) — режим обслуживания точки:
--      'pos' (как раньше: смена обязательна, приёмка на кассе) или
--      'standalone' (веб-инбокс кабинета). Явная настройка
--      settings.online_orders.fulfilment; дефолт — по модулю pos.
--   2) online_hours_open(settings, tz) — недельное расписание приёма
--      settings.online_orders.hours: {"0":[["08:00","16:00"]],...},
--      ключ = день недели (0=воскресенье), локальное время точки,
--      окна через полночь поддержаны. Нет ключа hours = всегда открыто;
--      день без окон = закрыт.
--   3) submit_online_order (тело 100 дословно): гейт смены заменён на
--      разветвление по режиму — вставка только в DECLARE и в блоке
--      проверки; остальной текст не менялся.
--   4) Жизненный цикл standalone: new → accepted → preparing → ready →
--      completed (+ rejected из new, cancelled из активных) — CHECK
--      статусов расширен; POS-конверсия (accept_online_order) не
--      изменилась и для pos-режима работает как раньше.
--   5) set_online_order_status_web — переводы статусов из веб-кабинета:
--      только owner/manager-членство (091/096), только standalone-режим
--      и только заявки без order_id — веб не может тронуть финансовый
--      контур POS; атрибуция в decided_by_member.
--
-- Снапшот позиций/цен в online_orders неизменен с момента заявки (050).
-- Realtime-публикация online_orders и RLS-чтение членов организации
-- уже существуют (050 + JWT org_id) — веб-инбокс подписывается без DDL.
--
-- ⚠️ ТРЕБУЕТ 100 (org_has_product, submit v12).
-- ============================================================

-- ── Жизненный цикл standalone ────────────────────────────────
ALTER TABLE online_orders DROP CONSTRAINT online_orders_status_check;
ALTER TABLE online_orders ADD CONSTRAINT online_orders_status_check
  CHECK (status IN (
    'new', 'accepted', 'preparing', 'ready', 'completed',
    'rejected', 'cancelled'
  ));

-- Атрибуция веб-решений: кто из членов организации перевёл статус.
ALTER TABLE online_orders ADD COLUMN IF NOT EXISTS
  decided_by_member UUID REFERENCES organization_members(id);

COMMENT ON COLUMN online_orders.decided_by_member IS
  'Член организации (веб-кабинет), принявший решение по заявке в standalone-режиме; decided_by остаётся для PIN-сотрудника кассы.';

-- ── Режим обслуживания точки ─────────────────────────────────
CREATE OR REPLACE FUNCTION online_fulfilment_mode(p_org UUID, p_settings JSONB)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_explicit TEXT := p_settings -> 'online_orders' ->> 'fulfilment';
BEGIN
  IF v_explicit IN ('pos', 'standalone') THEN
    RETURN v_explicit;
  END IF;
  -- Дефолт по модулю: POS-организация обслуживает заказы на кассе,
  -- digital-only — в веб-инбоксе кабинета.
  IF org_has_product(p_org, 'pos') THEN
    RETURN 'pos';
  END IF;
  RETURN 'standalone';
END $$;

REVOKE ALL ON FUNCTION online_fulfilment_mode(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION online_fulfilment_mode(UUID, JSONB) TO authenticated, service_role;

-- ── Недельное расписание приёма ──────────────────────────────
CREATE OR REPLACE FUNCTION online_hours_open(p_settings JSONB, p_tz TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_hours   JSONB := p_settings -> 'online_orders' -> 'hours';
  v_now     TIMESTAMP;
  v_windows JSONB;
  v_win     JSONB;
  v_from    TIME;
  v_to      TIME;
BEGIN
  IF v_hours IS NULL OR jsonb_typeof(v_hours) <> 'object' THEN
    RETURN TRUE; -- расписание не настроено = приём в любое время
  END IF;
  v_now := NOW() AT TIME ZONE COALESCE(NULLIF(p_tz, ''), 'Asia/Jerusalem');
  v_windows := v_hours -> (EXTRACT(DOW FROM v_now)::INT::TEXT);
  IF v_windows IS NULL OR jsonb_typeof(v_windows) <> 'array' THEN
    RETURN FALSE; -- день не описан = закрыт
  END IF;
  FOR v_win IN SELECT * FROM jsonb_array_elements(v_windows) LOOP
    BEGIN
      v_from := (v_win ->> 0)::TIME;
      v_to   := (v_win ->> 1)::TIME;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE; -- битое окно не роняет заявку, просто пропускается
    END;
    IF v_from <= v_to THEN
      IF v_now::TIME >= v_from AND v_now::TIME < v_to THEN
        RETURN TRUE;
      END IF;
    ELSE
      -- Окно через полночь: ["20:00","02:00"] — две дуги суток
      IF v_now::TIME >= v_from OR v_now::TIME < v_to THEN
        RETURN TRUE;
      END IF;
    END IF;
  END LOOP;
  RETURN FALSE;
END $$;

REVOKE ALL ON FUNCTION online_hours_open(JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION online_hours_open(JSONB, TEXT) TO authenticated, service_role;

-- ============================================================
-- submit_online_order: тело 100 дословно; заменён ТОЛЬКО гейт смены
-- (разветвление по режиму) и добавлена переменная v_mode.
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

  -- Модуль организации (100): без online_orders заявки не принимаются.
  IF NOT org_has_product(v_loc.org_id, 'online_orders') THEN
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
