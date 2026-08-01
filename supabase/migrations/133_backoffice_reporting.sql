-- ============================================================
-- 133. Отчётность кабинета: явный охват, разрезы и рабочий журнал.
--
-- Что было не так:
--
--   * `sales_report` (089/105) считал ВСЮ организацию. Сеть из трёх точек
--     видела одно число и не могла спросить «а сколько на Ротшильд?» —
--     охват отчёта нигде не назывался, его приходилось угадывать;
--   * разрезы были только по способу оплаты, позициям, категориям и
--     сотрудникам. Канал (стойка / QR стола / сайт) и тип заказа
--     (здесь / с собой / доставка) в данных есть с 043 и 099, но в
--     отчёт не попадали;
--   * `get_activity_feed` (098) отдавал последние 50 строк, а фильтр по
--     типу кабинет применял НА КЛИЕНТЕ — то есть отвечал на вопрос «что
--     было среди последних пятидесяти», а не «что было». Ни диапазона
--     дат, ни поиска, ни сотрудника в фильтрах не было;
--   * событие не помнило, на каком терминале произошло, хотя устройство
--     — это аккаунт Auth и его видно в момент записи.
--
-- Здесь: охват по точкам, три новых разреза, блок `scope` (период, зона,
-- точки, валюта) прямо в ответе — чтобы выгрузка объясняла себя сама, —
-- и серверные фильтры журнала.
--
-- Устройство пишется ТОЛЬКО У НОВЫХ событий: у прошлых его взять
-- неоткуда, и кабинет обязан показывать это честно («—»), а не
-- подставлять «главную кассу».
--
-- ⚠️ ТРЕБУЕТ 043/099 (order_type, order_channel), 065 (devices.auth_user_id),
--    098 (activity_events), 105 (sales_report + capability-гейт).
-- ============================================================

-- ── 1. Продажи: охват по точкам и новые разрезы ─────────────
-- Старая сигнатура удаляется: параметр с DEFAULT дал бы PostgREST две
-- подходящие функции («is not unique»).
DROP FUNCTION IF EXISTS sales_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID);

CREATE OR REPLACE FUNCTION sales_report(
  p_from          TIMESTAMPTZ,
  p_to            TIMESTAMPTZ,
  p_tz            TEXT    DEFAULT 'Asia/Jerusalem',
  p_staff_session UUID    DEFAULT NULL,
  p_location_ids  UUID[]  DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  -- Пустой массив = «все точки»: кабинет присылает его, когда владелец
  -- снял последнюю галочку, и это не повод показать пустой отчёт.
  v_locs UUID[] := CASE
    WHEN COALESCE(cardinality(p_location_ids), 0) = 0 THEN NULL
    ELSE p_location_ids END;
BEGIN
  -- Веб-владелец бэкофиса подтверждён членством (088) — PIN-сессия не нужна.
  -- Иначе прежний путь: staff-сессия с правом 'manage'.
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  -- Capability-гейт (105): POS-отчёты — pos_reports.
  PERFORM require_org_capability('pos_reports');

  WITH sold AS (
    SELECT * FROM orders
    WHERE status IN ('paid', 'fulfilled', 'refunded')
      AND paid_at >= p_from AND paid_at < p_to
      AND (v_locs IS NULL OR location_id = ANY(v_locs))
  ),
  pays AS (
    -- У платежа своей точки нет — берём её у заказа, иначе охват
    -- «по точке» врал бы ровно на возвраты и наличные.
    SELECT p.*
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE p.created_at >= p_from AND p.created_at < p_to
      AND (v_locs IS NULL OR o.location_id = ANY(v_locs))
  ),
  active_items AS (
    SELECT oi.*
    FROM order_items oi
    JOIN sold o ON o.id = oi.order_id
    WHERE oi.voided_at IS NULL
  )
  SELECT jsonb_build_object(
    -- Охват отчёта словами: период, зона, точки и валюта. Число без
    -- этого блока невозможно проверить, а выгрузку — объяснить.
    'scope', jsonb_build_object(
      'from', p_from,
      'to',   p_to,
      'tz',   p_tz,
      'all_locations', v_locs IS NULL,
      'locations', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name)
                                  ORDER BY l.name), '[]'::jsonb)
        FROM locations l
        WHERE v_locs IS NULL OR l.id = ANY(v_locs)
      ),
      'currencies', (
        SELECT COALESCE(jsonb_agg(DISTINCT l.currency), '[]'::jsonb)
        FROM locations l
        WHERE v_locs IS NULL OR l.id = ANY(v_locs)
      )
    ),
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
    ),
    -- ── Новое в 133 ──
    'by_channel', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('channel', channel, 'amount', amount, 'count', cnt)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        -- Заказ, пробитый на кассе, канала не имеет — это и есть стойка.
        SELECT COALESCE(order_channel, source, 'pos') AS channel,
               SUM(total) AS amount, COUNT(*) AS cnt
        FROM sold
        GROUP BY 1
      ) ch
    ),
    'by_type', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('type', type, 'amount', amount, 'count', cnt)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        SELECT COALESCE(order_type, '—') AS type,
               SUM(total) AS amount, COUNT(*) AS cnt
        FROM sold
        GROUP BY 1
      ) t
    ),
    'by_location', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object('location_id', location_id, 'name', name,
                           'amount', amount, 'count', cnt)
        ORDER BY amount DESC), '[]'::jsonb)
      FROM (
        SELECT o.location_id, COALESCE(l.name, '—') AS name,
               SUM(o.total) AS amount, COUNT(*) AS cnt
        FROM sold o
        LEFT JOIN locations l ON l.id = o.location_id
        GROUP BY o.location_id, l.name
      ) bl
    )
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION sales_report FROM anon, public;
GRANT EXECUTE ON FUNCTION sales_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID, UUID[])
  TO authenticated;

COMMENT ON FUNCTION sales_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID, UUID[]) IS
  'Отчёт по продажам (089/105, охват и разрезы с 133): период, точки, канал, тип заказа. Блок scope называет охват — без него число невозможно проверить.';

-- ── 2. Событие помнит терминал ──────────────────────────────
ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES devices(id) ON DELETE SET NULL;

COMMENT ON COLUMN activity_events.device_id IS
  'Терминал, на котором произошло событие (133). Заполняется у новых событий по аккаунту устройства; у прошлых NULL — подставлять «главную кассу» было бы выдумкой.';

CREATE INDEX IF NOT EXISTS idx_activity_device_created
  ON activity_events(device_id, created_at DESC) WHERE device_id IS NOT NULL;

/**
 * Терминал текущего вызова. Устройство — аккаунт Supabase Auth (065),
 * поэтому в момент записи события оно известно. Кабинет и Edge-функции
 * работают не от устройства — там честный NULL.
 */
CREATE OR REPLACE FUNCTION current_device_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM devices WHERE auth_user_id = auth.uid() LIMIT 1
$$;

REVOKE ALL ON FUNCTION current_device_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION current_device_id() TO authenticated, service_role;

-- Три триггера 098 повторяются дословно, добавлено одно поле.
CREATE OR REPLACE FUNCTION trg_activity_shift_opened()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO activity_events (org_id, location_id, type, ref_id, staff_id, staff_name,
                               amount, device_id)
  SELECT NEW.org_id, NEW.location_id, 'shift_opened', NEW.id, NEW.opened_by,
         (SELECT name FROM staff WHERE id = NEW.opened_by),
         NEW.opening_float, current_device_id();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trg_activity_shift_closed()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    INSERT INTO activity_events (org_id, location_id, type, ref_id, staff_id, staff_name,
                                 amount, detail, device_id)
    SELECT NEW.org_id, NEW.location_id, 'shift_closed', NEW.id, NEW.closed_by,
           (SELECT name FROM staff WHERE id = NEW.closed_by),
           NEW.total_sales,
           jsonb_build_object(
             'cash_diff',    NEW.cash_diff,
             'counted_cash', NEW.counted_cash,
             'orders_count', NEW.orders_count,
             'z_number',     NEW.z_number
           ),
           current_device_id();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trg_activity_refund_issued()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO activity_events (org_id, location_id, type, ref_id, staff_id, staff_name,
                               amount, detail, device_id)
  SELECT NEW.org_id, NEW.location_id, 'refund_issued', NEW.id, NEW.staff_id,
         (SELECT name FROM staff WHERE id = NEW.staff_id),
         NEW.amount,  -- refunds.amount положительный по CHECK (028)
         jsonb_build_object('method', NEW.method, 'reason', NEW.reason),
         current_device_id();
  RETURN NEW;
END $$;

-- ── 3. Журнал событий: фильтры считает сервер ───────────────
DROP FUNCTION IF EXISTS get_activity_feed(INTEGER, TIMESTAMPTZ, UUID, UUID);

/**
 * Лента и полноценный журнал одной функцией. Раньше кабинет фильтровал
 * по типу уже загруженную страницу — то есть отвечал на вопрос «что было
 * среди последних пятидесяти», а не «что было».
 *
 * Пагинация прежняя: свежие сверху, keyset по created_at (p_before) —
 * устойчиво к доливу новых событий. Потолок поднят до 500: тем же
 * вызовом кабинет выгружает CSV.
 */
CREATE OR REPLACE FUNCTION get_activity_feed(
  p_limit         INTEGER     DEFAULT 50,
  p_before        TIMESTAMPTZ DEFAULT NULL,
  p_location_id   UUID        DEFAULT NULL,
  p_staff_session UUID        DEFAULT NULL,
  p_from          TIMESTAMPTZ DEFAULT NULL,
  p_to            TIMESTAMPTZ DEFAULT NULL,
  p_types         TEXT[]      DEFAULT NULL,
  p_staff_id      UUID        DEFAULT NULL,
  p_device_id     UUID        DEFAULT NULL,
  p_search        TEXT        DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
  v_types  TEXT[]  := CASE
    WHEN COALESCE(cardinality(p_types), 0) = 0 THEN NULL ELSE p_types END;
  v_q      TEXT    := NULLIF(TRIM(COALESCE(p_search, '')), '');
BEGIN
  IF COALESCE(auth_backoffice_role(), '') NOT IN ('owner', 'manager') THEN
    PERFORM require_staff_perm(p_staff_session, 'manage');
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(e) ORDER BY e.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT a.id, a.type, a.location_id,
           (SELECT name FROM locations WHERE id = a.location_id) AS location_name,
           a.staff_id, a.staff_name, a.device_id,
           (SELECT name FROM devices WHERE id = a.device_id) AS device_name,
           a.amount, a.detail, a.created_at
    FROM activity_events a
    WHERE (p_before IS NULL OR a.created_at < p_before)
      AND (p_location_id IS NULL OR a.location_id = p_location_id)
      AND (p_from IS NULL OR a.created_at >= p_from)
      AND (p_to IS NULL OR a.created_at < p_to)
      AND (v_types IS NULL OR a.type = ANY(v_types))
      AND (p_staff_id IS NULL OR a.staff_id = p_staff_id)
      AND (p_device_id IS NULL OR a.device_id = p_device_id)
      -- Поиск по тому, что видно в строке: кто, где и почему
      AND (v_q IS NULL
           OR a.staff_name ILIKE '%' || v_q || '%'
           OR COALESCE(a.detail ->> 'reason', '') ILIKE '%' || v_q || '%'
           OR COALESCE(a.detail ->> 'method', '') ILIKE '%' || v_q || '%'
           OR EXISTS (SELECT 1 FROM locations l
                      WHERE l.id = a.location_id AND l.name ILIKE '%' || v_q || '%')
           OR EXISTS (SELECT 1 FROM devices d
                      WHERE d.id = a.device_id AND d.name ILIKE '%' || v_q || '%'))
    ORDER BY a.created_at DESC
    LIMIT v_limit
  ) e;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION get_activity_feed FROM anon, public;
GRANT EXECUTE ON FUNCTION get_activity_feed(
  INTEGER, TIMESTAMPTZ, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, UUID, TEXT
) TO authenticated;

COMMENT ON FUNCTION get_activity_feed(
  INTEGER, TIMESTAMPTZ, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], UUID, UUID, TEXT
) IS
  'Журнал событий кассы (098, фильтры с 133): диапазон дат, тип, сотрудник, терминал, точка и поиск считает сервер, а не страница в кабинете.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only. Колонка device_id не удаляется (в ней уже записанные
-- события). Функциональный откат — вернуть прежние тела 098/105 новой
-- миграцией: разрезы и фильтры исчезнут, данные останутся.
--
-- ПРОВЕРКА: под веб-владельцем
--   SELECT sales_report(NOW() - INTERVAL '7 days', NOW(), 'Asia/Jerusalem',
--                       NULL, ARRAY['<location>']::UUID[]) -> 'scope';
--   SELECT get_activity_feed(p_types => ARRAY['refund_issued'],
--                            p_search => 'Дана');
-- ============================================================
