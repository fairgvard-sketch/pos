-- ============================================================
-- 107: Конфигурация точки из веб-кабинета (ANGLE)
--
-- POS облегчается: настройки уровня точки/бизнеса переезжают в
-- бэкофис, на терминале остаётся только device-scoped (печать,
-- быстрые суммы, автоблокировка и т.п.).
--
-- 1) update_location_config_web — веб-версия update_location_config
--    (044/052): колонки locations (имя, логотип, режим, НДС,
--    реквизиты чека, лояльность) по явно выбранной точке. Право —
--    членство владельца/менеджера (091) или PIN-сессия 'manage'.
--    Ключ 'settings' намеренно запрещён: для JSONB-настроек есть
--    patch_location_settings_web с поключевым merge — веб-клиент
--    не должен уметь перезаписать settings целиком.
--
-- 2) uf_export_info / uf_export_documents (073) разобраны на ядро
--    *_for(location) + тонкие обёртки; добавлены *_web-варианты,
--    чтобы выгрузка УФ 1.31 работала из ANGLE без PIN-сессии.
--    Скоуп: явная проверка «точка принадлежит org из JWT» в каждом
--    web-варианте (не полагаемся на assert_backoffice_location:
--    для устройства она no-op, а ядро читает без RLS).
-- ============================================================

-- ── update_location_config_web ───────────────────────────────
CREATE OR REPLACE FUNCTION update_location_config_web(
  p_location_id UUID,
  p_patch JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM assert_backoffice_location(p_location_id);
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  IF jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a json object';
  END IF;
  IF p_patch ? 'settings' THEN
    RAISE EXCEPTION 'use patch_location_settings_web for settings';
  END IF;

  -- Валидации — копия update_location_config (052)
  IF p_patch ? 'service_mode' AND (p_patch ->> 'service_mode') NOT IN ('counter', 'counter_tables', 'tables') THEN
    RAISE EXCEPTION 'invalid service_mode';
  END IF;
  IF p_patch ? 'vat_rate' AND ((p_patch ->> 'vat_rate')::NUMERIC < 0 OR (p_patch ->> 'vat_rate')::NUMERIC > 50) THEN
    RAISE EXCEPTION 'invalid vat_rate';
  END IF;
  IF p_patch ? 'loyalty_mode' AND (p_patch ->> 'loyalty_mode') NOT IN ('off', 'stamps', 'points') THEN
    RAISE EXCEPTION 'invalid loyalty_mode';
  END IF;
  IF p_patch ? 'name' AND NULLIF(TRIM(p_patch ->> 'name'), '') IS NULL THEN
    RAISE EXCEPTION 'invalid name';
  END IF;

  UPDATE locations SET
    name                  = CASE WHEN p_patch ? 'name' THEN TRIM(p_patch ->> 'name') ELSE name END,
    logo_url              = CASE WHEN p_patch ? 'logo_url' THEN NULLIF(TRIM(p_patch ->> 'logo_url'), '') ELSE logo_url END,
    service_mode          = CASE WHEN p_patch ? 'service_mode' THEN p_patch ->> 'service_mode' ELSE service_mode END,
    vat_rate              = CASE WHEN p_patch ? 'vat_rate' THEN (p_patch ->> 'vat_rate')::NUMERIC ELSE vat_rate END,
    receipt_business_name = CASE WHEN p_patch ? 'receipt_business_name' THEN NULLIF(TRIM(p_patch ->> 'receipt_business_name'), '') ELSE receipt_business_name END,
    receipt_address       = CASE WHEN p_patch ? 'receipt_address' THEN NULLIF(TRIM(p_patch ->> 'receipt_address'), '') ELSE receipt_address END,
    receipt_tax_id        = CASE WHEN p_patch ? 'receipt_tax_id' THEN NULLIF(TRIM(p_patch ->> 'receipt_tax_id'), '') ELSE receipt_tax_id END,
    receipt_phone         = CASE WHEN p_patch ? 'receipt_phone' THEN NULLIF(TRIM(p_patch ->> 'receipt_phone'), '') ELSE receipt_phone END,
    receipt_footer        = CASE WHEN p_patch ? 'receipt_footer' THEN NULLIF(TRIM(p_patch ->> 'receipt_footer'), '') ELSE receipt_footer END,
    loyalty_mode          = CASE WHEN p_patch ? 'loyalty_mode' THEN p_patch ->> 'loyalty_mode' ELSE loyalty_mode END,
    loyalty_stamps_goal   = CASE WHEN p_patch ? 'loyalty_stamps_goal' THEN (p_patch ->> 'loyalty_stamps_goal')::INTEGER ELSE loyalty_stamps_goal END,
    loyalty_points_percent = CASE WHEN p_patch ? 'loyalty_points_percent' THEN (p_patch ->> 'loyalty_points_percent')::NUMERIC ELSE loyalty_points_percent END,
    loyalty_points_min_redeem = CASE WHEN p_patch ? 'loyalty_points_min_redeem' THEN (p_patch ->> 'loyalty_points_min_redeem')::INTEGER ELSE loyalty_points_min_redeem END
  WHERE id = p_location_id AND org_id = auth_org_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'location not in organization';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION update_location_config_web(UUID, JSONB, UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION update_location_config_web(UUID, JSONB, UUID) TO authenticated;

-- ── УФ 1.31: ядро выборки по явной точке ─────────────────────
-- SECURITY INVOKER: вызывается только изнутри definer-обёрток
-- (исполняется их владельцем), клиентским ролям недоступно.

CREATE OR REPLACE FUNCTION uf_export_info_for(p_location UUID)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'business_name', COALESCE(l.receipt_business_name, l.name),
    'address',       l.receipt_address,
    'tax_id',        l.receipt_tax_id,
    'location_id',   l.id
  )
  FROM locations l
  WHERE l.id = p_location;
$$;

REVOKE ALL ON FUNCTION uf_export_info_for(UUID) FROM anon, authenticated, public;

CREATE OR REPLACE FUNCTION uf_export_documents_for(
  p_location UUID,
  p_from DATE,
  p_to   DATE,
  p_after_ts TIMESTAMPTZ DEFAULT NULL,
  p_after_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 200
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_docs JSONB;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'invalid_range';
  END IF;

  WITH events AS (
    (
      SELECT
        o.paid_at AS ts,
        o.id,
        jsonb_build_object(
          'kind', 'order',
          'ts', o.paid_at,
          'id', o.id,
          'receipt_number', o.receipt_number,
          'doc_type', o.doc_type,
          'paid_at', o.paid_at,
          'customer_name', o.customer_name,
          'buyer_name', o.buyer_name,
          'buyer_tax_id', o.buyer_tax_id,
          'subtotal', o.subtotal,
          'vat_rate', o.vat_rate,
          'vat_amount', o.vat_amount,
          'total', o.total,
          'discount_amount', COALESCE(o.discount_amount, 0),
          'loyalty_discount', COALESCE(o.loyalty_discount, 0),
          'items', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'name', i.name,
              'variant_name', i.variant_name,
              'unit_price', i.unit_price,
              'qty', i.qty,
              'line_total', i.line_total
            ) ORDER BY i.id)
            FROM order_items i WHERE i.order_id = o.id
          ), '[]'::jsonb),
          'payments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'method', p.method,
              'amount', p.amount
            ) ORDER BY p.created_at, p.id)
            FROM payments p
            WHERE p.order_id = o.id AND p.refund_id IS NULL
          ), '[]'::jsonb)
        ) AS doc
      FROM orders o
      WHERE o.location_id = p_location
        AND o.receipt_number IS NOT NULL
        AND o.paid_at IS NOT NULL
        AND (o.paid_at AT TIME ZONE 'Asia/Jerusalem')::date BETWEEN p_from AND p_to
    )
    UNION ALL
    (
      SELECT
        r.created_at AS ts,
        r.id,
        jsonb_build_object(
          'kind', 'refund',
          'ts', r.created_at,
          'id', r.id,
          'refund_number', r.refund_number,
          'created_at', r.created_at,
          'amount', r.amount,
          'method', r.method,
          'reason', r.reason,
          'vat_rate', o.vat_rate,
          'items', r.items
        ) AS doc
      FROM refunds r
      JOIN orders o ON o.id = r.order_id
      WHERE r.location_id = p_location
        AND r.refund_number IS NOT NULL
        AND (r.created_at AT TIME ZONE 'Asia/Jerusalem')::date BETWEEN p_from AND p_to
    )
  )
  SELECT COALESCE(jsonb_agg(doc ORDER BY ts, id), '[]'::jsonb) INTO v_docs
  FROM (
    SELECT ts, id, doc
    FROM events
    WHERE p_after_ts IS NULL OR (ts, id) > (p_after_ts, p_after_id)
    ORDER BY ts, id
    LIMIT v_limit
  ) page;

  RETURN jsonb_build_object('documents', v_docs);
END $$;

REVOKE ALL ON FUNCTION
  uf_export_documents_for(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INT)
  FROM anon, authenticated, public;

-- ── Кассовые обёртки (сигнатуры 073 сохранены) ───────────────

CREATE OR REPLACE FUNCTION uf_export_info(p_staff_session UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'manage');
  RETURN uf_export_info_for(auth_location_id());
END $$;

CREATE OR REPLACE FUNCTION uf_export_documents(
  p_staff_session UUID,
  p_from DATE,
  p_to   DATE,
  p_after_ts TIMESTAMPTZ DEFAULT NULL,
  p_after_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 200
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'manage');
  RETURN uf_export_documents_for(auth_location_id(), p_from, p_to, p_after_ts, p_after_id, p_limit);
END $$;

-- ── Веб-обёртки для ANGLE ────────────────────────────────────

CREATE OR REPLACE FUNCTION uf_export_info_web(
  p_location_id UUID,
  p_staff_session UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');
  IF NOT EXISTS (
    SELECT 1 FROM locations WHERE id = p_location_id AND org_id = auth_org_id()
  ) THEN
    RAISE EXCEPTION 'location not in organization';
  END IF;
  RETURN uf_export_info_for(p_location_id);
END $$;

REVOKE EXECUTE ON FUNCTION uf_export_info_web(UUID, UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION uf_export_info_web(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION uf_export_documents_web(
  p_location_id UUID,
  p_from DATE,
  p_to   DATE,
  p_after_ts TIMESTAMPTZ DEFAULT NULL,
  p_after_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 200,
  p_staff_session UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');
  IF NOT EXISTS (
    SELECT 1 FROM locations WHERE id = p_location_id AND org_id = auth_org_id()
  ) THEN
    RAISE EXCEPTION 'location not in organization';
  END IF;
  RETURN uf_export_documents_for(p_location_id, p_from, p_to, p_after_ts, p_after_id, p_limit);
END $$;

REVOKE EXECUTE ON FUNCTION
  uf_export_documents_web(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INT, UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION
  uf_export_documents_web(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INT, UUID) TO authenticated;

COMMENT ON FUNCTION update_location_config_web(UUID, JSONB, UUID) IS
  'Веб-версия update_location_config: колонки locations по явной точке, право — членство бэкофиса или PIN manage (107).';
COMMENT ON FUNCTION uf_export_info_web(UUID, UUID) IS
  'УФ 1.31 из бэкофиса: реквизиты бизнеса по явной точке (107).';
COMMENT ON FUNCTION uf_export_documents_web(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INT, UUID) IS
  'УФ 1.31 из бэкофиса: лента фискальных документов по явной точке (107).';
