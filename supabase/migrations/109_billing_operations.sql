-- ============================================================
-- 109 BILLING OPERATIONS — состояние подписки для UI, операторские
-- RPC выдачи/оплаты и sandbox-переходы (Phase 7, часть 2).
--
-- Разделение доверия — как в 104:
--   * org_billing_state    — ЧТЕНИЕ своей организации (кабинет + POS).
--     Читает кто угодно вошедший в свою org; денег не двигает.
--   * start_trial / grant_subscription / issue_invoice /
--     mark_invoice_paid / cancel_subscription — ТОЛЬКО service_role.
--     Оплата не может быть инициирована из браузера: сумма берётся из
--     БД, а не из тела запроса (урок cardcom-plan.md P9).
--   * billing_sandbox_advance — операторский помощник тестирования:
--     двигает время подписки, чтобы прогнать trial → past_due →
--     suspended без ожидания реальных дат. Требует включённого флага
--     app.billing_sandbox И account_type IN ('developer','demo'):
--     на боевой организации не сработает даже под service_role.
--
-- Формы ввода карты в системе НЕТ. ManualProvider: счёт → банковский
-- перевод → оператор отмечает оплату. Эквайринг подключается заменой
-- provider у счёта и webhook'ом, UI кабинета не меняется.
--
-- ⚠️ ТРЕБУЕТ 108.
-- ============================================================

-- ── Номер счёта: ANGLE-2026-000042 ───────────────────────────
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;

CREATE OR REPLACE FUNCTION next_invoice_number()
RETURNS TEXT
LANGUAGE sql VOLATILE SET search_path = public AS $$
  SELECT 'ANGLE-' || TO_CHAR(NOW(), 'YYYY') || '-'
         || LPAD(NEXTVAL('invoice_number_seq')::TEXT, 6, '0')
$$;

REVOKE ALL ON FUNCTION next_invoice_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION next_invoice_number() TO service_role;

-- ── Состояние биллинга организации (для UI) ──────────────────
-- Возвращает не булево, а всё, что нужно экрану: статус, даты, дни до
-- конца, есть ли неоплаченный счёт. Попутно лениво переоценивает
-- просрочку (крона нет — 108 refresh_subscription_status).
--
-- p_location: NULL → берётся auth_location_id() (POS знает свою точку),
-- иначе точка передаётся явно (кабинет владельца).
CREATE OR REPLACE FUNCTION org_billing_state(
  p_location UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := COALESCE(p_location, auth_location_id());
  v_res JSONB;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT jsonb_build_object(
    'org_id',      v_org,
    'location_id', v_loc,
    'products',    COALESCE(products.arr, '[]'::jsonb),
    'open_invoice', open_inv.obj,
    -- Дни до ближайшего события по всей организации: этим POS решает,
    -- показывать ли плашку.
    'min_days_left', products.min_days
  )
  INTO v_res
  FROM (
    SELECT
      jsonb_agg(p.obj ORDER BY p.sort_order) AS arr,
      MIN(p.days_left) FILTER (WHERE p.days_left IS NOT NULL) AS min_days
    FROM (
      SELECT
        pc.sort_order,
        CASE
          WHEN s.current_period_end IS NULL THEN NULL
          ELSE GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (
              COALESCE(subscription_access_until(s.*), NOW()) - NOW()
            )) / 86400)::INT
          )
        END AS days_left,
        jsonb_build_object(
          'product',       pc.key,
          'display_name',  pc.display_name,
          'location_id',   s.location_id,
          'location_name', l.name,
          -- effective: что видит пользователь. paid_until истёк, но
          -- grace идёт → 'grace'.
          'state', CASE
            WHEN s.id IS NULL THEN 'none'
            WHEN s.status = 'trialing'  THEN 'trial'
            WHEN s.status = 'past_due'  THEN 'grace'
            WHEN s.status = 'active'    THEN 'active'
            WHEN s.status = 'suspended' THEN 'suspended'
            WHEN s.status = 'canceled'  THEN 'canceled'
          END,
          'paid_until',   s.current_period_end,
          'access_until', subscription_access_until(s.*),
          'grace_days',   s.grace_days,
          'price_agorot', s.unit_price_agorot,
          'billing_unit', s.billing_unit,
          'provider',     s.provider
        ) AS obj
      FROM product_catalog pc
      JOIN subscriptions s
        ON s.product = pc.key
       AND s.org_id  = v_org
       AND (v_loc IS NULL OR s.location_id IS NULL OR s.location_id = v_loc)
      LEFT JOIN locations l ON l.id = s.location_id
      WHERE pc.is_active
    ) p
  ) products
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'id',           i.id,
      'number',       i.number,
      'total_agorot', i.total_agorot,
      'due_at',       i.due_at,
      'status',       i.status
    ) AS obj
    FROM invoices i
    WHERE i.org_id = v_org AND i.status IN ('open', 'processing')
    ORDER BY i.due_at NULLS LAST, i.created_at
    LIMIT 1
  ) open_inv ON TRUE;

  RETURN COALESCE(v_res, jsonb_build_object(
    'org_id', v_org, 'location_id', v_loc,
    'products', '[]'::jsonb, 'open_invoice', NULL, 'min_days_left', NULL
  ));
END $$;

REVOKE ALL ON FUNCTION org_billing_state(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION org_billing_state(UUID) TO authenticated, service_role;

-- Ленивая переоценка просрочки по организации. STABLE-функция
-- org_billing_state писать не может, поэтому переходы выполняет
-- отдельный VOLATILE вызов: фронт дёргает его при старте, оператор — из
-- скрипта. Забыть его не страшно: гейты 108 сравнивают время сами.
CREATE OR REPLACE FUNCTION refresh_org_subscriptions()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_id  UUID;
  v_n   INT := 0;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  FOR v_id IN
    SELECT id FROM subscriptions
    WHERE org_id = v_org
      AND status IN ('trialing', 'active', 'past_due')
      AND current_period_end IS NOT NULL
      AND current_period_end < NOW()
  LOOP
    PERFORM refresh_subscription_status(v_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION refresh_org_subscriptions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION refresh_org_subscriptions() TO authenticated, service_role;

-- ── Операторские RPC (service_role) ──────────────────────────

-- Запуск триала на точку. Идемпотентен: повторный вызов для той же
-- (org, product, точка) не продлевает триал второй раз.
CREATE OR REPLACE FUNCTION start_trial(
  p_org        UUID,
  p_product    TEXT,
  p_location   UUID,
  p_days       INT DEFAULT 14,
  p_grace_days INT DEFAULT 7
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_price product_prices;
  v_sub   subscriptions;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM product_catalog WHERE key = p_product AND is_active) THEN
    RAISE EXCEPTION 'invalid_product';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = p_location AND org_id = p_org) THEN
    RAISE EXCEPTION 'location_not_in_org';
  END IF;

  SELECT * INTO v_sub FROM subscriptions
  WHERE org_id = p_org AND product = p_product AND location_id = p_location;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'subscription_id', v_sub.id, 'status', v_sub.status, 'created', FALSE
    );
  END IF;

  v_price := current_product_price(p_product, 'monthly');

  INSERT INTO subscriptions (
    org_id, product, location_id, status, unit_price_agorot, billing_unit,
    current_period_end, trial_ends_at, grace_days, provider
  ) VALUES (
    p_org, p_product, p_location, 'trialing',
    COALESCE(v_price.amount_agorot, 0), 'location',
    NOW() + (p_days || ' days')::INTERVAL,
    NOW() + (p_days || ' days')::INTERVAL,
    p_grace_days, 'manual'
  ) RETURNING * INTO v_sub;

  INSERT INTO subscription_events
    (org_id, subscription_id, event, to_status, actor, payload)
  VALUES (p_org, v_sub.id, 'trial_started', 'trialing', 'operator',
          jsonb_build_object('days', p_days, 'location_id', p_location));

  -- Заявка на активацию закрыта: клиент получил доступ.
  UPDATE product_activation_requests
  SET status = 'approved', updated_at = NOW()
  WHERE org_id = p_org AND product = p_product AND status = 'pending';

  PERFORM sync_entitlement_from_subscription(v_sub.id);

  RETURN jsonb_build_object(
    'subscription_id', v_sub.id, 'status', 'trialing', 'created', TRUE,
    'trial_ends_at', v_sub.trial_ends_at
  );
END $$;

REVOKE ALL ON FUNCTION start_trial(UUID, TEXT, UUID, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION start_trial(UUID, TEXT, UUID, INT, INT) TO service_role;

-- Платная подписка/продление на точку. p_months продлевает от текущего
-- конца периода (не «съедает» остаток оплаченного).
CREATE OR REPLACE FUNCTION grant_subscription(
  p_org      UUID,
  p_product  TEXT,
  p_location UUID,
  p_months   INT DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_price product_prices;
  v_sub   subscriptions;
  v_from  TIMESTAMPTZ;
  v_prev  TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM product_catalog WHERE key = p_product AND is_active) THEN
    RAISE EXCEPTION 'invalid_product';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = p_location AND org_id = p_org) THEN
    RAISE EXCEPTION 'location_not_in_org';
  END IF;
  IF p_months < 1 THEN RAISE EXCEPTION 'invalid_months'; END IF;

  v_price := current_product_price(p_product, 'monthly');

  SELECT * INTO v_sub FROM subscriptions
  WHERE org_id = p_org AND product = p_product AND location_id = p_location
  FOR UPDATE;

  IF FOUND THEN
    v_prev := v_sub.status;
    -- Продление от большего из «сейчас» и «конца оплаченного периода».
    v_from := GREATEST(NOW(), COALESCE(v_sub.current_period_end, NOW()));
    UPDATE subscriptions SET
      status             = 'active',
      current_period_end = v_from + (p_months || ' months')::INTERVAL,
      unit_price_agorot  = COALESCE(v_price.amount_agorot, v_sub.unit_price_agorot),
      canceled_at        = NULL,
      updated_at         = NOW()
    WHERE id = v_sub.id
    RETURNING * INTO v_sub;
  ELSE
    v_prev := NULL;
    INSERT INTO subscriptions (
      org_id, product, location_id, status, unit_price_agorot, billing_unit,
      current_period_end, provider
    ) VALUES (
      p_org, p_product, p_location, 'active',
      COALESCE(v_price.amount_agorot, 0), 'location',
      NOW() + (p_months || ' months')::INTERVAL, 'manual'
    ) RETURNING * INTO v_sub;
  END IF;

  INSERT INTO subscription_events
    (org_id, subscription_id, event, from_status, to_status, actor, payload)
  VALUES (p_org, v_sub.id, 'subscription_granted', v_prev, 'active', 'operator',
          jsonb_build_object('months', p_months, 'location_id', p_location));

  UPDATE product_activation_requests
  SET status = 'approved', updated_at = NOW()
  WHERE org_id = p_org AND product = p_product AND status = 'pending';

  PERFORM sync_entitlement_from_subscription(v_sub.id);

  RETURN jsonb_build_object(
    'subscription_id', v_sub.id, 'status', 'active',
    'paid_until', v_sub.current_period_end
  );
END $$;

REVOKE ALL ON FUNCTION grant_subscription(UUID, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION grant_subscription(UUID, TEXT, UUID, INT) TO service_role;

-- Счёт за период по всем живым подпискам организации. Одна строка на
-- (продукт, точка), скидка за связку применяется, если в той же точке
-- уже оплачен bundle_with. Суммы считаются в БД (не приходят с клиента).
CREATE OR REPLACE FUNCTION issue_invoice(
  p_org       UUID,
  p_period_start TIMESTAMPTZ DEFAULT DATE_TRUNC('month', NOW()),
  p_months    INT DEFAULT 1,
  p_due_days  INT DEFAULT 14,
  p_vat_rate  NUMERIC DEFAULT 18.00
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inv      invoices;
  v_number   TEXT;
  v_subtotal INT := 0;
  v_discount INT := 0;
  v_vat      INT;
  v_total    INT;
  r          RECORD;
  v_line_disc INT;
  v_line_tot  INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = p_org) THEN
    RAISE EXCEPTION 'org_not_found';
  END IF;

  v_number := next_invoice_number();

  INSERT INTO invoices (
    org_id, number, status, vat_rate, period_start, period_end, due_at, provider
  ) VALUES (
    p_org, v_number, 'draft', p_vat_rate,
    p_period_start, p_period_start + (p_months || ' months')::INTERVAL,
    NOW() + (p_due_days || ' days')::INTERVAL, 'manual'
  ) RETURNING * INTO v_inv;

  FOR r IN
    SELECT s.id AS sub_id, s.product, s.location_id, s.unit_price_agorot,
           pc.display_name, l.name AS location_name,
           pp.bundle_with, pp.bundle_discount_agorot
    FROM subscriptions s
    JOIN product_catalog pc ON pc.key = s.product
    LEFT JOIN locations l   ON l.id = s.location_id
    LEFT JOIN LATERAL (SELECT * FROM current_product_price(s.product, 'monthly')) pp ON TRUE
    WHERE s.org_id = p_org
      AND s.status IN ('trialing', 'active', 'past_due')
    ORDER BY pc.sort_order, l.name
  LOOP
    -- Скидка за связку: продукт дешевле, если в ТОЙ ЖЕ точке живёт
    -- подписка на bundle_with (обычно POS).
    v_line_disc := 0;
    IF r.bundle_with IS NOT NULL AND r.location_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM subscriptions b
        WHERE b.org_id = p_org AND b.product = r.bundle_with
          AND b.location_id = r.location_id
          AND b.status IN ('trialing', 'active', 'past_due')
      ) THEN
        v_line_disc := LEAST(r.bundle_discount_agorot, r.unit_price_agorot);
      END IF;
    END IF;

    v_line_tot := (r.unit_price_agorot - v_line_disc) * p_months;

    INSERT INTO invoice_lines (
      invoice_id, subscription_id, product, location_id, location_name,
      description, unit_price_agorot, quantity, discount_agorot, line_total_agorot
    ) VALUES (
      v_inv.id, r.sub_id, r.product, r.location_id, r.location_name,
      r.display_name || COALESCE(' — ' || r.location_name, ''),
      r.unit_price_agorot, p_months, v_line_disc * p_months, v_line_tot
    );

    v_subtotal := v_subtotal + r.unit_price_agorot * p_months;
    v_discount := v_discount + v_line_disc * p_months;
  END LOOP;

  IF v_subtotal = 0 THEN
    -- Нечего выставлять: черновик удаляется (триггер immutability
    -- пропускает draft), счёт с нулём в историю не попадает.
    DELETE FROM invoice_lines WHERE invoice_id = v_inv.id;
    DELETE FROM invoices WHERE id = v_inv.id;
    RETURN jsonb_build_object('created', FALSE, 'reason', 'no_active_subscriptions');
  END IF;

  -- НДС от суммы после скидки; агороты целые (инвариант №1).
  v_vat   := ROUND((v_subtotal - v_discount) * p_vat_rate / 100.0);
  v_total := (v_subtotal - v_discount) + v_vat;

  UPDATE invoices SET
    status          = 'open',
    subtotal_agorot = v_subtotal,
    discount_agorot = v_discount,
    vat_agorot      = v_vat,
    total_agorot    = v_total,
    updated_at      = NOW()
  WHERE id = v_inv.id
  RETURNING * INTO v_inv;

  INSERT INTO subscription_events (org_id, invoice_id, event, actor, payload)
  VALUES (p_org, v_inv.id, 'invoice_issued', 'operator',
          jsonb_build_object('number', v_inv.number, 'total_agorot', v_total));

  RETURN jsonb_build_object(
    'created', TRUE, 'invoice_id', v_inv.id, 'number', v_inv.number,
    'subtotal_agorot', v_subtotal, 'discount_agorot', v_discount,
    'vat_agorot', v_vat, 'total_agorot', v_total, 'due_at', v_inv.due_at
  );
END $$;

REVOKE ALL ON FUNCTION issue_invoice(UUID, TIMESTAMPTZ, INT, INT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION issue_invoice(UUID, TIMESTAMPTZ, INT, INT, NUMERIC) TO service_role;

-- Отметка оплаты (ManualProvider). Продлевает подписки, по которым
-- выставлен счёт, на его период. Идемпотентна: повторная отметка
-- уже оплаченного счёта не продлевает второй раз.
CREATE OR REPLACE FUNCTION mark_invoice_paid(
  p_invoice_id UUID,
  p_method     TEXT DEFAULT 'bank_transfer',
  p_reference  TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inv    invoices;
  v_months INT;
  r        RECORD;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;

  IF v_inv.status = 'paid' THEN
    RETURN jsonb_build_object('invoice_id', v_inv.id, 'status', 'paid', 'changed', FALSE);
  END IF;
  IF v_inv.status IN ('void', 'uncollectible') THEN
    RAISE EXCEPTION 'invoice_closed';
  END IF;

  v_months := GREATEST(1, ROUND(EXTRACT(EPOCH FROM (v_inv.period_end - v_inv.period_start)) / 2592000)::INT);

  UPDATE invoices SET
    status         = 'paid',
    paid_at        = NOW(),
    payment_method = p_method,
    provider_ref   = COALESCE(p_reference, provider_ref),
    updated_at     = NOW()
  WHERE id = v_inv.id;

  -- Продлеваем каждую подписку из строк счёта.
  FOR r IN
    SELECT DISTINCT il.subscription_id
    FROM invoice_lines il
    WHERE il.invoice_id = v_inv.id AND il.subscription_id IS NOT NULL
  LOOP
    PERFORM grant_subscription_by_id(r.subscription_id, v_months);
  END LOOP;

  INSERT INTO subscription_events (org_id, invoice_id, event, actor, payload)
  VALUES (v_inv.org_id, v_inv.id, 'invoice_paid', 'operator',
          jsonb_build_object('method', p_method, 'total_agorot', v_inv.total_agorot));

  RETURN jsonb_build_object('invoice_id', v_inv.id, 'status', 'paid', 'changed', TRUE);
END $$;

REVOKE ALL ON FUNCTION mark_invoice_paid(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_invoice_paid(UUID, TEXT, TEXT) TO service_role;

-- Продление конкретной подписки (вспомогательная для mark_invoice_paid).
CREATE OR REPLACE FUNCTION grant_subscription_by_id(
  p_sub_id UUID,
  p_months INT DEFAULT 1
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub  subscriptions;
  v_from TIMESTAMPTZ;
  v_prev TEXT;
BEGIN
  SELECT * INTO v_sub FROM subscriptions WHERE id = p_sub_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  v_prev := v_sub.status;
  v_from := GREATEST(NOW(), COALESCE(v_sub.current_period_end, NOW()));

  UPDATE subscriptions SET
    status             = 'active',
    current_period_end = v_from + (p_months || ' months')::INTERVAL,
    canceled_at        = NULL,
    updated_at         = NOW()
  WHERE id = v_sub.id
  RETURNING * INTO v_sub;

  INSERT INTO subscription_events
    (org_id, subscription_id, event, from_status, to_status, actor, payload)
  VALUES (v_sub.org_id, v_sub.id, 'subscription_renewed', v_prev, 'active', 'operator',
          jsonb_build_object('months', p_months));

  PERFORM sync_entitlement_from_subscription(v_sub.id);
END $$;

REVOKE ALL ON FUNCTION grant_subscription_by_id(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION grant_subscription_by_id(UUID, INT) TO service_role;

-- Отмена подписки. Данные не удаляются: доступ гаснет, повторная
-- выдача возвращает всё как было.
CREATE OR REPLACE FUNCTION cancel_subscription(
  p_sub_id    UUID,
  p_immediate BOOLEAN DEFAULT FALSE,
  p_reason    TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub  subscriptions;
  v_prev TEXT;
BEGIN
  SELECT * INTO v_sub FROM subscriptions WHERE id = p_sub_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_not_found'; END IF;

  v_prev := v_sub.status;

  UPDATE subscriptions SET
    status      = CASE WHEN p_immediate THEN 'canceled' ELSE v_sub.status END,
    canceled_at = CASE WHEN p_immediate THEN NOW() ELSE v_sub.current_period_end END,
    updated_at  = NOW()
  WHERE id = v_sub.id
  RETURNING * INTO v_sub;

  INSERT INTO subscription_events
    (org_id, subscription_id, event, from_status, to_status, actor, payload)
  VALUES (v_sub.org_id, v_sub.id, 'subscription_canceled', v_prev, v_sub.status, 'operator',
          jsonb_build_object('immediate', p_immediate, 'reason', p_reason));

  PERFORM sync_entitlement_from_subscription(v_sub.id);

  RETURN jsonb_build_object(
    'subscription_id', v_sub.id, 'status', v_sub.status,
    'access_until', subscription_access_until(v_sub)
  );
END $$;

REVOKE ALL ON FUNCTION cancel_subscription(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cancel_subscription(UUID, BOOLEAN, TEXT) TO service_role;

-- ── Sandbox: прогон жизненного цикла без ожидания дат ────────
-- Сдвигает период подписки назад на p_days, чтобы проверить переходы
-- trial → grace → suspended и все экраны UI. Двойная защита:
--   * SET LOCAL app.billing_sandbox = 'on' в той же транзакции;
--   * организация должна быть developer/demo.
-- На боевой организации не сработает даже под service_role.
CREATE OR REPLACE FUNCTION billing_sandbox_advance(
  p_sub_id UUID,
  p_days   INT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub  subscriptions;
  v_type TEXT;
BEGIN
  IF COALESCE(current_setting('app.billing_sandbox', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION 'sandbox_disabled: требуется SET LOCAL app.billing_sandbox = ''on''';
  END IF;

  SELECT * INTO v_sub FROM subscriptions WHERE id = p_sub_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_not_found'; END IF;

  SELECT account_type INTO v_type FROM orgs WHERE id = v_sub.org_id;
  IF v_type NOT IN ('developer', 'demo') THEN
    RAISE EXCEPTION 'sandbox_forbidden: организация % не developer/demo', v_sub.org_id;
  END IF;

  UPDATE subscriptions SET
    current_period_end = current_period_end - (p_days || ' days')::INTERVAL,
    trial_ends_at      = trial_ends_at      - (p_days || ' days')::INTERVAL,
    updated_at         = NOW()
  WHERE id = v_sub.id;

  INSERT INTO subscription_events
    (org_id, subscription_id, event, actor, payload)
  VALUES (v_sub.org_id, v_sub.id, 'sandbox_advance', 'sandbox',
          jsonb_build_object('days', p_days));

  RETURN jsonb_build_object(
    'subscription_id', v_sub.id,
    'status', refresh_subscription_status(v_sub.id)
  );
END $$;

REVOKE ALL ON FUNCTION billing_sandbox_advance(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing_sandbox_advance(UUID, INT) TO service_role;

COMMENT ON FUNCTION org_billing_state(UUID) IS
  'Состояние биллинга для UI: статус каждого продукта в точке, оплачено до, дни до конца доступа, открытый счёт. Читает своя организация.';
COMMENT ON FUNCTION start_trial(UUID, TEXT, UUID, INT, INT) IS
  'Запуск триала продукта в точке. Только service_role. Идемпотентен.';
COMMENT ON FUNCTION grant_subscription(UUID, TEXT, UUID, INT) IS
  'Платная подписка/продление на точку. Продлевает от конца оплаченного периода, не съедая остаток. Только service_role.';
COMMENT ON FUNCTION issue_invoice(UUID, TIMESTAMPTZ, INT, INT, NUMERIC) IS
  'Счёт за период по живым подпискам: строка на (продукт, точка), скидка за связку, НДС. Суммы считает БД. Только service_role.';
COMMENT ON FUNCTION mark_invoice_paid(UUID, TEXT, TEXT) IS
  'ManualProvider: оператор отмечает оплату счёта, подписки продлеваются. Идемпотентна. Только service_role.';
COMMENT ON FUNCTION billing_sandbox_advance(UUID, INT) IS
  'Тестовый сдвиг периода для прогона trial→grace→suspended. Требует app.billing_sandbox=on И account_type developer/demo.';
