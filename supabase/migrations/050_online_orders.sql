-- ============================================================
-- 050 ONLINE ORDERS — «закажи и забери» с сайта (фаза 1 MVP).
--
-- Модель:
--   * Анонимный гость сайта НЕ трогает orders напрямую. Его заказ —
--     заявка в стейджинг-таблице online_orders (снапшот позиций и цен
--     для показа кассиру). Пишет туда только Edge Function через
--     service_role → submit_online_order.
--   * Кассир видит заявку (realtime) и решает: принять/отклонить.
--     Принятие = accept_online_order → обычный place_order
--     (type=takeaway, source='site'): цены пересчитываются из
--     каталога, остатки списываются триггерами 047, заказ попадает
--     в очередь бариста. Фискальный контур не тронут: оплата — на
--     кассе при получении обычным pay_order.
--   * «Часы приёма» без настроек: заявка принимается только при
--     ОТКРЫТОЙ смене на точке (смена закрыта = кофейня закрыта).
--   * Незабранный принятый заказ (open, без стола) закрытие смены
--     аннулирует как брошенный (035) — остаток вернёт триггер 047.
--   * Идемпотентность: client_uuid генерирует страница гостя;
--     повторный POST после сбоя сети не создаст дубликат. Тот же
--     client_uuid становится client_uuid настоящего заказа при
--     принятии (double-tap «Принять» тоже безопасен: row lock +
--     проверка статуса).
--   * Анти-спам в БД: лимит заявок с одного телефона + лимит
--     необработанных заявок на точку.
-- ============================================================

-- ── orders: происхождение и контакты клиента ─────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'pos'
  CHECK (source IN ('pos', 'site'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_at TIMESTAMPTZ;

-- ── Стейджинг заявок с сайта ─────────────────────────────────
CREATE TABLE online_orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id),
  client_uuid    UUID NOT NULL UNIQUE,            -- идемпотентность POST
  customer_name  TEXT NOT NULL,
  customer_phone TEXT NOT NULL,                   -- только цифры
  pickup_at      TIMESTAMPTZ,                     -- NULL = как можно скорее
  note           TEXT,
  -- Снапшот позиций с ценами НА МОМЕНТ ЗАЯВКИ (для показа кассиру):
  -- [{menu_item_id, variant_id, modifier_ids, qty, notes,
  --   name, variant_name, unit_price, line_total, mods:[{id,name,price_delta}]}]
  items          JSONB NOT NULL,
  subtotal       INTEGER NOT NULL,                -- агороты, оценка
  total          INTEGER NOT NULL,                -- = subtotal (скидок онлайн нет)
  status         TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'accepted', 'rejected')),
  reject_reason  TEXT,
  order_id       UUID REFERENCES orders(id),      -- настоящий заказ после принятия
  decided_by     UUID REFERENCES staff(id),
  decided_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_online_orders_loc_status ON online_orders(location_id, status);
CREATE INDEX idx_online_orders_created    ON online_orders(location_id, created_at);
CREATE INDEX idx_online_orders_phone      ON online_orders(customer_phone, created_at);

-- Realtime: касса подписана на заявки (уведомление «новый онлайн-заказ»)
ALTER PUBLICATION supabase_realtime ADD TABLE online_orders;

ALTER TABLE online_orders ENABLE ROW LEVEL SECURITY;

-- Чтение — устройства своей организации; запись — только через RPC
CREATE POLICY online_orders_select ON online_orders FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

REVOKE INSERT, UPDATE, DELETE ON online_orders FROM authenticated;
REVOKE ALL ON online_orders FROM anon;

-- ============================================================
-- RPC: submit_online_order — приём заявки с сайта.
-- Вызывает ТОЛЬКО Edge Function под service_role (у анона и
-- устройств кассы EXECUTE отозван). Цены считает сервер из
-- каталога; недоступные позиции (стоп-лист 047) отклоняются.
-- p_items: [{menu_item_id, variant_id|null, modifier_ids:[], qty, notes}]
-- ============================================================
CREATE OR REPLACE FUNCTION submit_online_order(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_items       JSONB,
  p_pickup_at   TIMESTAMPTZ DEFAULT NULL,
  p_note        TEXT        DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc       locations%ROWTYPE;
  v_existing  online_orders%ROWTYPE;
  v_name      TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone     TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note      TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_pickup    TIMESTAMPTZ := p_pickup_at;
  v_item      JSONB;
  v_mods      JSONB;
  v_mod_ids   UUID[];
  v_mod_id    UUID;
  v_mi        menu_items%ROWTYPE;
  v_cat_ok    BOOLEAN;
  v_variant   item_variants%ROWTYPE;
  v_mod       modifiers%ROWTYPE;
  v_qty       INTEGER;
  v_unit      INTEGER;
  v_line      INTEGER;
  v_subtotal  INTEGER := 0;
  v_out_items JSONB := '[]'::jsonb;
  v_id        UUID;
BEGIN
  -- Идемпотентность: повтор POST с тем же client_uuid → та же заявка
  SELECT * INTO v_existing FROM online_orders WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('online_id', v_existing.id, 'total', v_existing.total, 'duplicate', TRUE);
  END IF;
  -- client_uuid не должен совпасть с client_uuid существующего ЗАКАЗА:
  -- иначе принятие связало бы заявку с чужим заказом (идемпотентность place_order)
  IF EXISTS (SELECT 1 FROM orders WHERE client_uuid = p_client_uuid) THEN
    RAISE EXCEPTION 'invalid_client_uuid';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  -- Кофейня «открыта» = на точке открыта смена
  IF NOT EXISTS (SELECT 1 FROM shifts WHERE location_id = p_location_id AND status = 'open') THEN
    RAISE EXCEPTION 'closed';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;

  -- Время получения: прошедшее = «как можно скорее»; дальше суток — ошибка
  IF v_pickup IS NOT NULL AND v_pickup <= NOW() THEN
    v_pickup := NULL;
  END IF;
  IF v_pickup IS NOT NULL AND v_pickup > NOW() + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'invalid_pickup';
  END IF;

  -- Анти-спам: ≤3 заявок с телефона за 15 минут; ≤30 необработанных на точку
  IF (SELECT COUNT(*) FROM online_orders
      WHERE customer_phone = v_phone AND created_at > NOW() - INTERVAL '15 minutes') >= 3 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT COUNT(*) FROM online_orders
      WHERE location_id = p_location_id AND status = 'new') >= 30 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 30 THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  -- Позиции: цены из каталога, только активные категории и доступные товары
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 99 THEN
      RAISE EXCEPTION 'invalid_items';
    END IF;

    SELECT mi.* INTO v_mi FROM menu_items mi
      WHERE mi.id = (v_item ->> 'menu_item_id')::UUID AND mi.org_id = v_loc.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_items';
    END IF;
    SELECT (mc.is_active AND mc.location_id = p_location_id) INTO v_cat_ok
      FROM menu_categories mc WHERE mc.id = v_mi.category_id;
    IF NOT v_mi.is_available OR NOT COALESCE(v_cat_ok, FALSE) THEN
      RAISE EXCEPTION 'item_unavailable: %', v_mi.name;
    END IF;

    v_variant := NULL;
    IF v_item ->> 'variant_id' IS NOT NULL THEN
      SELECT * INTO v_variant FROM item_variants
        WHERE id = (v_item ->> 'variant_id')::UUID AND item_id = v_mi.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid_items';
      END IF;
      v_unit := v_variant.price;
    ELSE
      v_unit := v_mi.price;
    END IF;

    -- Модификаторы: дедуп, ≤10 на позицию, группа привязана к товару,
    -- модификатор доступен. Снапшот имён/дельт — для карточки кассира.
    v_mods := '[]'::jsonb;
    v_mod_ids := '{}';
    IF v_item ? 'modifier_ids' THEN
      SELECT COALESCE(array_agg(DISTINCT x::UUID), '{}')
        INTO v_mod_ids
        FROM jsonb_array_elements_text(v_item -> 'modifier_ids') x;
      IF array_length(v_mod_ids, 1) > 10 THEN
        RAISE EXCEPTION 'invalid_items';
      END IF;
      FOREACH v_mod_id IN ARRAY v_mod_ids LOOP
        SELECT m.* INTO v_mod FROM modifiers m
          JOIN menu_item_modifier_groups mimg
            ON mimg.group_id = m.group_id AND mimg.item_id = v_mi.id
          WHERE m.id = v_mod_id AND m.org_id = v_loc.org_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'invalid_items';
        END IF;
        IF NOT v_mod.is_available THEN
          RAISE EXCEPTION 'item_unavailable: %', v_mod.name;
        END IF;
        v_unit := v_unit + v_mod.price_delta;
        v_mods := v_mods || jsonb_build_object('id', v_mod.id, 'name', v_mod.name, 'price_delta', v_mod.price_delta);
      END LOOP;
    END IF;

    v_line := v_unit * v_qty;
    v_subtotal := v_subtotal + v_line;

    v_out_items := v_out_items || jsonb_build_object(
      'menu_item_id', v_mi.id,
      'variant_id',   v_variant.id,
      'modifier_ids', to_jsonb(v_mod_ids),
      'qty',          v_qty,
      'notes',        NULLIF(LEFT(TRIM(COALESCE(v_item ->> 'notes', '')), 120), ''),
      'name',         v_mi.name,
      'variant_name', v_variant.name,
      'unit_price',   v_unit,
      'line_total',   v_line,
      'mods',         v_mods
    );
  END LOOP;

  INSERT INTO online_orders (org_id, location_id, client_uuid, customer_name, customer_phone,
                             pickup_at, note, items, subtotal, total)
  VALUES (v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
          v_pickup, v_note, v_out_items, v_subtotal, v_subtotal)
  RETURNING id INTO v_id;

  RETURN json_build_object('online_id', v_id, 'total', v_subtotal, 'duplicate', FALSE);
END $$;

REVOKE ALL ON FUNCTION submit_online_order FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_online_order TO service_role;

-- ============================================================
-- RPC: get_online_order_status — поллинг статуса гостем.
-- client_uuid знает только гость (его секрет). Тоже только
-- через Edge Function (service_role).
-- ============================================================
CREATE OR REPLACE FUNCTION get_online_order_status(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_oo online_orders%ROWTYPE;
  v_o  orders%ROWTYPE;
BEGIN
  SELECT * INTO v_oo FROM online_orders WHERE client_uuid = p_client_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_oo.order_id IS NOT NULL THEN
    SELECT * INTO v_o FROM orders WHERE id = v_oo.order_id;
  END IF;
  RETURN json_build_object(
    'status',        v_oo.status,           -- new | accepted | rejected
    'reject_reason', v_oo.reject_reason,
    'total',         COALESCE(v_o.total, v_oo.total),
    'daily_number',  v_o.daily_number,
    -- open = готовится/ждёт получения; paid/fulfilled = выдан; voided = отменён
    'order_status',  v_o.status,
    'created_at',    v_oo.created_at
  );
END $$;

REVOKE ALL ON FUNCTION get_online_order_status FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_online_order_status TO service_role;

-- ============================================================
-- RPC: accept_online_order — кассир принимает заявку.
-- Создаёт НАСТОЯЩИЙ заказ через place_order (цены пересчитываются
-- из каталога заново, остатки списываются триггерами 047, нужна
-- открытая смена). Идемпотентен: повторный вызов по принятой
-- заявке возвращает существующий заказ.
-- ============================================================
CREATE OR REPLACE FUNCTION accept_online_order(
  p_online_id UUID,
  p_staff_id  UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_oo       online_orders%ROWTYPE;
  v_items    JSONB;
  v_res      JSON;
  v_order_id UUID;
  v_o        orders%ROWTYPE;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Row lock: два кассира (или double-tap) не примут заявку дважды
  SELECT * INTO v_oo FROM online_orders
    WHERE id = p_online_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'online order not found';
  END IF;
  IF v_oo.status = 'accepted' THEN
    SELECT * INTO v_o FROM orders WHERE id = v_oo.order_id;
    RETURN json_build_object('order_id', v_o.id, 'daily_number', v_o.daily_number, 'total', v_o.total, 'duplicate', TRUE);
  END IF;
  IF v_oo.status <> 'new' THEN
    RAISE EXCEPTION 'already decided';
  END IF;

  -- Снапшот → формат place_order (цены он возьмёт из каталога сам)
  SELECT jsonb_agg(jsonb_build_object(
    'menu_item_id', e -> 'menu_item_id',
    'variant_id',   e -> 'variant_id',
    'modifier_ids', COALESCE(e -> 'modifier_ids', '[]'::jsonb),
    'qty',          e -> 'qty',
    'notes',        e -> 'notes'
  )) INTO v_items
  FROM jsonb_array_elements(v_oo.items) e;

  v_res := place_order(
    p_client_uuid   := v_oo.client_uuid,
    p_staff_id      := p_staff_id,
    p_order_type    := 'takeaway',
    p_customer_name := v_oo.customer_name,
    p_items         := v_items
  );
  -- Заявка гарантировала уникальность client_uuid (submit), duplicate
  -- здесь означал бы связывание с чужим заказом — не допускаем
  IF (v_res ->> 'duplicate')::BOOLEAN THEN
    RAISE EXCEPTION 'client uuid conflict';
  END IF;
  v_order_id := (v_res ->> 'order_id')::UUID;

  UPDATE orders
  SET source = 'site', customer_phone = v_oo.customer_phone, pickup_at = v_oo.pickup_at
  WHERE id = v_order_id;

  UPDATE online_orders
  SET status = 'accepted', order_id = v_order_id, decided_by = p_staff_id, decided_at = NOW()
  WHERE id = p_online_id;

  RETURN json_build_object(
    'order_id', v_order_id,
    'daily_number', (v_res ->> 'daily_number')::INTEGER,
    'total', (v_res ->> 'total')::INTEGER,
    'duplicate', FALSE
  );
END $$;

REVOKE EXECUTE ON FUNCTION accept_online_order FROM anon, public;

-- ============================================================
-- RPC: reject_online_order — кассир отклоняет заявку.
-- Настоящий заказ не создавался, остатки не тронуты. Гость
-- увидит статус rejected (+ причину) при поллинге.
-- ============================================================
CREATE OR REPLACE FUNCTION reject_online_order(
  p_online_id UUID,
  p_staff_id  UUID,
  p_reason    TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  UPDATE online_orders
  SET status = 'rejected',
      reject_reason = NULLIF(TRIM(COALESCE(p_reason, '')), ''),
      decided_by = p_staff_id,
      decided_at = NOW()
  WHERE id = p_online_id AND org_id = v_org AND status = 'new';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'online order not found or already decided';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION reject_online_order FROM anon, public;
