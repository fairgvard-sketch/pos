-- ============================================================
-- 142. «Незакрытое» — это то, что действительно ждёт решения.
--
-- Дефект 141. Разрез `older` считал незакрытой ЛЮБУЮ заявку в активном
-- статусе, заведённую раньше сегодняшнего дня. Для POS-точки это
-- означало вот что:
--
--   accept_online_order (050/113) ставит заявке `accepted` и привязывает
--   настоящий заказ кассы. Дальше жизнь идёт в `orders` — оплата,
--   выдача, закрытие смены, — а строка `online_orders` НАВСЕГДА остаётся
--   в статусе `accepted`: двигать её больше нечему и незачем.
--
-- Наутро такая заявка попадала в «Older unresolved». Владелец видел
-- список давно принятых, оплаченных и отданных заказов с подписью
-- «закройте или отмените их», а сделать с ними ничего не мог: веб-запись
-- для POS-точки запрещена (`pos_mode`), и это правильно — финансовый
-- контур кассы кабинет не трогает. Раздел просил невозможного.
--
-- Правило теперь простое: заявка с `order_id` — не долг кабинета. Её
-- судьба решена в момент приёмки на кассе, а состояние настоящего заказа
-- видно в панели (`pos_daily_number`, `pos_status`).
--
-- Данные не переписываются. Это ответ на вопрос «что показать», а не
-- «что случилось»: ни один статус не меняется, история (140) не
-- дополняется задним числом, заявки остаются в «All orders» и находятся
-- поиском.
--
-- Работы текущего дня правило не касается: сегодняшняя принятая заявка
-- остаётся в «Active» с честной подписью «на кассе как заказ #43» —
-- владельцу полезно видеть, что пришло за смену.
--
-- Незакрытым остаётся то, что им и является: заявка в статусе `new`,
-- которую на кассе так и не приняли и не отклонили.
--
-- Тело 141 повторено дословно; изменены ровно две строки — условие
-- разреза `older` и такой же фильтр в счётчике.
--
-- ⚠️ ТРЕБУЕТ 141.
-- ============================================================

CREATE OR REPLACE FUNCTION get_online_orders_web(
  p_location_id UUID,
  p_scope       TEXT        DEFAULT 'active',
  p_from        TIMESTAMPTZ DEFAULT NULL,
  p_to          TIMESTAMPTZ DEFAULT NULL,
  p_status      TEXT        DEFAULT NULL,
  p_channel     TEXT        DEFAULT NULL,
  p_type        TEXT        DEFAULT NULL,
  p_query       TEXT        DEFAULT NULL,
  p_limit       INTEGER     DEFAULT 50,
  p_offset      INTEGER     DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_role      TEXT := auth_backoffice_role();
  v_loc       locations%ROWTYPE;
  v_tz        TEXT;
  v_mode      TEXT;
  v_scope     TEXT := COALESCE(NULLIF(TRIM(p_scope), ''), 'active');
  v_active    TEXT[] := ARRAY['new', 'accepted', 'preparing', 'ready'];
  v_day_start TIMESTAMPTZ;
  v_day_end   TIMESTAMPTZ;
  v_from      TIMESTAMPTZ;
  v_to        TIMESTAMPTZ;
  v_q         TEXT := NULLIF(TRIM(COALESCE(p_query, '')), '');
  v_limit     INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
  v_offset    INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  -- Порядок разный по смыслу: в работе первым стоит тот, кто дольше
  -- ждёт; в долгах и истории — свежие сверху.
  v_asc       BOOLEAN := v_scope IN ('active', 'scheduled');
  v_by_pickup BOOLEAN := v_scope = 'scheduled';
  v_can       BOOLEAN;
  v_shift     shifts%ROWTYPE;
  v_rows      JSONB;
  v_total     INTEGER;
  v_counts    JSONB;
BEGIN
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;
  PERFORM assert_backoffice_location(p_location_id);
  IF NOT org_has_capability(auth_org_id(), 'orders_desk') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  IF v_scope NOT IN ('active', 'older', 'scheduled', 'all') THEN
    RAISE EXCEPTION 'invalid_scope';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  v_tz := COALESCE(NULLIF(v_loc.timezone, ''), 'Asia/Jerusalem');
  v_mode := online_fulfilment_mode(v_loc.org_id, v_loc.settings);

  -- Рабочий день считается в часах ТОЧКИ: смена ориентируется на
  -- календарный день заведения, а не на часовой пояс браузера.
  v_day_start := date_trunc('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
  v_day_end := v_day_start + INTERVAL '1 day';

  -- Окно истории по умолчанию — 30 дней назад от конца текущего дня.
  v_from := COALESCE(p_from, v_day_end - INTERVAL '30 days');
  v_to := COALESCE(p_to, v_day_end);

  -- Право на действие — ответ сервера, а не вывод клиента: те же
  -- условия, что проверяет set_online_order_status_web (101/105).
  v_can := v_role IN ('owner', 'manager') AND v_mode = 'standalone';

  -- Контекст кассы для POS-точки: заявку принимают на терминале, и
  -- закрытая смена — единственная честная причина, почему её там ещё
  -- никто не видит.
  IF v_mode = 'pos' THEN
    SELECT * INTO v_shift
    FROM shifts
    WHERE location_id = p_location_id AND status = 'open'
    LIMIT 1;
  END IF;

  WITH filtered AS (
    SELECT o.*
    FROM online_orders o
    WHERE o.location_id = p_location_id
      AND (
        (v_scope = 'active'
          AND o.status = ANY (v_active)
          AND (o.pickup_at IS NULL OR o.pickup_at < v_day_end)
          AND (o.created_at >= v_day_start
               OR (o.pickup_at IS NOT NULL AND o.pickup_at >= v_day_start)))
        OR (v_scope = 'older'
          AND o.status = ANY (v_active)
          -- Заявка, принятая на кассе, — не долг кабинета (142)
          AND o.order_id IS NULL
          AND o.created_at < v_day_start
          AND (o.pickup_at IS NULL OR o.pickup_at < v_day_start))
        OR (v_scope = 'scheduled'
          AND o.status = ANY (v_active)
          AND o.pickup_at IS NOT NULL
          AND o.pickup_at >= v_day_end)
        OR (v_scope = 'all'
          AND o.created_at >= v_from
          AND o.created_at < v_to)
      )
      AND (p_status IS NULL OR o.status = p_status)
      AND (p_channel IS NULL OR COALESCE(o.order_channel, 'link') = p_channel)
      AND (p_type IS NULL OR o.order_type = p_type)
      -- Поиск по тому, что видно в строке и что называют вслух:
      -- номер заявки, номер на кассе, гость, стол, заметка, позиции.
      AND (
        v_q IS NULL
        OR o.customer_name ILIKE '%' || v_q || '%'
        OR o.customer_phone ILIKE '%' || regexp_replace(v_q, '\D', '', 'g') || '%'
        OR o.order_number::TEXT ILIKE '%' || regexp_replace(v_q, '\D', '', 'g') || '%'
        OR COALESCE(o.table_label, '') ILIKE '%' || v_q || '%'
        OR COALESCE(o.note, '') ILIKE '%' || v_q || '%'
        OR EXISTS (
          SELECT 1 FROM orders po
          WHERE po.id = o.order_id
            AND po.daily_number::TEXT = regexp_replace(v_q, '\D', '', 'g')
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(o.items) it
          WHERE jsonb_typeof(o.items) = 'array'
            AND COALESCE(it ->> 'name', '') ILIKE '%' || v_q || '%'
        )
      )
  ),
  page AS (
    SELECT
      f.*,
      ROW_NUMBER() OVER (
        ORDER BY
          CASE WHEN v_asc THEN
            CASE WHEN v_by_pickup THEN f.pickup_at ELSE f.created_at END
          END ASC NULLS LAST,
          CASE WHEN NOT v_asc THEN f.created_at END DESC NULLS LAST,
          f.id
      ) AS rn
    FROM filtered f
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM filtered),
    COALESCE(jsonb_agg(payload ORDER BY rn), '[]'::jsonb)
  INTO v_total, v_rows
  FROM (
    SELECT
      p.rn,
      jsonb_build_object(
        'id',               p.id,
        'order_number',     p.order_number,
        'status',           p.status,
        'customer_name',    p.customer_name,
        'customer_phone',   p.customer_phone,
        'order_type',       p.order_type,
        'order_channel',    COALESCE(p.order_channel, 'link'),
        'table_label',      p.table_label,
        'delivery_address', p.delivery_address,
        'note',             p.note,
        'items',            p.items,
        -- «3 items» в строке — это штуки, а не позиции меню.
        'item_count',       CASE
                              WHEN jsonb_typeof(p.items) = 'array' THEN (
                                SELECT COALESCE(SUM(COALESCE((it ->> 'qty')::INTEGER, 1)), 0)
                                FROM jsonb_array_elements(p.items) it
                              )
                              ELSE 0
                            END,
        'subtotal',         p.subtotal,
        'total',            p.total,
        'created_at',       p.created_at,
        'decided_at',       p.decided_at,
        'pickup_at',        p.pickup_at,
        'reject_reason',    p.reject_reason,
        'order_id',         p.order_id,
        -- Хендофф на кассу: настоящий номер заказа на терминале и его
        -- состояние. Ссылки в интерфейс кассы здесь нет и быть не может.
        'pos_daily_number', po.daily_number,
        'pos_status',       po.status
      ) AS payload
    FROM page p
    LEFT JOIN orders po ON po.id = p.order_id
    WHERE p.rn > v_offset AND p.rn <= v_offset + v_limit
  ) visible;

  -- Счётчики вкладок считаются всегда: вкладка без числа не отвечает на
  -- вопрос «есть ли там работа», а второй запрос ради этого не нужен.
  SELECT jsonb_build_object(
    'new', COUNT(*) FILTER (WHERE o.status = 'new'),
    'active', COUNT(*) FILTER (
      WHERE (o.pickup_at IS NULL OR o.pickup_at < v_day_end)
        AND (o.created_at >= v_day_start
             OR (o.pickup_at IS NOT NULL AND o.pickup_at >= v_day_start))
    ),
    'older', COUNT(*) FILTER (
      WHERE o.order_id IS NULL
        AND o.created_at < v_day_start
        AND (o.pickup_at IS NULL OR o.pickup_at < v_day_start)
    ),
    'scheduled', COUNT(*) FILTER (
      WHERE o.pickup_at IS NOT NULL AND o.pickup_at >= v_day_end
    )
  )
  INTO v_counts
  FROM online_orders o
  WHERE o.location_id = p_location_id
    AND o.status = ANY (v_active);

  RETURN jsonb_build_object(
    'scope',      v_scope,
    'mode',       v_mode,
    'role',       v_role,
    'can_manage', v_can,
    'timezone',   v_tz,
    'currency',   v_loc.currency,
    'day_start',  v_day_start,
    'day_end',    v_day_end,
    'from',       v_from,
    'to',         v_to,
    'counts',     v_counts,
    'total',      v_total,
    'limit',      v_limit,
    'offset',     v_offset,
    -- Для POS-точки: смена открыта — заявку видят на терминале сейчас;
    -- закрыта — её там никто не примет, и об этом надо сказать прямо.
    'pos',        jsonb_build_object(
                    'shift_open', v_shift.id IS NOT NULL,
                    'shift_opened_at', v_shift.opened_at
                  ),
    'rows',       v_rows
  );
END $$;

REVOKE ALL ON FUNCTION get_online_orders_web(
  UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_online_orders_web(
  UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER
) TO authenticated;

COMMENT ON FUNCTION get_online_orders_web(
  UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER
) IS
  'Рабочий стол заказов кабинета (141, правило долга уточнено в 142): разрезы active/older/scheduled/all, серверные фильтры, поиск и пагинация, счётчики вкладок, режим точки и честное can_manage. Заявка, принятая на кассе, долгом не считается.';

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only и безопасно: функция только читает, данные не менялись.
-- Вернуть прежнее поведение — переиздать тело 141 новой миграцией.
--
-- ПРОВЕРКА на целевой базе (под веб-владельцем POS-точки):
--   SELECT get_online_orders_web('<location>') -> 'counts' ->> 'older';
--   -- должно совпасть с числом НЕ принятых на кассе заявок прошлых дней:
--   SELECT COUNT(*) FROM online_orders
--   WHERE location_id = '<location>' AND order_id IS NULL
--     AND status IN ('new','accepted','preparing','ready')
--     AND created_at < date_trunc('day', NOW() AT TIME ZONE 'Asia/Jerusalem')
--                      AT TIME ZONE 'Asia/Jerusalem';
-- ============================================================
