-- A5: owner checkout for one digital product / location / month.
-- Disabled until an operator explicitly configures the environment and prices.
-- No client RPC confirms payment. The existing service-only payment intake
-- remains the only payment -> subscription transition.
CREATE TABLE billing_checkout_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode TEXT NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'test', 'live')),
  vat_rate NUMERIC(5,2) NOT NULL DEFAULT 18 CHECK (vat_rate BETWEEN 0 AND 100)
);
INSERT INTO billing_checkout_settings DEFAULT VALUES;
ALTER TABLE billing_checkout_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing_checkout_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON billing_checkout_settings TO service_role;

CREATE TABLE subscription_checkout_requests (
  request_id UUID PRIMARY KEY,
  auth_user_id UUID NOT NULL REFERENCES auth.users(id),
  org_id UUID NOT NULL REFERENCES orgs(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  product TEXT NOT NULL REFERENCES product_catalog(key),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX subscription_checkout_lookup ON subscription_checkout_requests(org_id, location_id, product);
ALTER TABLE subscription_checkout_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON subscription_checkout_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON subscription_checkout_requests TO service_role;
CREATE TRIGGER subscription_checkout_append_only BEFORE UPDATE OR DELETE
  ON subscription_checkout_requests FOR EACH ROW EXECUTE FUNCTION protect_subscription_events_append_only();

CREATE FUNCTION billing_owner_org() RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org UUID := auth_org_id();
BEGIN
  -- Current membership, not a role supplied in the token. Lock against a
  -- concurrent revocation until this operation's transaction has finished.
  PERFORM 1 FROM organization_members
    WHERE org_id = v_org AND auth_user_id = auth.uid() AND is_active AND role = 'owner'
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_owner_required'; END IF;
  RETURN v_org;
END $$;
REVOKE ALL ON FUNCTION billing_owner_org() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION get_subscription_checkout(p_invoice_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org UUID := billing_owner_org(); v_invoice invoices; v_mode TEXT;
BEGIN
  SELECT i.* INTO v_invoice FROM invoices i WHERE i.id = p_invoice_id AND i.org_id = v_org;
  SELECT mode INTO v_mode FROM subscription_checkout_requests
    WHERE invoice_id = p_invoice_id AND org_id = v_org LIMIT 1;
  IF v_invoice.id IS NULL OR v_mode IS NULL THEN RAISE EXCEPTION 'checkout_not_found'; END IF;
  RETURN jsonb_build_object(
    'invoice_id', v_invoice.id, 'number', v_invoice.number, 'status', v_invoice.status,
    'mode', v_mode, 'currency', v_invoice.currency, 'subtotal_agorot', v_invoice.subtotal_agorot,
    'discount_agorot', v_invoice.discount_agorot, 'vat_agorot', v_invoice.vat_agorot,
    'total_agorot', v_invoice.total_agorot, 'paid_at', v_invoice.paid_at,
    'lines', (SELECT jsonb_agg(jsonb_build_object(
      'product', il.product, 'location_id', il.location_id, 'location_name', il.location_name,
      'description', il.description, 'months', il.quantity, 'line_total_agorot', il.line_total_agorot,
      'paid_until', s.current_period_end, 'access_until', subscription_access_until(s.*)
    )) FROM invoice_lines il LEFT JOIN subscriptions s ON s.id = il.subscription_id WHERE il.invoice_id = v_invoice.id)
  );
END $$;
REVOKE ALL ON FUNCTION get_subscription_checkout(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_subscription_checkout(UUID) TO authenticated;

CREATE FUNCTION get_subscription_catalog() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org UUID := billing_owner_org(); v_settings billing_checkout_settings;
BEGIN
  SELECT * INTO v_settings FROM billing_checkout_settings WHERE singleton;
  RETURN jsonb_build_object('mode', COALESCE(v_settings.mode, 'disabled'),
    'vat_rate', v_settings.vat_rate,
    'prices', CASE WHEN v_settings.mode IN ('test','live') THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('product', pc.key, 'label', pc.display_name,
        'amount_agorot', pp.amount_agorot, 'currency', pp.currency, 'cycle', 'monthly') ORDER BY pc.sort_order), '[]')
      FROM product_catalog pc JOIN LATERAL current_product_price(pc.key, 'monthly') pp ON pp.id IS NOT NULL
      WHERE pc.is_active AND pc.key IN ('menu','online_orders','reservations') AND pp.billing_unit = 'location'
    ) ELSE '[]'::JSONB END,
    'subscriptions', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'product', s.product, 'location_id', s.location_id, 'paid_until', s.current_period_end,
      'access_until', subscription_access_until(s.*), 'status', CASE
        WHEN s.status IN ('suspended','canceled') THEN s.status
        WHEN subscription_access_until(s.*) <= NOW() THEN 'suspended'
        WHEN s.current_period_end <= NOW() THEN 'past_due' ELSE s.status END
    )), '[]') FROM subscriptions s WHERE s.org_id = v_org),
    'invoices', (SELECT COALESCE(jsonb_agg(x.item ORDER BY x.created_at DESC), '[]') FROM (
      SELECT i.created_at, jsonb_build_object('invoice_id', i.id, 'number', i.number,
        'status', i.status, 'total_agorot', i.total_agorot, 'currency', i.currency) AS item
      FROM invoices i WHERE i.org_id = v_org AND EXISTS (
        SELECT 1 FROM subscription_checkout_requests r WHERE r.invoice_id = i.id AND r.org_id = v_org
      ) ORDER BY i.created_at DESC LIMIT 20
    ) x)
  );
END $$;
REVOKE ALL ON FUNCTION get_subscription_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_subscription_catalog() TO authenticated;

CREATE FUNCTION create_subscription_checkout(p_request_id UUID, p_location_id UUID, p_product TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := billing_owner_org(); v_request subscription_checkout_requests;
  v_settings billing_checkout_settings; v_price product_prices; v_sub subscriptions;
  v_invoice UUID; v_location TEXT; v_label TEXT; v_discount INT := 0; v_vat INT;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'checkout_request_required'; END IF;
  -- Serializes requests from different tabs AND different owners of the org.
  PERFORM 1 FROM orgs WHERE id = v_org FOR UPDATE;
  SELECT * INTO v_request FROM subscription_checkout_requests WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_request.auth_user_id <> auth.uid() OR v_request.org_id <> v_org
      OR v_request.location_id IS DISTINCT FROM p_location_id OR v_request.product IS DISTINCT FROM p_product
    THEN RAISE EXCEPTION 'checkout_request_conflict'; END IF;
    RETURN get_subscription_checkout(v_request.invoice_id);
  END IF;
  SELECT * INTO v_settings FROM billing_checkout_settings WHERE singleton FOR SHARE;
  IF v_settings.mode IS NULL OR v_settings.mode = 'disabled' THEN RAISE EXCEPTION 'checkout_disabled'; END IF;
  SELECT name INTO v_location FROM locations WHERE id = p_location_id AND org_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'location_not_in_org'; END IF;
  SELECT display_name INTO v_label FROM product_catalog
    WHERE key = p_product AND is_active AND key IN ('menu','online_orders','reservations');
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_product'; END IF;

  -- A new request key cannot accidentally issue a second open invoice for
  -- the same product/location. The first quote remains an immutable snapshot.
  SELECT i.id INTO v_invoice FROM invoices i WHERE i.org_id = v_org
    AND i.status IN ('open','processing') AND EXISTS (
      SELECT 1 FROM subscription_checkout_requests r WHERE r.invoice_id = i.id
        AND r.org_id = v_org AND r.location_id = p_location_id AND r.product = p_product
    ) ORDER BY i.created_at LIMIT 1 FOR UPDATE;
  IF v_invoice IS NULL THEN
    v_price := current_product_price(p_product, 'monthly');
    IF v_price.id IS NULL OR v_price.billing_unit <> 'location' OR v_price.amount_agorot <= 0
      THEN RAISE EXCEPTION 'checkout_price_unavailable'; END IF;
    SELECT * INTO v_sub FROM subscriptions
      WHERE org_id = v_org AND product = p_product AND location_id = p_location_id FOR UPDATE;
    IF NOT FOUND THEN
      -- No trial, paid period or capability is granted before payment.
      INSERT INTO subscriptions(org_id, product, location_id, status, unit_price_agorot,
        current_period_end, metadata) VALUES
        (v_org, p_product, p_location_id, 'suspended', v_price.amount_agorot, NULL,
         jsonb_build_object('created_by', 'checkout')) RETURNING * INTO v_sub;
    ELSIF v_sub.billing_cycle <> 'monthly' THEN RAISE EXCEPTION 'checkout_cycle_unsupported'; END IF;
    IF v_price.bundle_with IS NOT NULL AND EXISTS (
      SELECT 1 FROM subscriptions b WHERE b.org_id = v_org AND b.location_id = p_location_id
        AND b.product = v_price.bundle_with AND b.status IN ('active','past_due')
        AND b.current_period_end > NOW()
    ) THEN v_discount := v_price.bundle_discount_agorot; END IF;
    v_vat := ROUND((v_price.amount_agorot - v_discount)::NUMERIC * v_settings.vat_rate / 100);
    INSERT INTO invoices(org_id, number, status, period_start, period_end, vat_rate, notes)
      VALUES (v_org, next_invoice_number(), 'draft', NOW(), NOW() + INTERVAL '1 month',
        v_settings.vat_rate, CASE WHEN v_settings.mode = 'test' THEN 'TEST ONLY — no real payment; not a tax invoice'
          ELSE 'Subscription checkout; not a tax invoice' END) RETURNING id INTO v_invoice;
    INSERT INTO invoice_lines(invoice_id, subscription_id, product, location_id, location_name,
      description, unit_price_agorot, quantity, discount_agorot, line_total_agorot)
      VALUES (v_invoice, v_sub.id, p_product, p_location_id, v_location, v_label || ' — ' || v_location,
        v_price.amount_agorot, 1, v_discount, v_price.amount_agorot - v_discount);
    UPDATE invoices SET status = 'open', subtotal_agorot = v_price.amount_agorot,
      discount_agorot = v_discount, vat_agorot = v_vat,
      total_agorot = v_price.amount_agorot - v_discount + v_vat WHERE id = v_invoice;
    INSERT INTO subscription_events(org_id, subscription_id, invoice_id, event, actor, payload)
      VALUES (v_org, v_sub.id, v_invoice, 'checkout_created', auth.uid()::TEXT,
        jsonb_build_object('mode', v_settings.mode, 'price_id', v_price.id));
  ELSE
    SELECT mode INTO v_settings.mode FROM subscription_checkout_requests WHERE invoice_id = v_invoice LIMIT 1;
  END IF;
  INSERT INTO subscription_checkout_requests(request_id, auth_user_id, org_id, location_id, product, invoice_id, mode)
    VALUES (p_request_id, auth.uid(), v_org, p_location_id, p_product, v_invoice, v_settings.mode);
  RETURN get_subscription_checkout(v_invoice);
END $$;
REVOKE ALL ON FUNCTION create_subscription_checkout(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_subscription_checkout(UUID, UUID, TEXT) TO authenticated;

CREATE FUNCTION cancel_subscription_checkout(p_invoice_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org UUID := billing_owner_org(); v_status TEXT;
BEGIN
  PERFORM 1 FROM orgs WHERE id = v_org FOR UPDATE;
  PERFORM get_subscription_checkout(p_invoice_id);
  SELECT status INTO v_status FROM invoices WHERE id = p_invoice_id AND org_id = v_org FOR UPDATE;
  IF v_status = 'processing' THEN RAISE EXCEPTION 'checkout_payment_processing'; END IF;
  IF v_status = 'open' THEN
    UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = p_invoice_id;
    INSERT INTO subscription_events(org_id, invoice_id, event, actor)
      VALUES (v_org, p_invoice_id, 'checkout_canceled', auth.uid()::TEXT);
  END IF;
  -- If payment won the lock race, return paid, never undo it or remove data.
  RETURN get_subscription_checkout(p_invoice_id);
END $$;
REVOKE ALL ON FUNCTION cancel_subscription_checkout(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_subscription_checkout(UUID) TO authenticated;

-- Keep the existing payment transition; also close the original interest
-- request when a paid invoice activates the first subscription.
ALTER FUNCTION grant_subscription_by_id(UUID, INT) RENAME TO grant_subscription_by_id_internal_166;
REVOKE ALL ON FUNCTION grant_subscription_by_id_internal_166(UUID, INT) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION grant_subscription_by_id(p_sub_id UUID, p_months INT DEFAULT 1) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM grant_subscription_by_id_internal_166(p_sub_id, p_months);
  UPDATE product_activation_requests r SET status = 'approved', updated_at = NOW()
    FROM subscriptions s WHERE s.id = p_sub_id AND s.status = 'active'
      AND r.org_id = s.org_id AND r.product = s.product AND r.status = 'pending';
END $$;
REVOKE ALL ON FUNCTION grant_subscription_by_id(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION grant_subscription_by_id(UUID, INT) TO service_role;
