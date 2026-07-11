-- ============================================================
-- 049 SALES REPORT SESSION — отчёт «Продажи» за manager-сессией.
--
-- Мотив: дашборд владельца открывается с личного телефона; выручка,
-- топ товаров и разбивка по сотрудникам — менеджерские данные. Раньше
-- sales_report был доступен любому устройству org (клиентский гейт по
-- роли — только UI). Теперь право проверяет БД: p_staff_session +
-- require_staff_perm 'manage' (= только manager/owner, как плитки
-- Отчёты/Меню/Настройки).
--
-- Мягкий/строгий режим наследуется от require_staff_perm (044/045):
-- до применения 045 вызов без токена проходит (старые клиенты).
--
-- Механика: было LANGUAGE sql STABLE — но require_staff_perm пишет
-- (скользящее продление сессии), из STABLE-контекста это упадёт.
-- Переписана в plpgsql (по умолчанию VOLATILE), тело запроса — копия
-- 026 без изменений. SECURITY INVOKER сохранён: чтение под RLS
-- устройства. DROP старой сигнатуры обязателен (overload, грабли 033).
--
-- ⚠️ ТРЕБУЕТ ПРИМЕНЁННОЙ 044 (require_staff_perm).
-- ============================================================

DROP FUNCTION IF EXISTS sales_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT);

CREATE FUNCTION sales_report(
  p_from TIMESTAMPTZ,
  p_to   TIMESTAMPTZ,
  p_tz   TEXT DEFAULT 'Asia/Jerusalem',
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  PERFORM require_staff_perm(p_staff_session, 'manage');

  WITH sold AS (
    SELECT * FROM orders
    WHERE status IN ('paid', 'fulfilled', 'refunded')
      AND paid_at >= p_from AND paid_at < p_to
  ),
  pays AS (
    SELECT * FROM payments
    WHERE created_at >= p_from AND created_at < p_to
  ),
  active_items AS (
    SELECT oi.*
    FROM order_items oi
    JOIN sold o ON o.id = oi.order_id
    WHERE oi.voided_at IS NULL
  )
  SELECT jsonb_build_object(
    'summary', (
      SELECT jsonb_build_object(
        'gross_sales',   COALESCE(SUM(total), 0),
        'discounts',     COALESCE(SUM(discount_amount), 0),
        'vat',           COALESCE(SUM(vat_amount), 0),
        'orders_count',  COUNT(*),
        'avg_check',     COALESCE(ROUND(AVG(total)), 0)::int,
        'refunds',       (SELECT COALESCE(-SUM(amount), 0) FROM pays WHERE amount < 0),
        'refunds_count', (SELECT COUNT(DISTINCT order_id) FROM pays WHERE amount < 0)
      )
      FROM sold
    ),
    'by_method', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('method', method, 'amount', amount, 'count', cnt)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        -- Сумма включает отрицательные возвраты → чистая по каждому способу
        SELECT method, SUM(amount) AS amount,
               COUNT(*) FILTER (WHERE amount > 0) AS cnt
        FROM pays
        GROUP BY method
      ) m
    ),
    'by_hour', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('hour', hour, 'amount', amount, 'count', cnt)
        ORDER BY hour), '[]'::jsonb)
      FROM (
        SELECT EXTRACT(HOUR FROM paid_at AT TIME ZONE p_tz)::int AS hour,
               SUM(total) AS amount, COUNT(*) AS cnt
        FROM sold
        GROUP BY 1
      ) h
    ),
    'by_day', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('day', to_char(day, 'YYYY-MM-DD'), 'amount', amount, 'count', cnt)
        ORDER BY day), '[]'::jsonb)
      FROM (
        SELECT (paid_at AT TIME ZONE p_tz)::date AS day,
               SUM(total) AS amount, COUNT(*) AS cnt
        FROM sold
        GROUP BY 1
      ) d
    ),
    'top_items', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('name', name, 'qty', qty, 'amount', amount)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        -- Группировка по снапшоту имени: чек-история не зависит от правок меню
        SELECT name, SUM(qty) AS qty, SUM(line_total) AS amount
        FROM active_items
        GROUP BY name
        ORDER BY amount DESC
        LIMIT 15
      ) ti
    ),
    'by_category', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('category', category, 'qty', qty, 'amount', amount)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        SELECT COALESCE(mc.name, '—') AS category,
               SUM(ai.qty) AS qty, SUM(ai.line_total) AS amount
        FROM active_items ai
        LEFT JOIN menu_items mi ON mi.id = ai.menu_item_id
        LEFT JOIN menu_categories mc ON mc.id = mi.category_id
        GROUP BY 1
      ) c
    ),
    'by_staff', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('name', name, 'amount', amount, 'count', cnt)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        SELECT s.name, SUM(o.total) AS amount, COUNT(*) AS cnt
        FROM sold o
        JOIN staff s ON s.id = o.staff_id
        GROUP BY s.name
      ) st
    )
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION sales_report FROM anon, public;
GRANT EXECUTE ON FUNCTION sales_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID) TO authenticated;
