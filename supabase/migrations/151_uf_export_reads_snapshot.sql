-- ============================================================
-- 151 ВЫГРУЗКА ЧИТАЕТ ЭМИТЕНТА ИЗ ДОКУМЕНТОВ, А НЕ ИЗ НАСТРОЕК
--
-- 150 научила документ помнить эмитента, но пока это только запись:
-- выгрузка Единого формата по-прежнему берёт реквизиты живыми
-- (`uf_export_info_for` читает колонки `locations` на момент ЭКСПОРТА).
-- Пока читающая сторона не переведена, слепок ни на что не влияет.
--
-- ЧТО ЗДЕСЬ. Лента документов отдаёт эмитента КАЖДОГО документа. Дальше
-- Edge Function собирает реквизиты набора из самих документов:
--   * все документы периода от одного эмитента — его и пишем в заголовок;
--   * документов нет — выгружать нечего, реквизиты берутся как раньше;
--   * эмитенты РАЗНЫЕ — набор отдавать нельзя. В מבנה אחיד заголовок
--     несёт один ח.פ, и «усреднить» двух эмитентов невозможно: период
--     обязан выгружаться раздельно. Это ошибка, а не предупреждение —
--     молча сданный набор с чужим ח.פ хуже, чем несданный.
--
-- Сигнатуры НЕ меняются: `uf_export_info*` остаются как были, чтобы
-- порядок релиза (миграции → функции → фронт) не ломал уже выложенную
-- Edge Function. Она продолжит работать на живых реквизитах, пока её не
-- передеплоят, — и это ровно сегодняшнее поведение, без регресса.
--
-- Forward-only. ⚠️ ТРЕБУЕТ 150 (колонки issuer_*), 107 (ядро выборки).
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
          'items', r.items
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
  'документа на момент выпуска (151): заголовок набора собирается из самих '
  'документов, а не из текущих настроек точки.';

-- ── Сколько разных эмитентов в периоде ──────────────────────
-- Отдельная дешёвая проверка: Edge Function спрашивает её ДО постраничной
-- выборки, чтобы не собирать сто тысяч записей и не выбрасывать их,
-- обнаружив расхождение на последней странице.
CREATE OR REPLACE FUNCTION uf_export_issuers_for(
  p_location UUID,
  p_from DATE,
  p_to   DATE
)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH issuers AS (
    SELECT DISTINCT
      COALESCE(o.issuer_name, l.receipt_business_name, l.name) AS name,
      COALESCE(o.issuer_tax_id, l.receipt_tax_id)              AS tax_id,
      COALESCE(o.issuer_address, l.receipt_address)            AS address
    FROM orders o
    JOIN locations l ON l.id = o.location_id
    WHERE o.location_id = p_location
      AND o.receipt_number IS NOT NULL
      AND o.paid_at IS NOT NULL
      AND (o.paid_at AT TIME ZONE 'Asia/Jerusalem')::date BETWEEN p_from AND p_to
    UNION
    SELECT DISTINCT
      COALESCE(r.issuer_name, l.receipt_business_name, l.name),
      COALESCE(r.issuer_tax_id, l.receipt_tax_id),
      COALESCE(r.issuer_address, l.receipt_address)
    FROM refunds r
    JOIN locations l ON l.id = r.location_id
    WHERE r.location_id = p_location
      AND r.refund_number IS NOT NULL
      AND (r.created_at AT TIME ZONE 'Asia/Jerusalem')::date BETWEEN p_from AND p_to
  )
  SELECT jsonb_build_object(
    'count', (SELECT COUNT(*) FROM issuers),
    'issuers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'business_name', name, 'tax_id', tax_id, 'address', address
      ))
      FROM issuers
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION uf_export_issuers_for(UUID, DATE, DATE) FROM anon, authenticated, public;

CREATE OR REPLACE FUNCTION uf_export_issuers_web(
  p_location_id UUID,
  p_from DATE,
  p_to   DATE,
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
  RETURN uf_export_issuers_for(p_location_id, p_from, p_to);
END $$;

REVOKE EXECUTE ON FUNCTION uf_export_issuers_web(UUID, DATE, DATE, UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION uf_export_issuers_web(UUID, DATE, DATE, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION uf_export_issuers(
  p_staff_session UUID,
  p_from DATE,
  p_to   DATE
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'manage');
  RETURN uf_export_issuers_for(auth_location_id(), p_from, p_to);
END $$;

REVOKE EXECUTE ON FUNCTION uf_export_issuers(UUID, DATE, DATE) FROM anon, public;
GRANT EXECUTE ON FUNCTION uf_export_issuers(UUID, DATE, DATE) TO authenticated;

COMMENT ON FUNCTION uf_export_issuers_web(UUID, DATE, DATE, UUID) IS
  'Сколько разных эмитентов в периоде (151). Больше одного — набор מבנה אחיד '
  'за такой период отдавать нельзя: в заголовке один ח.פ.';
