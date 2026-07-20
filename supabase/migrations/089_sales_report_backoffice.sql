-- ============================================================
-- 089 SALES REPORT BACKOFFICE — отчёт «Продажи» для владельца в вебе.
--
-- Мотив: дашборд владельца («Обзор») переезжает в ANGLE back office.
-- В вебе нет PIN-сессии: человек входит через Supabase Auth, а его право
-- подтверждает членство в organization_members (088). До 089 sales_report
-- знал только про staff-сессию, поэтому из бэкофиса он падал.
--
-- Решение: перед проверкой PIN-сессии сначала спрашиваем членство.
-- Владелец/менеджер бэкофиса проходит без токена; всё остальное — как было,
-- через require_staff_perm (включая мягкий/строгий режим 044/045).
-- accountant СЮДА НЕ ВХОДИТ: бухгалтеру выручка в разрезе сотрудников не
-- нужна, у него свой канал — фискальный экспорт (073).
--
-- Тело отчёта не тронуто: копия 049 без изменений. Правится ровно одна
-- строка — проверка права. Функция остаётся SECURITY INVOKER, то есть
-- чтение всё так же идёт под RLS вызывающего: `orders_select` скоупит по
-- org_id, поэтому чужая организация недостижима даже при ошибке в гейте.
--
-- Точка (location) здесь не при чём: тело фильтрует только по времени,
-- а у веб-владельца auth_location_id() пуст — отчёт по организации.
--
-- ⚠️ ТРЕБУЕТ ПРИМЕНЁННОЙ 088 (auth_backoffice_role).
-- ============================================================

CREATE OR REPLACE FUNCTION sales_report(
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
  -- Веб-владелец бэкофиса подтверждён членством (088) — PIN-сессия не нужна.
  -- Иначе прежний путь: staff-сессия с правом 'manage'.
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

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
