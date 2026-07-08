-- ============================================================
-- 026 REPORTS — отчёт «Продажи» за произвольный период.
--
-- sales_report(p_from, p_to, p_tz) → jsonb со всеми секциями:
--   summary, by_method, by_hour, by_day, top_items, by_category, by_staff.
--
-- Принципы:
--   * SECURITY INVOKER (по умолчанию): функция читает под RLS
--     устройства — org_id ограничен политиками, отдельная
--     фильтрация не нужна.
--   * Продажи = заказы paid/fulfilled/refunded с paid_at в периоде
--     (валовые, снапшоты totals из заказа — инвариант №5).
--     Возвраты — отрицательные payments, СОЗДАННЫЕ в периоде:
--     чистая выручка = валовая − возвраты (как в Square). Возврат
--     в другом периоде уменьшает тот период, где вернули деньги.
--   * Часы/дни группируются в локальном поясе точки (p_tz);
--     границы периода клиент передаёт готовыми timestamptz.
--   * Позиции с voided_at исключаются из топа/категорий
--     (их нет и в итогах заказа — 015).
-- ============================================================

-- Отчёты фильтруют по paid_at (в т.ч. годовые периоды)
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders (paid_at)
  WHERE paid_at IS NOT NULL;

CREATE OR REPLACE FUNCTION sales_report(
  p_from TIMESTAMPTZ,
  p_to   TIMESTAMPTZ,
  p_tz   TEXT DEFAULT 'Asia/Jerusalem'
) RETURNS JSONB
LANGUAGE sql STABLE
SET search_path = public
AS $$
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
);
$$;

GRANT EXECUTE ON FUNCTION sales_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated;
