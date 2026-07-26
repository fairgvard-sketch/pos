-- ============================================================
-- 100 MODULE ENTITLEMENTS — продуктовые модули организации и
-- digital-only идентичность (ANGLE Menu / Orders / Reserve без POS).
--
-- Продуктовая модель: организация может включить любую комбинацию
-- модулей `menu`, `online_orders`, `reservations`, `pos`. Ент-таблица
-- server-enforced: публичные мутации проверяют модуль в БД, а не
-- видимостью навигации на клиенте.
--
-- Что делает:
--   1) organization_products — нормализованные entitlements per org.
--      Клиентам только SELECT своей организации; провижионинг —
--      миграцией/оператором (MVP: ручной, без биллинга).
--   2) org_has_product(org, product) — единая серверная проверка.
--   3) Бэкфилл: все существующие организации получают все четыре
--      модуля — нулевая регрессия для действующих POS-клиентов.
--   4) bootstrap_org (device-онбординг, тело 044) сеет все модули.
--   5) bootstrap_digital_org — НОВЫЙ digital-only онбординг: владелец
--      с email/паролем создаёт организацию/точку/членство БЕЗ PIN,
--      устройства и смены. В app_metadata пишется ТОЛЬКО org_id:
--      location_id в JWT — маркер устройства, веб-контур (091/096)
--      адресует точку параметром.
--   6) submit_online_order (тело 099) — проверка модуля online_orders.
--   7) submit_reservation (тело 072) — проверка модуля reservations.
--      Проверка стоит ДО settings-тумблера: `module_disabled` (модуль
--      не куплен) отличим от `disabled` (владелец выключил приём).
--   8) get_backoffice_context (088) — аддитивно отдаёт `products`.
--
-- ⚠️ ТРЕБУЕТ 088 (organization_members), 099 (submit_online_order v11).
-- Модульный гейт публичной витрины меню живёт в Edge Function
-- public-menu (деплой отдельно, после миграции).
-- ============================================================

-- ── Entitlements ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organization_products (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  product    TEXT NOT NULL CHECK (product IN ('menu', 'online_orders', 'reservations', 'pos')),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, product)
);

CREATE INDEX IF NOT EXISTS idx_organization_products_org
  ON organization_products(org_id);

ALTER TABLE organization_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_products_select_own_org
  ON organization_products
  FOR SELECT
  TO authenticated
  USING (org_id = auth_org_id());

-- Доступ (правило 071 — новые объекты выдают GRANT сами): чтение своей
-- организации для UI, запись только сервером/оператором.
REVOKE ALL ON organization_products FROM anon, authenticated, public;
GRANT SELECT ON organization_products TO authenticated;
GRANT ALL ON organization_products TO service_role;

-- ── Единая серверная проверка модуля ─────────────────────────
CREATE OR REPLACE FUNCTION org_has_product(p_org UUID, p_product TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_products
    WHERE org_id = p_org AND product = p_product AND is_active
  )
$$;

REVOKE ALL ON FUNCTION org_has_product(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION org_has_product(UUID, TEXT) TO authenticated, service_role;

-- ── Бэкфилл: действующие организации — полный набор модулей ──
-- Enforcement строгий, поэтому пропущенный seed = отказ витрины.
-- Закрыто двойно: бэкфилл здесь + seed в обоих bootstrap-путях ниже.
INSERT INTO organization_products (org_id, product)
SELECT o.id, p.product
FROM orgs o
CROSS JOIN (VALUES ('menu'), ('online_orders'), ('reservations'), ('pos')) AS p(product)
ON CONFLICT (org_id, product) DO NOTHING;

-- ── bootstrap_org: device-онбординг сеет все модули ──────────
-- Тело 044 дословно + INSERT в organization_products.
CREATE OR REPLACE FUNCTION bootstrap_org(
  p_org_name      TEXT,
  p_location_name TEXT,
  p_owner_name    TEXT,
  p_owner_pin     TEXT,
  p_business_address TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_org UUID;
  v_loc UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = v_uid AND raw_app_meta_data ? 'org_id'
  ) THEN
    RAISE EXCEPTION 'org already bootstrapped for this account';
  END IF;
  IF p_owner_pin !~ '^\d{4,8}$' THEN
    RAISE EXCEPTION 'PIN must be 4-8 digits';
  END IF;

  INSERT INTO orgs (name) VALUES (p_org_name) RETURNING id INTO v_org;
  INSERT INTO locations (org_id, name, receipt_business_name, receipt_address)
    VALUES (v_org, p_location_name,
            NULLIF(TRIM(p_org_name), ''), NULLIF(TRIM(p_business_address), ''))
    RETURNING id INTO v_loc;
  INSERT INTO staff (org_id, location_id, name, role, pin_hash)
    VALUES (v_org, NULL, p_owner_name, 'owner', crypt(p_owner_pin, gen_salt('bf')));

  -- POS-онбординг получает полный набор модулей (100): терминал —
  -- флагманский продукт, digital-модули идут в комплекте.
  INSERT INTO organization_products (org_id, product)
  SELECT v_org, m FROM unnest(ARRAY['menu', 'online_orders', 'reservations', 'pos']) m
  ON CONFLICT (org_id, product) DO NOTHING;

  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', v_org, 'location_id', v_loc)
  WHERE id = v_uid;

  RETURN json_build_object('org_id', v_org, 'location_id', v_loc);
END $$;

REVOKE ALL ON FUNCTION bootstrap_org(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bootstrap_org(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ── bootstrap_digital_org: онбординг без PIN и устройства ────
-- Владелец digital-only организации: email/пароль → организация, точка,
-- owner-членство и выбранные модули. Ни staff-строки, ни PIN, ни девайса.
-- Self-serve только digital-модули; `pos` провижионится вручную
-- (устройство, смены и фискальный контур подключаются отдельно).
CREATE OR REPLACE FUNCTION bootstrap_digital_org(
  p_org_name      TEXT,
  p_location_name TEXT,
  p_owner_name    TEXT DEFAULT NULL,
  p_products      TEXT[] DEFAULT ARRAY['menu']
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_email    TEXT;
  v_org      UUID;
  v_loc      UUID;
  v_products TEXT[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = v_uid AND raw_app_meta_data ? 'org_id'
  ) THEN
    RAISE EXCEPTION 'org already bootstrapped for this account';
  END IF;
  IF NULLIF(TRIM(COALESCE(p_org_name, '')), '') IS NULL
     OR NULLIF(TRIM(COALESCE(p_location_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;

  -- Только digital-модули; мусор и 'pos' отбрасываются.
  SELECT COALESCE(array_agg(DISTINCT m), '{}')
  INTO v_products
  FROM unnest(p_products) m
  WHERE m IN ('menu', 'online_orders', 'reservations');
  IF array_length(v_products, 1) IS NULL THEN
    RAISE EXCEPTION 'invalid_products';
  END IF;

  INSERT INTO orgs (name) VALUES (TRIM(p_org_name)) RETURNING id INTO v_org;
  INSERT INTO locations (org_id, name, receipt_business_name)
    VALUES (v_org, TRIM(p_location_name), NULLIF(TRIM(p_org_name), ''))
    RETURNING id INTO v_loc;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  INSERT INTO organization_members (org_id, auth_user_id, role, display_name)
  VALUES (
    v_org, v_uid, 'owner',
    COALESCE(
      NULLIF(TRIM(COALESCE(p_owner_name, '')), ''),
      NULLIF(split_part(COALESCE(v_email, ''), '@', 1), ''),
      'Owner'
    )
  );

  INSERT INTO organization_products (org_id, product)
  SELECT v_org, unnest(v_products);

  -- ТОЛЬКО org_id: location_id в JWT — семантика устройства POS.
  -- Веб-идентичность адресует точку параметром (assert_backoffice_location).
  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', v_org)
  WHERE id = v_uid;

  RETURN json_build_object(
    'org_id', v_org,
    'location_id', v_loc,
    'products', to_jsonb(v_products)
  );
END $$;

REVOKE ALL ON FUNCTION bootstrap_digital_org(TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bootstrap_digital_org(TEXT, TEXT, TEXT, TEXT[]) TO authenticated, service_role;

-- ============================================================
-- submit_online_order: модуль online_orders обязателен.
-- Тело 099 дословно; добавлена ТОЛЬКО проверка модуля сразу после
-- загрузки точки (до settings-тумблеров и проверки смены).
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
-- submit_reservation: модуль reservations обязателен.
-- Тело 072 дословно; добавлена ТОЛЬКО проверка модуля сразу после
-- загрузки точки — ДО settings-тумблера `enabled`.
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

  -- Модуль организации (100): без reservations бронь не принимается.
  -- ДО settings-тумблера: module_disabled ≠ disabled.
  IF NOT org_has_product(v_loc.org_id, 'reservations') THEN
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

-- ============================================================
-- get_backoffice_context: + products (аддитивно, сигнатура прежняя).
-- Тело 088 дословно + ключ `products` в payload.
-- ============================================================
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
    'products', COALESCE((
      SELECT jsonb_agg(p.product ORDER BY p.product)
      FROM organization_products p
      WHERE p.org_id = o.id AND p.is_active
    ), '[]'::JSONB),
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

COMMENT ON TABLE organization_products IS
  'Продуктовые модули организации (menu/online_orders/reservations/pos); server-enforced entitlements, провижионинг оператором (MVP).';
COMMENT ON FUNCTION org_has_product(UUID, TEXT) IS
  'Единая серверная проверка модуля организации; публичные мутации падают module_disabled без активного модуля.';
COMMENT ON FUNCTION bootstrap_digital_org(TEXT, TEXT, TEXT, TEXT[]) IS
  'Digital-only онбординг: организация, точка, owner-членство и модули без PIN, staff и устройства; в JWT пишется только org_id.';
