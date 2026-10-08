-- ============================================================
-- 180 ТЕЛЕФОН ОФИЦИАНТА: ТОЛЬКО ЗАКАЗ, ТИКЕТ ПЕЧАТАЕТ T2
--
-- Официант берёт заказ у стола со своего телефона: столы → счёт →
-- меню → «Отправить». Оплата, возвраты, скидки, отмены, смены, отчёты и
-- гости остаются на основной кассе.
--
-- МОДЕЛЬ ДОСТУПА (телефоны личные).
--   Телефон один раз допускается в точку одноразовым кодом от владельца
--   или менеджера. Edge Function waiter-pair создаёт телефону ОТДЕЛЬНЫЙ
--   Auth-аккаунт БЕЗ org_id/location_id в app_metadata. Для RLS это
--   посторонний: auth_org_id() возвращает NULL, прямым запросом телефон
--   не читает ни одной строки — ни заказов, ни гостей, ни выручки.
--   Работает он только через функции waiter_* ниже: телефон находится
--   по auth.uid() в waiter_devices, PIN официанта даёт staff-сессию.
--   Официант к телефону не привязан: вводит свой PIN. Уволился —
--   владелец удаляет сотрудника, PIN и его сессии перестают работать.
--   Отключить сам телефон — revoke_waiter_device_web.
--
-- ПЕРЕИСПОЛЬЗОВАНИЕ ЛОГИКИ КАССЫ. Открытие стола, дозаказ, курсы и Fire
-- идут через те же функции, что у T2 (086/105/179): цены, НДС, удержание
-- курсов и идемпотентность одни на всех. Эти функции берут точку из JWT,
-- поэтому тела _waiter_* после проверки телефона и сессии подставляют в
-- request.jwt.claims точку телефона (_waiter_act_as), а публичные
-- обёртки waiter_* возвращают исходные claims перед выходом. Повышение
-- области живёт только внутри вызова: его делает SECURITY DEFINER код
-- этой миграции после проверки привязки; клиент set_config вызвать не может.
--
-- ПЕЧАТЬ. Заказ и задание печати пишутся одной транзакцией: строки без
-- тикета не бывает. Касса T2 с включённой настройкой «Печатать заказы
-- официантов» забирает задания (claim_print_jobs, SKIP LOCKED — ровно
-- одна касса) и отчитывается (finish_print_job). Официант видит статус.
--
-- БЕЗ СЕТИ телефон не копит заказы: честное «не отправлено» и повтор с
-- тем же op_uuid (op_log 042 не даст задвоить строки).
--
-- ⚠️ ТРЕБУЕТ 179 (курсы/Fire), 135 (_device_web_guard), 095 (throttle PIN).
-- ============================================================

-- ── Схема ───────────────────────────────────────────────────
CREATE TABLE waiter_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Auth-аккаунт телефона без org в JWT. NULL — аккаунт удалён при отключении.
  auth_user_id UUID UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID,
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  revoked_by   UUID
);

CREATE INDEX idx_waiter_devices_org ON waiter_devices (org_id, created_at DESC);

COMMENT ON TABLE waiter_devices IS
  'Телефоны официантов (180): допуск в точку; доступ только через waiter_*';

CREATE TABLE waiter_pairing_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Хранится только sha256: код живёт 10 минут и одноразовый
  code_hash   TEXT NOT NULL UNIQUE,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  device_id   UUID REFERENCES waiter_devices(id) ON DELETE SET NULL
);

CREATE INDEX idx_waiter_pairing_codes_location
  ON waiter_pairing_codes (location_id, expires_at) WHERE used_at IS NULL;

CREATE TABLE print_jobs (
  -- = op_uuid операции телефона: повтор не создаёт второй тикет
  id                  UUID PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id         UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  order_id            UUID REFERENCES orders(id) ON DELETE SET NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('kitchen')),
  -- Снимок тикета на момент заказа (имена, модификаторы, заметки, стол)
  payload             JSONB NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'printing', 'printed', 'failed', 'expired')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  waiter_device_id    UUID REFERENCES waiter_devices(id) ON DELETE SET NULL,
  staff_id            UUID REFERENCES staff(id) ON DELETE SET NULL,
  claimed_device_uuid UUID,
  claimed_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_print_jobs_queue
  ON print_jobs (location_id, created_at) WHERE status IN ('pending', 'printing');

COMMENT ON TABLE print_jobs IS
  'Задания печати с телефонов официантов (180); печатает касса T2 точки';

-- ── Доступ: таблицы закрыты, только функции ─────────────────
ALTER TABLE waiter_devices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiter_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_jobs           ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON waiter_devices, waiter_pairing_codes, print_jobs FROM anon, authenticated, public;
GRANT ALL ON waiter_devices, waiter_pairing_codes, print_jobs TO service_role;

-- Касса точки читает свои задания: Realtime доставляет INSERT только
-- тем, кому строка видна. Кабинет (JWT без точки) и телефон — не видят.
GRANT SELECT ON print_jobs TO authenticated;
CREATE POLICY print_jobs_location_read ON print_jobs FOR SELECT TO authenticated
  USING (org_id = auth_org_id() AND location_id = auth_location_id());

ALTER PUBLICATION supabase_realtime ADD TABLE print_jobs;

-- ── Хелперы телефона ────────────────────────────────────────
-- Телефон этого Auth-аккаунта. Отключённый или чужой аккаунт — отказ.
CREATE FUNCTION _waiter_device()
RETURNS waiter_devices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dev waiter_devices;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_dev FROM waiter_devices
  WHERE auth_user_id = auth.uid() AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'waiter_device_revoked';
  END IF;

  -- «Был в сети» для списка в кабинете; не чаще раза в минуту
  IF v_dev.last_seen_at IS NULL OR v_dev.last_seen_at < NOW() - INTERVAL '1 minute' THEN
    UPDATE waiter_devices SET last_seen_at = NOW() WHERE id = v_dev.id;
  END IF;

  RETURN v_dev;
END $$;

REVOKE ALL ON FUNCTION _waiter_device() FROM PUBLIC, anon, authenticated;

-- Подставить точку телефона в claims: дальше функции кассы
-- (auth_org_id/auth_location_id) видят телефон как устройство этой
-- точки. Вызывается ТОЛЬКО после _waiter_device(); снимает подстановку
-- публичная обёртка (_waiter_restore_claims).
CREATE FUNCTION _waiter_act_as(p_dev waiter_devices)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claims JSONB := COALESCE(NULLIF(current_setting('request.jwt.claims', TRUE), '')::JSONB, '{}'::JSONB);
BEGIN
  v_claims := v_claims || jsonb_build_object(
    'app_metadata',
    COALESCE(v_claims -> 'app_metadata', '{}'::JSONB)
      || jsonb_build_object('org_id', p_dev.org_id, 'location_id', p_dev.location_id)
  );
  PERFORM set_config('request.jwt.claims', v_claims::TEXT, TRUE);
END $$;

REVOKE ALL ON FUNCTION _waiter_act_as(waiter_devices) FROM PUBLIC, anon, authenticated;

-- Телефон + действующая staff-сессия этой точки. Строгий режим: без
-- сессии отказ (мягкий режим 086 для телефона не действует).
CREATE FUNCTION _waiter_enter(p_staff_session UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dev   waiter_devices;
  v_staff staff%ROWTYPE;
BEGIN
  v_dev := _waiter_device();
  PERFORM _waiter_act_as(v_dev);
  PERFORM require_org_capability('pos_operate');

  IF p_staff_session IS NULL THEN
    RAISE EXCEPTION 'staff session required';
  END IF;

  SELECT s.* INTO v_staff
  FROM staff_sessions ss
  JOIN staff s ON s.id = ss.staff_id
  WHERE ss.token = p_staff_session
    AND ss.org_id = v_dev.org_id
    AND ss.location_id = v_dev.location_id
    AND ss.revoked_at IS NULL
    AND ss.expires_at > NOW()
    AND s.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff session invalid';
  END IF;

  UPDATE staff_sessions
  SET expires_at = GREATEST(expires_at, NOW() + INTERVAL '72 hours')
  WHERE token = p_staff_session;

  RETURN jsonb_build_object(
    'device_id',   v_dev.id,
    'org_id',      v_dev.org_id,
    'location_id', v_dev.location_id,
    'staff_id',    v_staff.id,
    'staff_name',  v_staff.name
  );
END $$;

REVOKE ALL ON FUNCTION _waiter_enter(UUID) FROM PUBLIC, anon, authenticated;

-- Строки кухонного тикета в порядке p_ids: только то, что кухня
-- готовит сейчас (придержанное и снятое не печатается). VOLATILE: читает
-- строки, только что вставленные дозаказом в этой же транзакции.
CREATE FUNCTION _waiter_ticket_lines(p_ids UUID[])
RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'qty',         i.qty,
      'name',        i.name,
      'variantName', i.variant_name,
      'modifiers',   COALESCE((SELECT jsonb_agg(m.name ORDER BY m.name)
                               FROM order_item_modifiers m
                               WHERE m.order_item_id = i.id), '[]'::JSONB),
      'notes',       COALESCE(i.notes, '')
    ) ORDER BY x.ord), '[]'::JSONB)
  FROM unnest(p_ids) WITH ORDINALITY AS x(id, ord)
  JOIN order_items i ON i.id = x.id
  WHERE NOT i.held AND i.voided_at IS NULL
$$;

REVOKE ALL ON FUNCTION _waiter_ticket_lines(UUID[]) FROM PUBLIC, anon, authenticated;

-- ── PIN официанта на телефоне ───────────────────────────────
-- verify_staff_pin (095) как есть: throttle по (org, auth.uid()) — то
-- есть по этому телефону, касса T2 перебором с телефона не блокируется.
-- Неверный PIN — ok:false, а не исключение: откат транзакции стёр бы
-- след неудачи и выключил throttle.
CREATE FUNCTION _waiter_unlock(p_pin TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dev waiter_devices;
  v_row RECORD;
  v_loc locations%ROWTYPE;
BEGIN
  v_dev := _waiter_device();
  PERFORM _waiter_act_as(v_dev);
  PERFORM require_org_capability('pos_operate');

  IF p_pin IS NULL OR p_pin !~ '^[0-9]{4,8}$' THEN
    RETURN json_build_object('ok', FALSE);
  END IF;

  SELECT * INTO v_row FROM verify_staff_pin(p_pin) LIMIT 1;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', FALSE);
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = v_dev.location_id;

  RETURN json_build_object(
    'ok', TRUE,
    'session_token', v_row.session_token,
    'staff', json_build_object('id', v_row.id, 'name', v_row.name, 'role', v_row.role),
    'location', json_build_object(
      'id',           v_loc.id,
      'name',         COALESCE(NULLIF(btrim(v_loc.settings ->> 'display_name'), ''), v_loc.name),
      'timezone',     v_loc.timezone,
      'service_mode', v_loc.service_mode
    )
  );
END $$;

REVOKE ALL ON FUNCTION _waiter_unlock(TEXT) FROM PUBLIC, anon, authenticated;

-- ── Чтение: зал, меню, счёт стола ───────────────────────────
CREATE FUNCTION _waiter_hall(p_staff_session UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v     JSONB := _waiter_enter(p_staff_session);
  v_loc UUID  := (v ->> 'location_id')::UUID;
BEGIN
  RETURN json_build_object(
    'shift_open', EXISTS (SELECT 1 FROM shifts WHERE location_id = v_loc AND status = 'open'),
    -- Есть ли касса, которая напечатает тикет: настройка включена и
    -- касса недавно была в сети (heartbeat 074 — раз в 5 минут)
    'printer_ready', EXISTS (
      SELECT 1 FROM devices d
      WHERE d.location_id = v_loc
        AND d.archived_at IS NULL
        AND COALESCE((d.settings ->> 'printWaiterTickets')::BOOLEAN, FALSE)
        AND d.last_seen_at > NOW() - INTERVAL '15 minutes'
    ),
    'zones', COALESCE((
      SELECT json_agg(json_build_object('id', z.id, 'name', z.name, 'sort_order', z.sort_order)
                      ORDER BY z.sort_order, z.name)
      FROM table_zones z
      WHERE z.location_id = v_loc AND z.is_active
    ), '[]'::JSON),
    'tables', COALESCE((
      SELECT json_agg(json_build_object(
               'id', t.id, 'label', t.label, 'zone_id', t.zone_id, 'zone', t.zone,
               'sort_order', t.sort_order, 'seats', t.seats, 'status', t.status)
             ORDER BY t.sort_order, t.label)
      FROM tables t
      WHERE t.location_id = v_loc AND t.is_active
    ), '[]'::JSON),
    'open', COALESCE((
      SELECT json_agg(json_build_object(
               'table_id',     o.table_id,
               'order_id',     o.id,
               'total',        o.total,
               'daily_number', o.daily_number,
               'opened_at',    o.created_at,
               'staff_name',   s.name,
               'item_count',   COALESCE((SELECT SUM(i.qty) FROM order_items i
                                         WHERE i.order_id = o.id AND i.voided_at IS NULL), 0),
               'has_held',     EXISTS (SELECT 1 FROM order_items i
                                       WHERE i.order_id = o.id AND i.held AND i.voided_at IS NULL)))
      FROM orders o
      LEFT JOIN staff s ON s.id = o.staff_id
      WHERE o.location_id = v_loc AND o.status = 'open' AND o.table_id IS NOT NULL
    ), '[]'::JSON)
  );
END $$;

REVOKE ALL ON FUNCTION _waiter_hall(UUID) FROM PUBLIC, anon, authenticated;

-- Меню в форме POS-типов (MenuCategory/MenuItem/ModifierGroup), без
-- себестоимости и складских полей: официанту нужна только витрина.
CREATE FUNCTION _waiter_menu(p_staff_session UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v     JSONB := _waiter_enter(p_staff_session);
  v_org UUID  := (v ->> 'org_id')::UUID;
BEGIN
  RETURN json_build_object(
    'categories', COALESCE((
      SELECT json_agg(json_build_object(
               'id', c.id, 'name', c.name, 'icon', c.icon,
               'sort_order', c.sort_order, 'is_active', c.is_active)
             ORDER BY c.sort_order, c.name)
      FROM menu_categories c
      WHERE c.org_id = v_org AND c.is_active
    ), '[]'::JSON),
    'items', COALESCE((
      SELECT json_agg(json_build_object(
               'id', mi.id, 'category_id', mi.category_id, 'name', mi.name,
               'price', mi.price, 'is_available', mi.is_available,
               'ask_modifiers', mi.ask_modifiers, 'sort_order', mi.sort_order,
               'course', mi.course,
               'item_variants', COALESCE((
                 SELECT json_agg(json_build_object(
                          'id', iv.id, 'item_id', iv.item_id, 'name', iv.name, 'price', iv.price,
                          'is_default', iv.is_default, 'sort_order', iv.sort_order)
                        ORDER BY iv.sort_order)
                 FROM item_variants iv WHERE iv.item_id = mi.id), '[]'::JSON),
               'menu_item_modifier_groups', COALESCE((
                 SELECT json_agg(json_build_object('group_id', l.group_id, 'sort_order', l.sort_order)
                        ORDER BY l.sort_order)
                 FROM menu_item_modifier_groups l WHERE l.item_id = mi.id), '[]'::JSON))
             ORDER BY mi.sort_order, mi.name)
      FROM menu_items mi
      WHERE mi.org_id = v_org
    ), '[]'::JSON),
    'modifier_groups', COALESCE((
      SELECT json_agg(json_build_object(
               'id', g.id, 'name', g.name, 'min_select', g.min_select,
               'max_select', g.max_select, 'sort_order', g.sort_order,
               'modifiers', COALESCE((
                 SELECT json_agg(json_build_object(
                          'id', m.id, 'group_id', m.group_id, 'name', m.name,
                          'price_delta', m.price_delta, 'is_default', m.is_default,
                          'is_available', m.is_available, 'sort_order', m.sort_order)
                        ORDER BY m.sort_order)
                 FROM modifiers m WHERE m.group_id = g.id), '[]'::JSON))
             ORDER BY g.sort_order, g.name)
      FROM modifier_groups g
      WHERE g.org_id = v_org
    ), '[]'::JSON)
  );
END $$;

REVOKE ALL ON FUNCTION _waiter_menu(UUID) FROM PUBLIC, anon, authenticated;

-- Открытый счёт стола (или order:null, если стол свободен)
CREATE FUNCTION _waiter_bill(p_staff_session UUID, p_table_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v       JSONB := _waiter_enter(p_staff_session);
  v_loc   UUID  := (v ->> 'location_id')::UUID;
  v_order orders%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tables WHERE id = p_table_id AND location_id = v_loc AND is_active) THEN
    RAISE EXCEPTION 'table not found';
  END IF;

  SELECT * INTO v_order FROM orders
  WHERE table_id = p_table_id AND location_id = v_loc AND status = 'open';
  IF NOT FOUND THEN
    RETURN json_build_object('order', NULL, 'lines', '[]'::JSON);
  END IF;

  RETURN json_build_object(
    'order', json_build_object(
      'id', v_order.id, 'daily_number', v_order.daily_number,
      'total', v_order.total, 'opened_at', v_order.created_at),
    'lines', COALESCE((
      SELECT json_agg(json_build_object(
               'id', i.id, 'name', i.name, 'variant_name', i.variant_name,
               'qty', i.qty, 'line_total', i.line_total,
               'modifiers', COALESCE((SELECT json_agg(m.name ORDER BY m.name)
                                      FROM order_item_modifiers m
                                      WHERE m.order_item_id = i.id), '[]'::JSON),
               'notes', i.notes, 'course', i.course, 'held', i.held)
             ORDER BY i.course NULLS FIRST, i.name)
      FROM order_items i
      WHERE i.order_id = v_order.id AND i.voided_at IS NULL
    ), '[]'::JSON)
  );
END $$;

REVOKE ALL ON FUNCTION _waiter_bill(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ── Отправить на кухню: стол + дозаказ + тикет одной транзакцией ──
-- p_items: [{id, menu_item_id, variant_id?, modifier_ids?, qty, notes?, course?}]
-- id строки выдаёт телефон до первой попытки. Ручной цены и свободной
-- позиции у официанта нет — только каталог, только доступные блюда.
CREATE FUNCTION _waiter_send(
  p_staff_session UUID,
  p_table_id      UUID,
  p_op_uuid       UUID,
  p_items         JSONB
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v        JSONB := _waiter_enter(p_staff_session);
  v_org    UUID  := (v ->> 'org_id')::UUID;
  v_loc    UUID  := (v ->> 'location_id')::UUID;
  v_staff  UUID  := (v ->> 'staff_id')::UUID;
  v_prev   JSONB;
  v_label  TEXT;
  v_item   JSONB;
  v_id     UUID;
  v_ids    UUID[] := '{}';
  v_items  JSONB  := '[]'::JSONB;
  v_clean  JSONB;
  v_open   JSON;
  v_order  UUID;
  v_append JSON;
  v_lines  JSONB;
  v_job    UUID;
BEGIN
  IF p_op_uuid IS NULL THEN
    RAISE EXCEPTION 'op_uuid required';
  END IF;

  -- Повтор после таймаута: дозаказ уже проведён (op_log пишет append)
  SELECT result INTO v_prev FROM op_log WHERE op_uuid = p_op_uuid AND org_id = v_org;
  IF FOUND THEN
    RETURN json_build_object(
      'order_id', v_prev ->> 'order_id',
      'total',    (v_prev ->> 'total')::INTEGER,
      'job_id',   (SELECT id FROM print_jobs WHERE id = p_op_uuid),
      'replay',   TRUE
    );
  END IF;

  SELECT label INTO v_label FROM tables
  WHERE id = p_table_id AND location_id = v_loc AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table not found';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order has no items';
  END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'too many items';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'invalid item';
    END IF;
    IF v_item ? 'unit_price_override' OR v_item ? 'custom_name' THEN
      RAISE EXCEPTION 'waiter_price_forbidden';
    END IF;
    v_id := NULLIF(v_item ->> 'id', '')::UUID;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'line id required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM menu_items
      WHERE id = NULLIF(v_item ->> 'menu_item_id', '')::UUID
        AND org_id = v_org AND is_available
    ) THEN
      RAISE EXCEPTION 'item_unavailable';
    END IF;

    -- Белый список ключей: всё прочее телефон в append_to_order не передаст
    v_clean := jsonb_build_object(
      'id',           v_id,
      'menu_item_id', v_item -> 'menu_item_id',
      'qty',          COALESCE(v_item -> 'qty', '1'::JSONB),
      'notes',        LEFT(COALESCE(v_item ->> 'notes', ''), 200)
    );
    IF NULLIF(v_item ->> 'variant_id', '') IS NOT NULL THEN
      v_clean := v_clean || jsonb_build_object('variant_id', v_item -> 'variant_id');
    END IF;
    IF jsonb_typeof(v_item -> 'modifier_ids') = 'array' THEN
      v_clean := v_clean || jsonb_build_object('modifier_ids', v_item -> 'modifier_ids');
    END IF;
    -- Курс: ключ есть (null = «без курса») — выбор официанта, нет — каталог
    IF v_item ? 'course' THEN
      v_clean := v_clean || jsonb_build_object('course', v_item -> 'course');
    END IF;

    v_items := v_items || jsonb_build_array(v_clean);
    v_ids := v_ids || v_id;
  END LOOP;

  -- Те же функции, что у кассы: открыть/взять счёт, дозаказ с курсами
  v_open := open_or_get_table_order(p_table_id, v_staff, NULL, NULL, p_staff_session);
  v_order := (v_open ->> 'order_id')::UUID;
  v_append := append_to_order(v_order, v_staff, v_items, p_op_uuid, p_staff_session);

  -- Тикет — только то, что кухня готовит сейчас; придержанное уйдёт по Fire
  v_lines := _waiter_ticket_lines(v_ids);
  IF jsonb_array_length(v_lines) > 0 THEN
    INSERT INTO print_jobs (id, org_id, location_id, order_id, kind, payload,
                            waiter_device_id, staff_id)
    VALUES (p_op_uuid, v_org, v_loc, v_order, 'kitchen',
            jsonb_build_object('tableLabel', v_label, 'staffName', v ->> 'staff_name',
                               'fire', FALSE, 'lines', v_lines),
            (v ->> 'device_id')::UUID, v_staff)
    ON CONFLICT (id) DO NOTHING;
    v_job := p_op_uuid;
  END IF;

  RETURN json_build_object(
    'order_id',     v_order,
    'total',        (v_append ->> 'total')::INTEGER,
    'daily_number', (v_open ->> 'daily_number')::INTEGER,
    'job_id',       v_job,
    'held',         (SELECT COUNT(*) FROM order_items WHERE id = ANY(v_ids) AND held),
    'replay',       FALSE
  );
END $$;

REVOKE ALL ON FUNCTION _waiter_send(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;

-- ── Fire с телефона ─────────────────────────────────────────
CREATE FUNCTION _waiter_fire(
  p_staff_session UUID,
  p_order_id      UUID,
  p_item_ids      UUID[],
  p_op_uuid       UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v       JSONB := _waiter_enter(p_staff_session);
  v_org   UUID  := (v ->> 'org_id')::UUID;
  v_loc   UUID  := (v ->> 'location_id')::UUID;
  v_staff UUID  := (v ->> 'staff_id')::UUID;
  v_label TEXT;
  v_res   JSON;
  v_fired UUID[];
  v_lines JSONB;
BEGIN
  IF p_op_uuid IS NULL THEN
    RAISE EXCEPTION 'op_uuid required';
  END IF;

  SELECT table_label INTO v_label FROM orders
  WHERE id = p_order_id AND location_id = v_loc AND table_id IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF COALESCE(cardinality(p_item_ids), 0) = 0 THEN
    RAISE EXCEPTION 'nothing to fire';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_item_ids) x
    WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.id = x AND i.order_id = p_order_id)
  ) THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  v_res := fire_order_items(p_item_ids, v_staff, p_staff_session);
  v_fired := ARRAY(SELECT json_array_elements_text(v_res -> 'fired')::UUID);

  -- Повтор: строки уже отправлены, fired пуст — тикет первого раза в силе
  IF cardinality(v_fired) > 0 THEN
    v_lines := _waiter_ticket_lines(v_fired);
    INSERT INTO print_jobs (id, org_id, location_id, order_id, kind, payload,
                            waiter_device_id, staff_id)
    VALUES (p_op_uuid, v_org, v_loc, p_order_id, 'kitchen',
            jsonb_build_object('tableLabel', v_label, 'staffName', v ->> 'staff_name',
                               'fire', TRUE, 'lines', v_lines),
            (v ->> 'device_id')::UUID, v_staff)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN json_build_object(
    'fired',  v_res -> 'fired',
    'job_id', (SELECT id FROM print_jobs WHERE id = p_op_uuid)
  );
END $$;

REVOKE ALL ON FUNCTION _waiter_fire(UUID, UUID, UUID[], UUID) FROM PUBLIC, anon, authenticated;

-- Статус тикетов, отправленных с телефона
CREATE FUNCTION _waiter_print_status(p_staff_session UUID, p_job_ids UUID[])
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v     JSONB := _waiter_enter(p_staff_session);
  v_loc UUID  := (v ->> 'location_id')::UUID;
BEGIN
  IF COALESCE(cardinality(p_job_ids), 0) > 50 THEN
    RAISE EXCEPTION 'too many jobs';
  END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object('id', j.id, 'status', j.status, 'error', j.error))
    FROM print_jobs j
    WHERE j.id = ANY(p_job_ids) AND j.location_id = v_loc
  ), '[]'::JSON);
END $$;

REVOKE ALL ON FUNCTION _waiter_print_status(UUID, UUID[]) FROM PUBLIC, anon, authenticated;

-- ── Касса T2: забрать и отчитаться ──────────────────────────
-- Без staff-сессии: касса печатает и на экране PIN. Ровно одна касса
-- получает задание (FOR UPDATE SKIP LOCKED).
CREATE FUNCTION claim_print_jobs(p_device_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org  UUID := auth_org_id();
  v_loc  UUID := auth_location_id();
  v_jobs JSON;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_org_capability('pos_operate');

  -- Залежавшееся не печатаем: тикет получасовой давности кухня примет
  -- за новый заказ. Официант видит «не напечатан» и говорит кухне.
  UPDATE print_jobs
  SET status = 'expired', finished_at = NOW(), error = 'expired'
  WHERE location_id = v_loc AND status = 'pending'
    AND created_at < NOW() - INTERVAL '30 minutes';

  -- Касса пропала посреди печати: напечаталось или нет — неизвестно.
  -- Вслепую не повторяем (двойной тикет = двойная готовка).
  UPDATE print_jobs
  SET status = 'failed', finished_at = NOW(), error = 'interrupted'
  WHERE location_id = v_loc AND status = 'printing'
    AND claimed_at < NOW() - INTERVAL '2 minutes';

  WITH picked AS (
    SELECT id FROM print_jobs
    WHERE location_id = v_loc AND status = 'pending'
    ORDER BY created_at
    LIMIT 10
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE print_jobs j
    SET status = 'printing', claimed_device_uuid = p_device_uuid,
        claimed_at = NOW(), attempts = j.attempts + 1
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.id, j.kind, j.payload, j.created_at
  )
  SELECT COALESCE(json_agg(json_build_object(
           'id', id, 'kind', kind, 'payload', payload, 'created_at', created_at)
         ORDER BY created_at), '[]'::JSON)
  INTO v_jobs FROM claimed;

  RETURN v_jobs;
END $$;

REVOKE ALL ON FUNCTION claim_print_jobs(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION claim_print_jobs(UUID) TO authenticated;

-- Итог печати. failed → printed разрешён: кассир нажал «повторить».
CREATE FUNCTION finish_print_job(p_job_id UUID, p_ok BOOLEAN, p_error TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE print_jobs
  SET status = CASE WHEN p_ok THEN 'printed' ELSE 'failed' END,
      finished_at = NOW(),
      error = CASE WHEN p_ok THEN NULL ELSE LEFT(COALESCE(NULLIF(p_error, ''), 'error'), 200) END
  WHERE id = p_job_id AND location_id = v_loc AND status IN ('printing', 'failed');
END $$;

REVOKE ALL ON FUNCTION finish_print_job(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION finish_print_job(UUID, BOOLEAN, TEXT) TO authenticated;

-- ── Допуск телефона ─────────────────────────────────────────
-- Код создаёт владелец/менеджер (кабинет ANGLE) или касса с правом manage.
CREATE FUNCTION create_waiter_pairing_code(
  p_location_id   UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  -- Без похожих символов (0/O, 1/I/L): код могут продиктовать голосом
  c_alpha CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_org   UUID;
  v_loc   UUID;
  v_bytes BYTEA;
  v_code  TEXT := '';
  v_exp   TIMESTAMPTZ := NOW() + INTERVAL '10 minutes';
  i       INTEGER;
BEGIN
  PERFORM _device_web_guard(p_staff_session);
  PERFORM require_org_capability('pos_operate');
  v_org := auth_org_id();
  v_loc := COALESCE(p_location_id, auth_location_id());
  IF v_loc IS NULL OR NOT EXISTS (SELECT 1 FROM locations WHERE id = v_loc AND org_id = v_org) THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  DELETE FROM waiter_pairing_codes
  WHERE used_at IS NULL AND expires_at < NOW() - INTERVAL '1 day';
  IF (SELECT COUNT(*) FROM waiter_pairing_codes
      WHERE location_id = v_loc AND used_at IS NULL AND expires_at > NOW()) >= 20 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- 8 символов из 31: ~4·10^11 вариантов на 10 минут жизни кода
  v_bytes := gen_random_bytes(16);
  FOR i IN 0..15 LOOP
    -- Отбрасываем байты ≥ 248, чтобы остаток от деления на 31 был равномерным
    IF get_byte(v_bytes, i) < 248 THEN
      v_code := v_code || substr(c_alpha, (get_byte(v_bytes, i) % 31) + 1, 1);
    END IF;
    EXIT WHEN length(v_code) = 8;
  END LOOP;
  IF length(v_code) < 8 THEN
    RAISE EXCEPTION 'try_again';
  END IF;

  INSERT INTO waiter_pairing_codes (org_id, location_id, code_hash, created_by, expires_at)
  VALUES (v_org, v_loc, encode(digest(v_code, 'sha256'), 'hex'), auth.uid(), v_exp);

  RETURN json_build_object('code', v_code, 'expires_at', v_exp, 'location_id', v_loc);
END $$;

REVOKE ALL ON FUNCTION create_waiter_pairing_code(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_waiter_pairing_code(UUID, UUID) TO authenticated;

-- Нормализация введённого кода: регистр, пробелы и дефисы не важны
CREATE FUNCTION _waiter_code_hash(p_code TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, extensions AS $$
  SELECT encode(digest(upper(regexp_replace(COALESCE(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex')
$$;

REVOKE ALL ON FUNCTION _waiter_code_hash(TEXT) FROM PUBLIC, anon, authenticated;

-- Только Edge Function waiter-pair (service_role): код действителен?
CREATE FUNCTION waiter_pair_check(p_code TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code waiter_pairing_codes%ROWTYPE;
  v_name TEXT;
BEGIN
  SELECT * INTO v_code FROM waiter_pairing_codes
  WHERE code_hash = _waiter_code_hash(p_code) AND used_at IS NULL AND expires_at > NOW();
  IF NOT FOUND THEN
    -- Тормоз перебора: человеку незаметно, скрипту — часы
    PERFORM pg_sleep(0.3);
    RAISE EXCEPTION 'invalid_code';
  END IF;
  IF NOT org_has_capability(v_code.org_id, 'pos_operate') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  SELECT COALESCE(NULLIF(btrim(settings ->> 'display_name'), ''), name) INTO v_name
  FROM locations WHERE id = v_code.location_id;

  RETURN json_build_object('location_name', v_name);
END $$;

REVOKE ALL ON FUNCTION waiter_pair_check(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION waiter_pair_check(TEXT) TO service_role;

-- Только waiter-pair: погасить код и привязать созданный аккаунт телефона.
-- Код гасится условным UPDATE — два телефона одним кодом не пройдут.
CREATE FUNCTION waiter_pair_bind(p_code TEXT, p_auth_user_id UUID, p_label TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code waiter_pairing_codes%ROWTYPE;
  v_dev  UUID;
  v_name TEXT;
BEGIN
  IF p_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_account';
  END IF;

  UPDATE waiter_pairing_codes SET used_at = NOW()
  WHERE code_hash = _waiter_code_hash(p_code) AND used_at IS NULL AND expires_at > NOW()
  RETURNING * INTO v_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_code';
  END IF;

  INSERT INTO waiter_devices (org_id, location_id, auth_user_id, label, created_by)
  VALUES (v_code.org_id, v_code.location_id, p_auth_user_id,
          LEFT(COALESCE(btrim(p_label), ''), 60), v_code.created_by)
  RETURNING id INTO v_dev;

  UPDATE waiter_pairing_codes SET device_id = v_dev WHERE id = v_code.id;

  SELECT COALESCE(NULLIF(btrim(settings ->> 'display_name'), ''), name) INTO v_name
  FROM locations WHERE id = v_code.location_id;

  RETURN json_build_object('device_id', v_dev, 'location_name', v_name);
END $$;

REVOKE ALL ON FUNCTION waiter_pair_bind(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION waiter_pair_bind(TEXT, UUID, TEXT) TO service_role;

-- ── Кабинет: список и отключение телефонов ──────────────────
CREATE FUNCTION list_waiter_devices_web(p_staff_session UUID DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM _device_web_guard(p_staff_session);
  RETURN COALESCE((
    SELECT json_agg(json_build_object(
             'id', d.id, 'location_id', d.location_id,
             'location_name', COALESCE(NULLIF(btrim(l.settings ->> 'display_name'), ''), l.name),
             'label', d.label, 'created_at', d.created_at,
             'last_seen_at', d.last_seen_at, 'revoked_at', d.revoked_at,
             -- «Был в сети» считает сервер на своих часах, как парк касс (097)
             'silence_seconds', CASE WHEN d.last_seen_at IS NULL THEN NULL
                                     ELSE EXTRACT(EPOCH FROM NOW() - d.last_seen_at)::INTEGER END)
           ORDER BY d.revoked_at NULLS FIRST, d.created_at DESC)
    FROM waiter_devices d
    JOIN locations l ON l.id = d.location_id
    WHERE d.org_id = auth_org_id()
      -- Отключённые видны месяц: «кто и когда отключил», потом не мешают
      AND (d.revoked_at IS NULL OR d.revoked_at > NOW() - INTERVAL '30 days')
  ), '[]'::JSON);
END $$;

REVOKE ALL ON FUNCTION list_waiter_devices_web(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_waiter_devices_web(UUID) TO authenticated;

-- Отключить телефон: доступ закрывается сразу (waiter_* проверяют
-- revoked_at), аккаунт телефона удаляется — вход закрыт и в Auth.
CREATE FUNCTION revoke_waiter_device_web(p_device_id UUID, p_staff_session UUID DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dev waiter_devices%ROWTYPE;
BEGIN
  PERFORM _device_web_guard(p_staff_session);

  SELECT * INTO v_dev FROM waiter_devices
  WHERE id = p_device_id AND org_id = auth_org_id()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_dev.revoked_at IS NOT NULL THEN
    RETURN json_build_object('device_id', v_dev.id, 'revoked_at', v_dev.revoked_at);
  END IF;

  UPDATE waiter_devices
  SET revoked_at = NOW(), revoked_by = auth.uid(), auth_user_id = NULL
  WHERE id = v_dev.id;

  -- Только выделенный аккаунт телефона: не касса и не человек из кабинета
  IF v_dev.auth_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM devices WHERE auth_user_id = v_dev.auth_user_id)
     AND NOT EXISTS (SELECT 1 FROM organization_members WHERE auth_user_id = v_dev.auth_user_id) THEN
    DELETE FROM auth.users WHERE id = v_dev.auth_user_id;
  END IF;

  RETURN json_build_object('device_id', v_dev.id, 'revoked_at', NOW());
END $$;

REVOKE ALL ON FUNCTION revoke_waiter_device_web(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION revoke_waiter_device_web(UUID, UUID) TO authenticated;

-- ── Публичные функции телефона ──────────────────────────────
-- Тело работает с подставленной точкой (_waiter_act_as), обёртка
-- возвращает исходные claims телефона перед выходом. Иначе второй
-- запрос в той же транзакции (GraphQL выполняет несколько полей одной
-- транзакцией) прошёл бы RLS как касса точки. Исключение откатывает
-- транзакцию или подтранзакцию — подстановка откатывается вместе с ней.
CREATE FUNCTION _waiter_restore_claims(p_saved TEXT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT set_config('request.jwt.claims', COALESCE(p_saved, ''), TRUE)
$$;

REVOKE ALL ON FUNCTION _waiter_restore_claims(TEXT) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION waiter_unlock(p_pin TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saved TEXT := current_setting('request.jwt.claims', TRUE);
  v_res   JSON;
BEGIN
  v_res := _waiter_unlock(p_pin);
  PERFORM _waiter_restore_claims(v_saved);
  RETURN v_res;
END $$;

CREATE FUNCTION waiter_hall(p_staff_session UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saved TEXT := current_setting('request.jwt.claims', TRUE);
  v_res   JSON;
BEGIN
  v_res := _waiter_hall(p_staff_session);
  PERFORM _waiter_restore_claims(v_saved);
  RETURN v_res;
END $$;

CREATE FUNCTION waiter_menu(p_staff_session UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saved TEXT := current_setting('request.jwt.claims', TRUE);
  v_res   JSON;
BEGIN
  v_res := _waiter_menu(p_staff_session);
  PERFORM _waiter_restore_claims(v_saved);
  RETURN v_res;
END $$;

CREATE FUNCTION waiter_bill(p_staff_session UUID, p_table_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saved TEXT := current_setting('request.jwt.claims', TRUE);
  v_res   JSON;
BEGIN
  v_res := _waiter_bill(p_staff_session, p_table_id);
  PERFORM _waiter_restore_claims(v_saved);
  RETURN v_res;
END $$;

CREATE FUNCTION waiter_send(
  p_staff_session UUID,
  p_table_id      UUID,
  p_op_uuid       UUID,
  p_items         JSONB
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saved TEXT := current_setting('request.jwt.claims', TRUE);
  v_res   JSON;
BEGIN
  v_res := _waiter_send(p_staff_session, p_table_id, p_op_uuid, p_items);
  PERFORM _waiter_restore_claims(v_saved);
  RETURN v_res;
END $$;

CREATE FUNCTION waiter_fire(
  p_staff_session UUID,
  p_order_id      UUID,
  p_item_ids      UUID[],
  p_op_uuid       UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saved TEXT := current_setting('request.jwt.claims', TRUE);
  v_res   JSON;
BEGIN
  v_res := _waiter_fire(p_staff_session, p_order_id, p_item_ids, p_op_uuid);
  PERFORM _waiter_restore_claims(v_saved);
  RETURN v_res;
END $$;

CREATE FUNCTION waiter_print_status(p_staff_session UUID, p_job_ids UUID[])
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_saved TEXT := current_setting('request.jwt.claims', TRUE);
  v_res   JSON;
BEGIN
  v_res := _waiter_print_status(p_staff_session, p_job_ids);
  PERFORM _waiter_restore_claims(v_saved);
  RETURN v_res;
END $$;

REVOKE ALL ON FUNCTION waiter_unlock(TEXT)                       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION waiter_hall(UUID)                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION waiter_menu(UUID)                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION waiter_bill(UUID, UUID)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION waiter_send(UUID, UUID, UUID, JSONB)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION waiter_fire(UUID, UUID, UUID[], UUID)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION waiter_print_status(UUID, UUID[])         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION waiter_unlock(TEXT)                   TO authenticated;
GRANT EXECUTE ON FUNCTION waiter_hall(UUID)                     TO authenticated;
GRANT EXECUTE ON FUNCTION waiter_menu(UUID)                     TO authenticated;
GRANT EXECUTE ON FUNCTION waiter_bill(UUID, UUID)               TO authenticated;
GRANT EXECUTE ON FUNCTION waiter_send(UUID, UUID, UUID, JSONB)  TO authenticated;
GRANT EXECUTE ON FUNCTION waiter_fire(UUID, UUID, UUID[], UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION waiter_print_status(UUID, UUID[])     TO authenticated;
