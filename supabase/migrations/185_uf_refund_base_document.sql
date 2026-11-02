-- ============================================================
-- 185 ВОЗВРАТ В ВЫГРУЗКЕ ССЫЛАЕТСЯ НА ИСХОДНЫЙ ЧЕК
--
-- Единый формат 1.31, разъяснение 6 (поля D110 1256/1257): документ,
-- основанный на другом документе, обязан назвать тип и номер основания.
-- חשבונית מס זיכוי (330) в Kassa всегда основана на оплаченном чеке
-- (320), но лента `uf_export_documents_for` отдавала у возврата только
-- его собственный номер — связь с чеком в наборе терялась, и в
-- заголовке зикуя стоял «לקוח מזדמן», даже если чек выписан на компанию.
--
-- ЧТО ЗДЕСЬ. У строк-возвратов ленты появляются поля исходного заказа:
-- base_receipt_number, base_doc_type и покупатель (customer_name,
-- buyer_name, buyer_tax_id). Продажи, фильтры, порядок и пагинация —
-- без изменений; тело функции — копия 151 плюс пять полей.
--
-- Совместимость: Edge Function до передеплоя эти поля просто не читает;
-- новая Edge Function на базе без 185 получает возврат без основания и
-- пишет поля основания пустыми — набор остаётся корректным по длинам.
--
-- Forward-only: 151 не редактируется. ⚠️ ТРЕБУЕТ 151.
-- ============================================================

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
          -- НОВОЕ (151): эмитент этого документа на момент выпуска.
          -- Фолбэк на живую точку — для документов, выпущенных до 150:
          -- у них слепка нет, и единственное, что о них известно, —
          -- сегодняшние реквизиты. См. backfill в 150.
          'issuer_name', COALESCE(o.issuer_name, l.receipt_business_name, l.name),
          'issuer_tax_id', COALESCE(o.issuer_tax_id, l.receipt_tax_id),
          'issuer_address', COALESCE(o.issuer_address, l.receipt_address),
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
      JOIN locations l ON l.id = o.location_id
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
          'issuer_name', COALESCE(r.issuer_name, l.receipt_business_name, l.name),
          'issuer_tax_id', COALESCE(r.issuer_tax_id, l.receipt_tax_id),
          'issuer_address', COALESCE(r.issuer_address, l.receipt_address),
          'items', r.items,
          -- НОВОЕ (185): документ-основание и его покупатель.
          'base_receipt_number', o.receipt_number,
          'base_doc_type', o.doc_type,
          'customer_name', o.customer_name,
          'buyer_name', o.buyer_name,
          'buyer_tax_id', o.buyer_tax_id
        ) AS doc
      FROM refunds r
      JOIN orders o ON o.id = r.order_id
      JOIN locations l ON l.id = r.location_id
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

COMMENT ON FUNCTION uf_export_documents_for(UUID, DATE, DATE, TIMESTAMPTZ, UUID, INT) IS
  'Лента фискальных документов точки за период (073/107) + эмитент каждого '
  'документа на момент выпуска (151) + у возврата — исходный чек как '
  'документ-основание и его покупатель (185).';
