-- ============================================================
-- 073: Единый формат 1.31 — серверная выборка данных экспорта
--
-- Два RPC для Edge Function `uniform-format-export`:
--   uf_export_info      — реквизиты точки и бизнеса;
--   uf_export_documents — постраничная хронологическая лента
--                         фискальных документов периода
--                         (оплаченные заказы + возвраты).
--
-- Оба требуют staff-сессию с правом 'manage' (manager/owner) через
-- require_staff_perm; данные скоупятся org/location из JWT устройства.
-- Ничего не пишут (кроме скользящего продления staff-сессии).
--
-- Границы периода — календарные дни по Asia/Jerusalem: фискальный
-- документ датируется локальным временем бизнеса, а БД хранит UTC.
-- ============================================================

CREATE OR REPLACE FUNCTION uf_export_info(p_staff_session UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'manage');

  RETURN (
    SELECT jsonb_build_object(
      'business_name', COALESCE(l.receipt_business_name, l.name),
      'address',       l.receipt_address,
      'tax_id',        l.receipt_tax_id,
      'location_id',   l.id
    )
    FROM locations l
    WHERE l.id = auth_location_id()
  );
END $$;

REVOKE EXECUTE ON FUNCTION uf_export_info(UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION uf_export_info(UUID) TO authenticated;

-- ------------------------------------------------------------
-- Лента документов: keyset-пагинация по (момент события, id).
-- Заказ фискален, когда получил серверный номер чека (receipt_number).
-- Оплаты возвратов (payments.refund_id IS NOT NULL) в продажу не входят:
-- возврат выгружается собственным документом 330 из refunds.
-- ------------------------------------------------------------

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
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_docs JSONB;
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'manage');

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
      WHERE o.location_id = auth_location_id()
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
      WHERE r.location_id = auth_location_id()
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

REVOKE EXECUTE ON FUNCTION
  uf_export_documents(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INT) FROM anon, public;
GRANT EXECUTE ON FUNCTION
  uf_export_documents(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INT) TO authenticated;
