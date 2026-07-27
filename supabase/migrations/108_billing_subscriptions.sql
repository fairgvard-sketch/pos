-- ============================================================
-- 108 BILLING & SUBSCRIPTIONS — подписки на ТОЧКУ, тарифы, счета,
-- grace-период (Phase 7 плана product separation: коммерциализация).
--
-- Что закрывается:
--   * 104 сознательно не включил триал («политика триала не утверждена») —
--     теперь политика есть: триал + оплата за ТОЧКУ + grace 7 дней;
--   * organization_products.status правился руками, и никто не мог
--     ответить «до какого числа оплачено» и «кому выставлять счёт»;
--   * гейт был бинарным: касса умирала ровно в expires_at без
--     предупреждения — кофейня не открывалась в утренний пик;
--   * entitlement был ТОЛЬКО org-scoped, а продаются точки: клиент
--     берёт POS в двух точках и QR-меню в третьей (киоск без кассы).
--
-- Продуктовые варианты покупки (на точку): POS, POS + QR, QR отдельно.
-- Третий продукт в реестре для связки НЕ заводится: «POS + QR» — это
-- две строки подписки в одной точке. Скидка за связку — bundle_discount
-- в прайсе, а не отдельный SKU (иначе комбинации размножаются).
--
-- Модель:
--   1) product_prices  — прайс: цена продукта в агоротах за точку/мес.
--      Версионируется (effective_from): смена цены не переписывает
--      историю, старые счета остаются с ценой на момент выставления.
--   2) subscriptions   — подписка (org, product, location): цикл,
--      период, trial/grace. location_id NULL = подписка на всю
--      организацию (обратная совместимость и флат-тарифы).
--   3) invoices        — счёт за период: снапшот цены, количества
--      точек, НДС и итога на момент выставления (инвариант №5).
--   4) subscription_events — append-only аудит переходов (инвариант №2).
--
--   organization_products.status становится ПРОИЗВОДНОЙ от подписок:
--   sync_entitlement_from_subscription() пишет её при каждом переходе.
--   Ручная выдача (source='manual'/'developer') не трогается.
--
-- Grace-период:
--   current_period_end — конец ОПЛАЧЕННОГО периода (деньги кончились);
--   access_until       — конец ДОСТУПА = current_period_end + grace_days.
--   В grace подписка имеет status='past_due', а entitlement остаётся
--   живым (status='active') до access_until. Так grace виден в данных,
--   а не размазан прибавлением дней к expires_at.
--
-- Location-scope и обратная совместимость:
--   org_has_capability(org, cap) (103) НЕ меняется — это «есть ли
--   возможность хоть где-то в организации». Добавляется
--   org_has_capability_at(org, location, cap): org-уровневый грант
--   (developer/manual и весь бэкфилл 100) действует во всех точках,
--   location-подписка — только в своей. Существующие организации
--   поведения не меняют.
--
-- Провайдер платежа:
--   Реализован ManualProvider (счёт → банковский перевод → оператор
--   отмечает оплату). Это НЕ эмулятор: так реально работает B2B-биллинг
--   до подключения эквайринга. Место под провайдера — поля
--   provider/provider_ref и статус 'processing'. Формы ввода карты в
--   системе нет и не должно быть: карту вводят на хостируемой странице
--   провайдера (docs/billing.md, docs/cardcom-plan.md).
--
-- ⚠️ ТРЕБУЕТ 103 (lifecycle, capabilities), 104 (заявки), 107.
-- ============================================================

-- ── Прайс: цена за точку в месяц, версионируемая ─────────────
CREATE TABLE IF NOT EXISTS product_prices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product        TEXT NOT NULL REFERENCES product_catalog(key) ON DELETE CASCADE,
  -- Целые агороты: инвариант №1 CLAUDE.md, float для денег запрещён.
  amount_agorot  INTEGER NOT NULL CHECK (amount_agorot >= 0),
  currency       TEXT NOT NULL DEFAULT 'ILS' CHECK (currency = 'ILS'),
  billing_unit   TEXT NOT NULL DEFAULT 'location'
    CHECK (billing_unit IN ('location', 'org')),
  billing_cycle  TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'yearly')),
  -- Скидка в агоротах, если в той же точке уже оплачен POS:
  -- «POS + QR» дешевле, чем QR отдельно, без отдельного SKU.
  bundle_with    TEXT REFERENCES product_catalog(key),
  bundle_discount_agorot INTEGER NOT NULL DEFAULT 0
    CHECK (bundle_discount_agorot >= 0),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product, billing_cycle, effective_from),
  CONSTRAINT product_prices_bundle_pair CHECK (
    (bundle_with IS NULL AND bundle_discount_agorot = 0)
    OR (bundle_with IS NOT NULL)
  ),
  CONSTRAINT product_prices_bundle_not_self CHECK (bundle_with IS DISTINCT FROM product),
  CONSTRAINT product_prices_bundle_le_amount CHECK (bundle_discount_agorot <= amount_agorot)
);

CREATE INDEX IF NOT EXISTS idx_product_prices_lookup
  ON product_prices(product, billing_cycle, effective_from DESC);

ALTER TABLE product_prices ENABLE ROW LEVEL SECURITY;

-- Прайс — публичная информация для вошедших (карточки продуктов
-- в кабинете показывают цену). Пишет только оператор.
CREATE POLICY product_prices_select_authenticated
  ON product_prices FOR SELECT TO authenticated USING (TRUE);

REVOKE ALL ON product_prices FROM anon, authenticated, public;
GRANT SELECT ON product_prices TO authenticated;
GRANT ALL ON product_prices TO service_role;

-- Стартовый прайс. Цены — ПЛЕЙСХОЛДЕРЫ до утверждения владельцем:
-- меняются вставкой строки с более поздним effective_from, UPDATE не
-- нужен (история счетов не должна ехать).
--   POS отдельно        149 ₪/точка
--   QR отдельно          49 ₪/точка
--   POS + QR            149 + (49 − 20) = 178 ₪/точка
INSERT INTO product_prices
  (product, amount_agorot, billing_unit, billing_cycle, bundle_with, bundle_discount_agorot) VALUES
  ('pos',           14900, 'location', 'monthly', NULL,  0),
  ('menu',           4900, 'location', 'monthly', 'pos', 2000),
  ('online_orders',  9900, 'location', 'monthly', 'pos', 3000),
  ('reservations',   9900, 'location', 'monthly', NULL,  0)
ON CONFLICT DO NOTHING;

-- Действующая цена продукта на момент запроса.
CREATE OR REPLACE FUNCTION current_product_price(
  p_product TEXT,
  p_cycle   TEXT DEFAULT 'monthly'
) RETURNS product_prices
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT *
  FROM product_prices
  WHERE product = p_product
    AND billing_cycle = p_cycle
    AND effective_from <= NOW()
  ORDER BY effective_from DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION current_product_price(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION current_product_price(TEXT, TEXT) TO authenticated, service_role;

-- ── Подписки (на точку либо на организацию) ──────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  product            TEXT NOT NULL REFERENCES product_catalog(key),
  -- NULL = подписка уровня организации (флат-тариф, legacy-гранты).
  -- Иначе продукт куплен ИМЕННО для этой точки.
  location_id        UUID REFERENCES locations(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'past_due', 'suspended', 'canceled')),
  billing_cycle      TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'yearly')),
  -- Снапшот цены на момент старта: смена прайса не двигает живые
  -- подписки, пока оператор явно не перевыставит.
  unit_price_agorot  INTEGER NOT NULL CHECK (unit_price_agorot >= 0),
  billing_unit       TEXT NOT NULL DEFAULT 'location'
    CHECK (billing_unit IN ('location', 'org')),
  current_period_end TIMESTAMPTZ,
  trial_ends_at      TIMESTAMPTZ,
  grace_days         INTEGER NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 60),
  canceled_at        TIMESTAMPTZ,
  provider           TEXT NOT NULL DEFAULT 'manual'
    CHECK (provider IN ('manual', 'cardcom')),
  provider_ref       TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscriptions_unit_scope CHECK (
    (billing_unit = 'location' AND location_id IS NOT NULL)
    OR (billing_unit = 'org' AND location_id IS NULL)
  )
);

-- Одна живая подписка на (org, product, точка) и на (org, product) для
-- org-уровня. Партиальные индексы: NULL в UNIQUE не склеивается.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_location
  ON subscriptions(org_id, product, location_id) WHERE location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_org
  ON subscriptions(org_id, product) WHERE location_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_location ON subscriptions(location_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_period
  ON subscriptions(current_period_end) WHERE status IN ('trialing', 'active', 'past_due');

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Организация видит свои подписки (раздел «Подписка» в кабинете).
-- Запись — только service_role через операторские RPC ниже.
CREATE POLICY subscriptions_select_own_org
  ON subscriptions FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

REVOKE ALL ON subscriptions FROM anon, authenticated, public;
GRANT SELECT ON subscriptions TO authenticated;
GRANT ALL ON subscriptions TO service_role;

-- Конец фактического доступа = оплаченный период + grace.
-- Одно определение для гейтов, UI и счётчиков.
CREATE OR REPLACE FUNCTION subscription_access_until(s subscriptions)
RETURNS TIMESTAMPTZ
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN s.status = 'canceled'          THEN s.canceled_at
    WHEN s.current_period_end IS NULL   THEN NULL          -- бессрочная
    ELSE s.current_period_end + (s.grace_days || ' days')::INTERVAL
  END
$$;

-- ── Счета ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Человеческий номер: ANGLE-2026-000042
  number            TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('draft', 'open', 'processing', 'paid', 'void', 'uncollectible')),
  -- Итог по всем строкам (снапшот, инвариант №5).
  subtotal_agorot   INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_agorot >= 0),
  discount_agorot   INTEGER NOT NULL DEFAULT 0 CHECK (discount_agorot >= 0),
  vat_rate          NUMERIC(5,2) NOT NULL DEFAULT 18.00,
  vat_agorot        INTEGER NOT NULL DEFAULT 0 CHECK (vat_agorot >= 0),
  total_agorot      INTEGER NOT NULL DEFAULT 0 CHECK (total_agorot >= 0),
  currency          TEXT NOT NULL DEFAULT 'ILS' CHECK (currency = 'ILS'),
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  due_at            TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  -- bank_transfer/cash — ManualProvider; card — будущий эквайринг;
  -- waived — пилот/компенсация (сумма остаётся в истории).
  payment_method    TEXT CHECK (payment_method IN ('bank_transfer', 'cash', 'card', 'waived')),
  provider          TEXT NOT NULL DEFAULT 'manual'
    CHECK (provider IN ('manual', 'cardcom')),
  provider_ref      TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT invoices_period_order CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_open
  ON invoices(status, due_at) WHERE status IN ('open', 'processing');

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoices_select_own_org
  ON invoices FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

REVOKE ALL ON invoices FROM anon, authenticated, public;
GRANT SELECT ON invoices TO authenticated;
GRANT ALL ON invoices TO service_role;

-- Строка счёта = продукт в конкретной точке. Клиент видит, за что
-- платит: «ANGLE POS — Дизенгоф 100», «ANGLE Menu — Киоск в ТЦ».
CREATE TABLE IF NOT EXISTS invoice_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  subscription_id   UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  product           TEXT NOT NULL REFERENCES product_catalog(key),
  location_id       UUID REFERENCES locations(id) ON DELETE SET NULL,
  -- Название точки снапшотится: переименование не меняет старый счёт.
  location_name     TEXT,
  description       TEXT NOT NULL,
  unit_price_agorot INTEGER NOT NULL CHECK (unit_price_agorot >= 0),
  quantity          INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  discount_agorot   INTEGER NOT NULL DEFAULT 0 CHECK (discount_agorot >= 0),
  line_total_agorot INTEGER NOT NULL CHECK (line_total_agorot >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoice_lines_select_own_org
  ON invoice_lines FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = invoice_lines.invoice_id AND i.org_id = auth_org_id()
  ));

REVOKE ALL ON invoice_lines FROM anon, authenticated, public;
GRANT SELECT ON invoice_lines TO authenticated;
GRANT ALL ON invoice_lines TO service_role;

-- Счета не удаляются и не переписываются (инвариант №2 CLAUDE.md):
-- отмена — status='void', исправление — новый счёт.
CREATE OR REPLACE FUNCTION protect_invoice_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Черновик ещё не документ: issue_invoice удаляет его, если
    -- выставлять нечего. Всё, что выставлено, — только void.
    IF OLD.status = 'draft' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'invoice_immutable: счета не удаляются, используйте status=void';
  END IF;
  IF OLD.status IN ('paid', 'void') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invoice_immutable: счёт % уже закрыт (%)', OLD.number, OLD.status;
  END IF;
  -- Черновик собирается issue_invoice: суммы проставляются переходом
  -- draft → open. Документ фиксируется в момент выставления.
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF NEW.number             IS DISTINCT FROM OLD.number
     OR NEW.total_agorot    IS DISTINCT FROM OLD.total_agorot
     OR NEW.subtotal_agorot IS DISTINCT FROM OLD.subtotal_agorot
     OR NEW.vat_agorot      IS DISTINCT FROM OLD.vat_agorot
     OR NEW.period_start    IS DISTINCT FROM OLD.period_start
     OR NEW.period_end      IS DISTINCT FROM OLD.period_end THEN
    RAISE EXCEPTION 'invoice_immutable: сумма и период счёта % неизменяемы', OLD.number;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS invoices_protect_immutability ON invoices;
CREATE TRIGGER invoices_protect_immutability
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION protect_invoice_immutability();

-- Строки выставленного счёта неизменяемы наравне с самим счётом.
CREATE OR REPLACE FUNCTION protect_invoice_lines_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM invoices
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  -- Черновик ещё собирается; всё остальное — зафиксированный документ.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'invoice_immutable: строки выставленного счёта неизменяемы';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS invoice_lines_protect_immutability ON invoice_lines;
CREATE TRIGGER invoice_lines_protect_immutability
  BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION protect_invoice_lines_immutability();

-- ── Аудит переходов подписки (append-only) ───────────────────
CREATE TABLE IF NOT EXISTS subscription_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  event           TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT,
  actor           TEXT NOT NULL DEFAULT 'system',
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_org
  ON subscription_events(org_id, created_at DESC);

ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_events_select_own_org
  ON subscription_events FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

REVOKE ALL ON subscription_events FROM anon, authenticated, public;
GRANT SELECT ON subscription_events TO authenticated;
GRANT ALL ON subscription_events TO service_role;

CREATE OR REPLACE FUNCTION protect_subscription_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'subscription_events_append_only';
END $$;

DROP TRIGGER IF EXISTS subscription_events_append_only ON subscription_events;
CREATE TRIGGER subscription_events_append_only
  BEFORE UPDATE OR DELETE ON subscription_events
  FOR EACH ROW EXECUTE FUNCTION protect_subscription_events_append_only();

-- ── Location-scoped capability ───────────────────────────────
-- org_has_capability(org, cap) из 103 НЕ меняется: «есть ли возможность
-- хоть где-то в организации» (нужно кабинету и Edge-функциям, которые
-- резолвят точку отдельно). Здесь — точечная проверка:
--   * org-уровневый entitlement (developer, manual, весь бэкфилл 100)
--     действует во ВСЕХ точках организации;
--   * location-подписка — только в своей точке.
CREATE OR REPLACE FUNCTION org_has_capability_at(
  p_org        UUID,
  p_location   UUID,
  p_capability TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    -- 1) org-уровневый грант: подписки на точку нет вовсе
    EXISTS (
      SELECT 1
      FROM organization_products op
      JOIN product_catalog pc      ON pc.key = op.product AND pc.is_active
      JOIN product_capabilities cap ON cap.product = op.product
      WHERE op.org_id = p_org
        AND cap.capability = p_capability
        AND op.is_active
        AND op.status IN ('active', 'trialing')
        AND op.starts_at <= NOW()
        AND (op.expires_at IS NULL OR op.expires_at > NOW())
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.org_id = p_org AND s.product = op.product
            AND s.location_id IS NOT NULL
        )
    )
    -- 2) живая подписка именно на эту точку (доступ до конца grace)
    OR EXISTS (
      SELECT 1
      FROM subscriptions s
      JOIN product_catalog pc       ON pc.key = s.product AND pc.is_active
      JOIN product_capabilities cap ON cap.product = s.product
      WHERE s.org_id = p_org
        AND s.location_id = p_location
        AND cap.capability = p_capability
        AND s.status IN ('trialing', 'active', 'past_due')
        AND (subscription_access_until(s.*) IS NULL
             OR subscription_access_until(s.*) > NOW())
    )
$$;

REVOKE ALL ON FUNCTION org_has_capability_at(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION org_has_capability_at(UUID, UUID, TEXT) TO authenticated, service_role;

-- Гейт текущей точки: POS знает свою точку из JWT (auth_location_id, 001),
-- веб-кабинет передаёт её явно.
CREATE OR REPLACE FUNCTION require_location_capability(
  p_capability TEXT,
  p_location   UUID DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc UUID := COALESCE(p_location, auth_location_id());
BEGIN
  -- Точка неизвестна (веб-идентичность без location в JWT) — падаем на
  -- org-уровень 105: там граница шире, но не слабее RLS.
  IF v_loc IS NULL THEN
    IF NOT org_has_capability(auth_org_id(), p_capability) THEN
      RAISE EXCEPTION 'module_disabled';
    END IF;
    RETURN;
  END IF;
  IF NOT org_has_capability_at(auth_org_id(), v_loc, p_capability) THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
END $$;

REVOKE ALL ON FUNCTION require_location_capability(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION require_location_capability(TEXT, UUID) TO authenticated, service_role;

-- ── Синхронизация entitlement'а из подписок ──────────────────
-- organization_products — агрегат по организации: продукт жив, если
-- жива ХОТЬ ОДНА его подписка. Точечную границу держит
-- org_has_capability_at; org-строка нужна, чтобы гейты 105 и кабинет
-- продолжали работать без переписывания.
-- Ручные и developer-гранты не трогаются.
CREATE OR REPLACE FUNCTION sync_entitlement_from_subscription(p_sub_id UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s            subscriptions;
  v_cur_source TEXT;
  v_status     TEXT;
  v_active     BOOLEAN;
  v_expires    TIMESTAMPTZ;
  v_any_trial  BOOLEAN;
BEGIN
  SELECT * INTO s FROM subscriptions WHERE id = p_sub_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_not_found';
  END IF;

  SELECT source INTO v_cur_source
  FROM organization_products
  WHERE org_id = s.org_id AND product = s.product;

  IF v_cur_source IN ('developer', 'manual') THEN
    RETURN;
  END IF;

  -- Максимальный access_until среди живых подписок продукта в организации:
  -- пока хоть одна точка оплачена, продукт для организации жив.
  SELECT
    MAX(subscription_access_until(x.*)) FILTER (
      WHERE subscription_access_until(x.*) IS NOT NULL
    ),
    BOOL_OR(x.status = 'trialing'),
    BOOL_OR(subscription_access_until(x.*) IS NULL)
  INTO v_expires, v_any_trial, v_active
  FROM subscriptions x
  WHERE x.org_id = s.org_id
    AND x.product = s.product
    AND x.status IN ('trialing', 'active', 'past_due')
    AND (subscription_access_until(x.*) IS NULL
         OR subscription_access_until(x.*) > NOW());

  -- Живых подписок нет — продукт приостановлен (данные не удаляются).
  IF v_expires IS NULL AND NOT COALESCE(v_active, FALSE) THEN
    v_status  := 'suspended';
    v_active  := FALSE;
    v_expires := NULL;
  ELSE
    -- Бессрочная подписка среди живых → expires_at = NULL.
    IF COALESCE(v_active, FALSE) THEN v_expires := NULL; END IF;
    v_status := CASE WHEN COALESCE(v_any_trial, FALSE) THEN 'trialing' ELSE 'active' END;
    v_active := TRUE;
  END IF;

  INSERT INTO organization_products (
    org_id, product, is_active, status, source, starts_at, expires_at
  ) VALUES (
    s.org_id, s.product, v_active, v_status,
    CASE WHEN v_status = 'trialing' THEN 'trial' ELSE 'subscription' END,
    s.created_at, v_expires
  )
  ON CONFLICT (org_id, product) DO UPDATE SET
    is_active  = EXCLUDED.is_active,
    status     = EXCLUDED.status,
    source     = EXCLUDED.source,
    expires_at = EXCLUDED.expires_at,
    updated_at = NOW();
END $$;

REVOKE ALL ON FUNCTION sync_entitlement_from_subscription(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sync_entitlement_from_subscription(UUID) TO service_role;

-- ── Просрочка: ленивая оценка в момент запроса, крона нет ────
-- active → past_due (кончился оплаченный период)
--        → suspended (кончился grace)
CREATE OR REPLACE FUNCTION refresh_subscription_status(p_sub_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s        subscriptions;
  v_new    TEXT;
  v_access TIMESTAMPTZ;
BEGIN
  SELECT * INTO s FROM subscriptions WHERE id = p_sub_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF s.status IN ('suspended', 'canceled') THEN RETURN s.status; END IF;
  IF s.current_period_end IS NULL THEN RETURN s.status; END IF;

  v_access := subscription_access_until(s);

  IF NOW() > v_access THEN
    v_new := 'suspended';
  ELSIF NOW() > s.current_period_end THEN
    v_new := 'past_due';
  ELSE
    RETURN s.status;
  END IF;

  IF v_new = s.status THEN RETURN s.status; END IF;

  UPDATE subscriptions SET status = v_new, updated_at = NOW() WHERE id = s.id;

  INSERT INTO subscription_events
    (org_id, subscription_id, event, from_status, to_status, actor)
  VALUES (s.org_id, s.id,
          CASE WHEN v_new = 'past_due' THEN 'period_ended' ELSE 'grace_ended' END,
          s.status, v_new, 'system');

  PERFORM sync_entitlement_from_subscription(s.id);
  RETURN v_new;
END $$;

REVOKE ALL ON FUNCTION refresh_subscription_status(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION refresh_subscription_status(UUID) TO authenticated, service_role;

COMMENT ON TABLE product_prices IS
  'Прайс ANGLE: цена продукта в агоротах за точку в месяц + скидка за связку (bundle_with). Версионируется effective_from — смена цены не переписывает историю счетов.';
COMMENT ON TABLE subscriptions IS
  'Подписка (org, product, location). location_id NULL = уровень организации. Доступ живёт до current_period_end + grace_days.';
COMMENT ON TABLE invoices IS
  'Счёт за период со снапшотом сумм и НДС. Не удаляется и не переписывается: отмена — void, исправление — новый счёт.';
COMMENT ON TABLE invoice_lines IS
  'Строка счёта = продукт в конкретной точке. Название точки снапшотится: переименование не меняет выставленный счёт.';
COMMENT ON TABLE subscription_events IS
  'Append-only аудит переходов подписки: кто, когда и почему изменил коммерческий доступ.';
COMMENT ON FUNCTION org_has_capability_at(UUID, UUID, TEXT) IS
  'Возможность в КОНКРЕТНОЙ точке: org-уровневый грант действует везде, location-подписка — только в своей точке. Fail closed.';
COMMENT ON FUNCTION subscription_access_until(subscriptions) IS
  'Конец фактического доступа: оплаченный период + grace. NULL = бессрочно.';
COMMENT ON FUNCTION refresh_subscription_status(UUID) IS
  'Ленивая оценка просрочки в момент запроса (крона нет): active → past_due → suspended.';
