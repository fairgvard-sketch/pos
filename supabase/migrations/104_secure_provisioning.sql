-- ============================================================
-- 104 SECURE PROVISIONING — коммерческие entitlement'ы выдаёт только
-- оператор/service_role; онбординги больше не раздают продукты
-- (Phase 2 плана product separation).
--
-- Проблемы, которые закрываются:
--   * bootstrap_org дарил все четыре продукта каждому новому device-аккаунту:
--     любой авторизованный браузерный пользователь мог получить «бесплатный
--     POS» + все digital-модули, просто пройдя онбординг устройства;
--   * bootstrap_digital_org доверял массиву p_products из браузера и
--     активировал перечисленное бесплатно.
--
-- Новая модель (MVP до биллинга):
--   1) Онбординг создаёт организацию/точку/идентичности, но НЕ entitlement'ы.
--      Выбор клиента сохраняется как заявка на активацию
--      (product_activation_requests) — интерес, а не доступ.
--   2) Выдача/приостановка продукта — ТОЛЬКО grant_org_product /
--      revoke_org_product под service_role (SQL Editor / операторский
--      скрипт). Клиентские роли не могут писать в organization_products
--      ни напрямую (грантов нет с 100), ни через RPC.
--   3) request_product_activation — владелец/менеджер кабинета просит
--      подключить продукт (первый или add-on). Заявка видна оператору,
--      доступ не открывает.
--   4) attach_device_to_org — операторский помощник апгрейда
--      digital → POS: привязывает НОВЫЙ device-аккаунт к СУЩЕСТВУЮЩЕЙ
--      организации (вторая организация не создаётся, каталог/точки/брони
--      переиспользуются). Только service_role.
--
-- Организация без активного продукта — валидное состояние: кабинет
-- показывает «Choose a product / Pending activation» (Phase 4), POS
-- блокируется capability-гейтами (Phases 3/5). Данные не удаляются.
-- Триал сознательно НЕ включается: политика триала не утверждена.
--
-- Существующие организации не затронуты: их entitlement'ы выданы
-- бэкфиллом 100 и остаются активными.
--
-- ⚠️ ТРЕБУЕТ 103 (product_catalog, lifecycle, org_has_product v2).
-- ============================================================

-- ── Заявки на активацию продукта ─────────────────────────────
CREATE TABLE IF NOT EXISTS product_activation_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  product      TEXT NOT NULL REFERENCES product_catalog(key),
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, product)
);

CREATE INDEX IF NOT EXISTS idx_product_activation_requests_org
  ON product_activation_requests(org_id);

ALTER TABLE product_activation_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_activation_requests_select_own_org
  ON product_activation_requests
  FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

-- Запись — только через SECURITY DEFINER RPC и оператора: заявка
-- фиксирует интерес, но не является entitlement'ом.
REVOKE ALL ON product_activation_requests FROM anon, authenticated, public;
GRANT SELECT ON product_activation_requests TO authenticated;
GRANT ALL ON product_activation_requests TO service_role;

-- ── bootstrap_org: устройство/организация БЕЗ entitlement'ов ─
-- Тело 100 дословно; вместо выдачи всех продуктов — заявка на 'pos'
-- (клиент пришёл за кассой; оператор активирует после продажи).
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

  -- Провижионинг отделён от настройки устройства (104): онбординг не
  -- выдаёт продукты. Фиксируем интерес — оператор активирует 'pos'
  -- по факту продажи (grant_org_product).
  INSERT INTO product_activation_requests (org_id, product, requested_by)
  VALUES (v_org, 'pos', v_uid)
  ON CONFLICT (org_id, product) DO NOTHING;

  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', v_org, 'location_id', v_loc)
  WHERE id = v_uid;

  RETURN json_build_object('org_id', v_org, 'location_id', v_loc);
END $$;

REVOKE ALL ON FUNCTION bootstrap_org(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bootstrap_org(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ── bootstrap_digital_org: p_products — интерес, не доступ ───
-- Тело 100 дословно; INSERT в organization_products заменён заявками.
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

  -- Браузерный список продуктов — заявка на активацию, НЕ entitlement
  -- (104): доступ откроет только оператор через grant_org_product.
  INSERT INTO product_activation_requests (org_id, product, requested_by)
  SELECT v_org, unnest(v_products), v_uid;

  -- ТОЛЬКО org_id: location_id в JWT — семантика устройства POS.
  -- Веб-идентичность адресует точку параметром (assert_backoffice_location).
  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', v_org)
  WHERE id = v_uid;

  RETURN json_build_object(
    'org_id', v_org,
    'location_id', v_loc,
    'requested_products', to_jsonb(v_products)
  );
END $$;

REVOKE ALL ON FUNCTION bootstrap_digital_org(TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bootstrap_digital_org(TEXT, TEXT, TEXT, TEXT[]) TO authenticated, service_role;

-- ── Заявка на подключение продукта из кабинета ───────────────
-- Владелец/менеджер просит первый продукт или add-on. Доступ не
-- открывается: карточка в кабинете переходит в Pending activation.
CREATE OR REPLACE FUNCTION request_product_activation(p_product TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF auth_backoffice_role() IS NULL
     OR auth_backoffice_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM product_catalog WHERE key = p_product AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_product';
  END IF;
  IF org_has_product(v_org, p_product) THEN
    RETURN json_build_object('product', p_product, 'status', 'already_active');
  END IF;

  INSERT INTO product_activation_requests (org_id, product, requested_by)
  VALUES (v_org, p_product, auth.uid())
  ON CONFLICT (org_id, product) DO UPDATE SET
    status = 'pending',
    requested_by = EXCLUDED.requested_by,
    updated_at = NOW();

  RETURN json_build_object('product', p_product, 'status', 'pending');
END $$;

REVOKE ALL ON FUNCTION request_product_activation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_product_activation(TEXT) TO authenticated, service_role;

-- ── Операторская выдача продукта ─────────────────────────────
-- ТОЛЬКО service_role (SQL Editor / операторский скрипт). Продажа,
-- триал и апгрейд оформляются этой функцией; клиентского пути нет.
CREATE OR REPLACE FUNCTION grant_org_product(
  p_org        UUID,
  p_product    TEXT,
  p_status     TEXT DEFAULT 'active',
  p_source     TEXT DEFAULT 'manual',
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_note       TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = p_org) THEN
    RAISE EXCEPTION 'invalid_org';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM product_catalog WHERE key = p_product AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_product';
  END IF;
  IF p_status NOT IN ('active', 'trialing') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  -- Строки source='developer' защищены триггером 103: их изменение
  -- требует SET LOCAL app.allow_developer_grant_change = 'on'.
  INSERT INTO organization_products (org_id, product, is_active, status, source, starts_at, expires_at, metadata)
  VALUES (
    p_org, p_product, TRUE, p_status, p_source, NOW(), p_expires_at,
    CASE WHEN p_note IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('note', LEFT(p_note, 200)) END
  )
  ON CONFLICT (org_id, product) DO UPDATE SET
    is_active  = TRUE,
    status     = EXCLUDED.status,
    source     = EXCLUDED.source,
    expires_at = EXCLUDED.expires_at,
    metadata   = organization_products.metadata || EXCLUDED.metadata,
    updated_at = NOW();

  UPDATE product_activation_requests
  SET status = 'approved', updated_at = NOW()
  WHERE org_id = p_org AND product = p_product AND status = 'pending';

  RETURN json_build_object('org_id', p_org, 'product', p_product, 'status', p_status);
END $$;

REVOKE ALL ON FUNCTION grant_org_product(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION grant_org_product(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT)
  TO service_role;

-- ── Операторская приостановка продукта ───────────────────────
-- Доступ закрывается, данные организации не удаляются; повторный
-- grant_org_product возвращает доступ к сохранённым данным.
CREATE OR REPLACE FUNCTION revoke_org_product(
  p_org     UUID,
  p_product TEXT,
  p_status  TEXT DEFAULT 'suspended',
  p_note    TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_found BOOLEAN;
BEGIN
  IF p_status NOT IN ('suspended', 'expired') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  UPDATE organization_products SET
    status     = p_status,
    metadata   = CASE WHEN p_note IS NULL THEN metadata
                      ELSE metadata || jsonb_build_object('revoke_note', LEFT(p_note, 200)) END,
    updated_at = NOW()
  WHERE org_id = p_org AND product = p_product;
  GET DIAGNOSTICS v_found = ROW_COUNT;
  IF NOT v_found THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  RETURN json_build_object('org_id', p_org, 'product', p_product, 'status', p_status);
END $$;

REVOKE ALL ON FUNCTION revoke_org_product(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_org_product(UUID, TEXT, TEXT, TEXT)
  TO service_role;

-- ── Операторский апгрейд digital → POS ───────────────────────
-- Привязывает НОВЫЙ device-аккаунт (Supabase Auth) к существующей
-- организации: вторая организация не создаётся, каталог/точки/брони
-- переиспользуются. Обычный device-онбординг для апгрейда не подходит —
-- он создаёт новую организацию.
CREATE OR REPLACE FUNCTION attach_device_to_org(
  p_auth_user UUID,
  p_org       UUID,
  p_location  UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = p_org) THEN
    RAISE EXCEPTION 'invalid_org';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM locations WHERE id = p_location AND org_id = p_org
  ) THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = p_auth_user AND raw_app_meta_data ? 'org_id'
  ) THEN
    RAISE EXCEPTION 'org already bootstrapped for this account';
  END IF;

  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('org_id', p_org, 'location_id', p_location)
  WHERE id = p_auth_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_user';
  END IF;

  RETURN json_build_object('auth_user', p_auth_user, 'org_id', p_org, 'location_id', p_location);
END $$;

REVOKE ALL ON FUNCTION attach_device_to_org(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION attach_device_to_org(UUID, UUID, UUID)
  TO service_role;

COMMENT ON TABLE product_activation_requests IS
  'Заявки на активацию продукта: интерес клиента (онбординг/кабинет), НЕ entitlement. Доступ открывает только оператор через grant_org_product.';
COMMENT ON FUNCTION grant_org_product(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) IS
  'Операторская выдача продукта (service_role only): upsert entitlement''а и закрытие pending-заявки. Клиентского пути выдачи не существует.';
COMMENT ON FUNCTION revoke_org_product(UUID, TEXT, TEXT, TEXT) IS
  'Операторская приостановка продукта (service_role only): suspended/expired, данные не удаляются, повторная выдача возвращает доступ.';
COMMENT ON FUNCTION attach_device_to_org(UUID, UUID, UUID) IS
  'Операторский апгрейд digital → POS: привязка нового device-аккаунта к существующей организации без создания второй организации.';
