-- ============================================================
-- 103 PRODUCT & CAPABILITY MODEL — реестр продаваемых продуктов,
-- карта технических возможностей и жизненный цикл entitlement'ов
-- (Phase 1 плана product separation: ANGLE POS / Menu / Orders / Reserve).
--
-- Разделяются четыре понятия:
--   * Продукт    — что покупает клиент (product_catalog);
--   * Capability — что технически разрешает купленный продукт
--                  (product_capabilities);
--   * Entitlement — какие продукты выданы организации
--                  (organization_products + lifecycle);
--   * Операционная настройка — тумблеры владельца в locations.settings
--                  (enabled/paused/hours) — НЕ заменяют entitlement.
--
-- Что делает:
--   1) product_catalog — реестр продуктов: все четыре могут быть и
--      первым standalone-продуктом, и add-on'ом к существующему аккаунту.
--   2) product_capabilities — какая возможность входит в какой продукт.
--      Ключевое: ANGLE Orders включает public_menu БЕЗ отдельной покупки
--      ANGLE Menu; POS даёт catalog_manage, но НЕ public_menu.
--   3) organization_products получает минимальный lifecycle:
--      status (active/trialing/suspended/expired), source
--      (developer/manual/trial/subscription), starts_at/expires_at,
--      metadata. Цены/инвойсы/автопродление сюда сознательно НЕ входят.
--   4) org_has_product учитывает lifecycle: только active/trialing,
--      не истёкший, продукт жив в реестре. Просрочка оценивается в
--      момент запроса — крона нет, данные не удаляются.
--   5) org_has_capability(org, capability) — производная проверка для
--      серверных гейтов фаз 3–5. Неизвестный ключ = FALSE (fail closed).
--   6) orgs.account_type: customer / developer / demo. Тип организации —
--      НЕ runtime-проверка email.
--   7) Seed developer-аккаунта (fairgvard@gmail.com → организация через
--      app_metadata ЛИБО organization_members): account_type='developer',
--      все продукты source='developer', бессрочно. Email используется
--      ТОЛЬКО здесь, one-time; runtime-авторизация — org_id + обычные
--      entitlement-строки. Аккаунт не найден → NOTICE + запрос проверки,
--      никакой «ближайшей» организации не назначается.
--   8) Триггер защиты developer-грантов: клиентские/операторские пути
--      не могут случайно деактивировать или просрочить строку
--      source='developer'. Осознанное изменение — SET LOCAL
--      app.allow_developer_grant_change = 'on' в той же транзакции.
--
-- Провижионинг остаётся ручным (service-role/оператор, Phase 2);
-- клиентские роли по-прежнему имеют только SELECT своей организации.
-- RLS — реальная граница безопасности, capabilities — гейты RPC/Edge.
--
-- ⚠️ ТРЕБУЕТ 100 (organization_products, org_has_product).
-- ============================================================

-- ── Реестр продуктов ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_catalog (
  key            TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  can_be_primary BOOLEAN NOT NULL DEFAULT TRUE,
  can_be_addon   BOOLEAN NOT NULL DEFAULT TRUE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE product_catalog ENABLE ROW LEVEL SECURITY;

-- Глобальный справочник без данных организаций: читают все вошедшие
-- (карточки продуктов в кабинете), пишет только сервер/оператор.
CREATE POLICY product_catalog_select_authenticated
  ON product_catalog FOR SELECT TO authenticated USING (TRUE);

REVOKE ALL ON product_catalog FROM anon, authenticated, public;
GRANT SELECT ON product_catalog TO authenticated;
GRANT ALL ON product_catalog TO service_role;

INSERT INTO product_catalog (key, display_name, can_be_primary, can_be_addon, is_active, sort_order) VALUES
  ('pos',           'ANGLE POS',     TRUE, TRUE, TRUE, 10),
  ('menu',          'ANGLE Menu',    TRUE, TRUE, TRUE, 20),
  ('online_orders', 'ANGLE Orders',  TRUE, TRUE, TRUE, 30),
  ('reservations',  'ANGLE Reserve', TRUE, TRUE, TRUE, 40)
ON CONFLICT (key) DO NOTHING;

-- ── Карта возможностей ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_capabilities (
  product    TEXT NOT NULL REFERENCES product_catalog(key) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  PRIMARY KEY (product, capability)
);

ALTER TABLE product_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_capabilities_select_authenticated
  ON product_capabilities FOR SELECT TO authenticated USING (TRUE);

REVOKE ALL ON product_capabilities FROM anon, authenticated, public;
GRANT SELECT ON product_capabilities TO authenticated;
GRANT ALL ON product_capabilities TO service_role;

-- Capability-ключи (стабильные, фазы 3–5 гейтят по ним):
--   catalog_manage       управление каталогом (POS-каталог = QR-каталог)
--   public_menu          публичная QR-витрина меню
--   online_orders        корзина и приём гостевых заказов
--   orders_desk          веб-инбокс заказов в кабинете
--   public_reservations  публичная страница бронирования
--   reservations_desk    веб-стол хостес и настройки брони
--   pos_operate          работа кассы: смены, продажи, чеки
--   pos_reports          POS-отчёты (X/Z, sales_report)
INSERT INTO product_capabilities (product, capability) VALUES
  ('pos',           'catalog_manage'),
  ('pos',           'pos_operate'),
  ('pos',           'pos_reports'),
  ('menu',          'catalog_manage'),
  ('menu',          'public_menu'),
  ('online_orders', 'catalog_manage'),
  ('online_orders', 'public_menu'),
  ('online_orders', 'online_orders'),
  ('online_orders', 'orders_desk'),
  ('reservations',  'public_reservations'),
  ('reservations',  'reservations_desk')
ON CONFLICT DO NOTHING;

-- ── Lifecycle entitlement'а ──────────────────────────────────
ALTER TABLE organization_products
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'trialing', 'suspended', 'expired')),
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('developer', 'manual', 'trial', 'subscription')),
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Список допустимых продуктов теперь задаёт реестр, а не встроенный CHECK:
-- новый продукт добавляется строкой каталога, без ALTER TABLE.
ALTER TABLE organization_products
  DROP CONSTRAINT IF EXISTS organization_products_product_check;
ALTER TABLE organization_products
  ADD CONSTRAINT organization_products_product_fkey
  FOREIGN KEY (product) REFERENCES product_catalog(key);

-- ── org_has_product v2: lifecycle учитывается в момент запроса ─
-- Прямая проверка выданного продукта (совместимая сигнатура 100).
-- Fail closed: неизвестный ключ, неактивный в реестре продукт,
-- suspended/expired или истёкший по времени entitlement дают FALSE.
CREATE OR REPLACE FUNCTION org_has_product(p_org UUID, p_product TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_products op
    JOIN product_catalog pc ON pc.key = op.product AND pc.is_active
    WHERE op.org_id = p_org
      AND op.product = p_product
      AND op.is_active
      AND op.status IN ('active', 'trialing')
      AND op.starts_at <= NOW()
      AND (op.expires_at IS NULL OR op.expires_at > NOW())
  )
$$;

REVOKE ALL ON FUNCTION org_has_product(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION org_has_product(UUID, TEXT) TO authenticated, service_role;

-- ── org_has_capability: производная проверка для гейтов ──────
CREATE OR REPLACE FUNCTION org_has_capability(p_org UUID, p_capability TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_products op
    JOIN product_catalog pc ON pc.key = op.product AND pc.is_active
    JOIN product_capabilities cap ON cap.product = op.product
    WHERE op.org_id = p_org
      AND cap.capability = p_capability
      AND op.is_active
      AND op.status IN ('active', 'trialing')
      AND op.starts_at <= NOW()
      AND (op.expires_at IS NULL OR op.expires_at > NOW())
  )
$$;

REVOKE ALL ON FUNCTION org_has_capability(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION org_has_capability(UUID, TEXT) TO authenticated, service_role;

-- ── Тип аккаунта организации ─────────────────────────────────
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'customer'
    CHECK (account_type IN ('customer', 'developer', 'demo'));

-- ── Защита developer-грантов ─────────────────────────────────
-- Строка source='developer' не деактивируется, не просрочивается и не
-- удаляется обычными путями записи (включая будущие клиентские RPC и
-- операторские скрипты «выключить всё»). Осознанное изменение:
--   SET LOCAL app.allow_developer_grant_change = 'on';
CREATE OR REPLACE FUNCTION protect_developer_entitlements()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('app.allow_developer_grant_change', TRUE), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'developer_grant_protected';
  END IF;
  IF NEW.is_active   IS DISTINCT FROM OLD.is_active
     OR NEW.status     IS DISTINCT FROM OLD.status
     OR NEW.source     IS DISTINCT FROM OLD.source
     OR NEW.starts_at  IS DISTINCT FROM OLD.starts_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'developer_grant_protected';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS organization_products_protect_developer ON organization_products;
CREATE TRIGGER organization_products_protect_developer
  BEFORE UPDATE OR DELETE ON organization_products
  FOR EACH ROW
  WHEN (OLD.source = 'developer')
  EXECUTE FUNCTION protect_developer_entitlements();

-- ── Seed developer-аккаунта ──────────────────────────────────
-- Email используется единожды для резолва организации; runtime ничего
-- про email не знает. Организация ищется и через JWT app_metadata, и
-- через organization_members: аккаунт мог появиться любым из двух путей.
DO $$
DECLARE
  v_uid UUID;
  v_org UUID;
BEGIN
  SELECT id INTO v_uid
  FROM auth.users
  WHERE LOWER(email) = 'fairgvard@gmail.com'
  ORDER BY created_at
  LIMIT 1;

  IF v_uid IS NULL THEN
    RAISE NOTICE '103: developer-аккаунт fairgvard@gmail.com не найден — seed пропущен (локальный стек/CI: это норма). Проверка на целевой базе: SELECT u.id, u.email, u.raw_app_meta_data->>''org_id'' AS jwt_org, m.org_id AS member_org FROM auth.users u LEFT JOIN organization_members m ON m.auth_user_id = u.id AND m.is_active WHERE LOWER(u.email) = ''fairgvard@gmail.com'';';
    RETURN;
  END IF;

  SELECT (raw_app_meta_data ->> 'org_id')::UUID INTO v_org
  FROM auth.users WHERE id = v_uid;

  IF v_org IS NULL THEN
    SELECT org_id INTO v_org
    FROM organization_members
    WHERE auth_user_id = v_uid AND is_active
    ORDER BY created_at
    LIMIT 1;
  END IF;

  IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM orgs WHERE id = v_org) THEN
    RAISE NOTICE '103: у fairgvard@gmail.com не найдена организация — seed пропущен, НИКАКАЯ другая организация не назначена. Резолвните вручную и выдайте гранты по процедуре из docs/standalone-products.md.';
    RETURN;
  END IF;

  UPDATE orgs SET account_type = 'developer' WHERE id = v_org;

  -- Триггер защиты уже стоит; это осознанная запись developer-грантов.
  PERFORM set_config('app.allow_developer_grant_change', 'on', TRUE);

  INSERT INTO organization_products (org_id, product, is_active, status, source, starts_at, expires_at)
  SELECT v_org, pc.key, TRUE, 'active', 'developer', NOW(), NULL
  FROM product_catalog pc
  ON CONFLICT (org_id, product) DO UPDATE SET
    is_active  = TRUE,
    status     = 'active',
    source     = 'developer',
    expires_at = NULL,
    updated_at = NOW();

  RAISE NOTICE '103: организация % помечена developer, все продукты выданы бессрочно (source=developer).', v_org;
END $$;

COMMENT ON TABLE product_catalog IS
  'Реестр продаваемых продуктов ANGLE: каждый может быть первым standalone-продуктом и add-on''ом. Активность в реестре гасит entitlement''ы продукта целиком (fail closed).';
COMMENT ON TABLE product_capabilities IS
  'Какая техническая возможность входит в какой продукт. Orders включает public_menu без покупки Menu; POS даёт catalog_manage, но не public_menu.';
COMMENT ON FUNCTION org_has_capability(UUID, TEXT) IS
  'Эффективная возможность организации: производится из active/trialing, не истёкших entitlement''ов живых продуктов реестра. Неизвестный ключ = FALSE.';
COMMENT ON FUNCTION protect_developer_entitlements() IS
  'Гранты source=developer не деактивируются/не просрочиваются обычными путями записи; осознанный обход — SET LOCAL app.allow_developer_grant_change = ''on''.';
COMMENT ON COLUMN orgs.account_type IS
  'customer / developer / demo. Runtime-авторизация опирается на тип организации и entitlement-строки, а не на email.';
