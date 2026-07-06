-- ============================================================
-- 004 ORDERS — заказы как очередь у стойки.
--
-- Принципы:
--   * Цены СНАПШОТЯТСЯ в заказ в момент продажи и считаются
--     СЕРВЕРОМ из каталога (клиент не может прислать свою цену).
--   * daily_number — короткий номер для гостя (#42), сбрасывается
--     каждый день на точке. Хранится в order_counters.
--   * Идемпотентность: client_uuid генерирует касса; повторный
--     вызов place_order с тем же uuid вернёт существующий заказ
--     (фундамент offline-очереди).
--   * Финансовые записи не удаляются: отмена = status 'voided'.
--   * НДС в Израиле включён в цену: vat_amount = total*rate/(100+rate).
-- ============================================================

CREATE TABLE orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id   UUID NOT NULL REFERENCES locations(id),
  staff_id      UUID NOT NULL REFERENCES staff(id),
  client_uuid   UUID NOT NULL UNIQUE,          -- идемпотентность
  daily_number  INTEGER NOT NULL,               -- #42 на сегодня
  order_type    TEXT NOT NULL DEFAULT 'here' CHECK (order_type IN ('here', 'takeaway')),
  customer_name TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'paid', 'fulfilled', 'voided')),
  -- Деньги: агороты, снапшот на момент продажи
  subtotal      INTEGER NOT NULL DEFAULT 0,     -- сумма позиций
  vat_rate      NUMERIC(5,2) NOT NULL,          -- ставка на момент продажи
  vat_amount    INTEGER NOT NULL DEFAULT 0,     -- НДС внутри total
  total         INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at       TIMESTAMPTZ,
  fulfilled_at  TIMESTAMPTZ,
  voided_at     TIMESTAMPTZ,
  void_reason   TEXT
);

CREATE TABLE order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id  UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  variant_id    UUID REFERENCES item_variants(id) ON DELETE SET NULL,
  station_id    UUID REFERENCES stations(id) ON DELETE SET NULL,
  -- Снапшоты: чек должен читаться даже если товар переименовали/удалили
  name          TEXT NOT NULL,
  variant_name  TEXT,
  unit_price    INTEGER NOT NULL,               -- цена 1 шт с модификаторами
  qty           INTEGER NOT NULL CHECK (qty > 0),
  line_total    INTEGER NOT NULL,               -- unit_price * qty
  notes         TEXT
);

CREATE TABLE order_item_modifiers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  order_item_id  UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id    UUID REFERENCES modifiers(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,                 -- снапшот
  price_delta    INTEGER NOT NULL               -- снапшот
);

-- Дневные счётчики номеров заказов
CREATE TABLE order_counters (
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  counter     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, day)
);

CREATE INDEX idx_orders_org         ON orders(org_id);
CREATE INDEX idx_orders_loc_status  ON orders(location_id, status);
CREATE INDEX idx_orders_created     ON orders(created_at);
CREATE INDEX idx_order_items_order  ON order_items(order_id);
CREATE INDEX idx_oim_item           ON order_item_modifiers(order_item_id);

-- Realtime для очереди бариста
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE order_items;

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_counters       ENABLE ROW LEVEL SECURITY;

-- Чтение — всё своё; запись заказов ТОЛЬКО через RPC (см. ниже),
-- прямых INSERT/UPDATE у клиента нет.
CREATE POLICY orders_select ON orders FOR SELECT TO authenticated
  USING (org_id = auth_org_id());
CREATE POLICY order_items_select ON order_items FOR SELECT TO authenticated
  USING (org_id = auth_org_id());
CREATE POLICY oim_select ON order_item_modifiers FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

REVOKE INSERT, UPDATE, DELETE ON orders               FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON order_items          FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON order_item_modifiers FROM authenticated;
REVOKE ALL ON order_counters FROM authenticated;

-- ============================================================
-- RPC: place_order — атомарное создание заказа.
-- Цены считает сервер из каталога. Формат items:
-- [{ "menu_item_id": "...", "variant_id": "..."|null,
--    "modifier_ids": ["..."], "qty": 2, "notes": "..." }]
-- ============================================================
CREATE OR REPLACE FUNCTION place_order(
  p_client_uuid   UUID,
  p_staff_id      UUID,
  p_order_type    TEXT,
  p_customer_name TEXT,
  p_items         JSONB
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_loc       UUID := auth_location_id();
  v_existing  orders%ROWTYPE;
  v_vat_rate  NUMERIC(5,2);
  v_number    INTEGER;
  v_order_id  UUID;
  v_item      JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_variant   item_variants%ROWTYPE;
  v_mod       modifiers%ROWTYPE;
  v_mod_id    UUID;
  v_unit      INTEGER;
  v_qty       INTEGER;
  v_line      INTEGER;
  v_subtotal  INTEGER := 0;
  v_total     INTEGER;
  v_vat       INTEGER;
  v_oi_id     UUID;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Идемпотентность: заказ с таким client_uuid уже есть → вернуть его
  SELECT * INTO v_existing FROM orders WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('order_id', v_existing.id, 'daily_number', v_existing.daily_number, 'total', v_existing.total, 'duplicate', TRUE);
  END IF;

  IF p_order_type NOT IN ('here', 'takeaway') THEN
    RAISE EXCEPTION 'invalid order type';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order has no items';
  END IF;
  -- Сотрудник должен принадлежать организации
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT vat_rate INTO v_vat_rate FROM locations WHERE id = v_loc;

  -- Дневной номер: атомарный инкремент счётчика точки
  INSERT INTO order_counters (location_id, day, counter)
  VALUES (v_loc, (NOW() AT TIME ZONE (SELECT timezone FROM locations WHERE id = v_loc))::date, 1)
  ON CONFLICT (location_id, day)
  DO UPDATE SET counter = order_counters.counter + 1
  RETURNING counter INTO v_number;

  INSERT INTO orders (org_id, location_id, staff_id, client_uuid, daily_number,
                      order_type, customer_name, status, vat_rate)
  VALUES (v_org, v_loc, p_staff_id, p_client_uuid, v_number,
          p_order_type, NULLIF(TRIM(p_customer_name), ''), 'open', v_vat_rate)
  RETURNING id INTO v_order_id;

  -- Позиции: цены берём ИЗ КАТАЛОГА
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_menu_item FROM menu_items
      WHERE id = (v_item ->> 'menu_item_id')::UUID AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'menu item not found: %', v_item ->> 'menu_item_id';
    END IF;

    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;

    v_variant := NULL;
    IF v_item ->> 'variant_id' IS NOT NULL THEN
      SELECT * INTO v_variant FROM item_variants
        WHERE id = (v_item ->> 'variant_id')::UUID AND item_id = v_menu_item.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'variant not found';
      END IF;
      v_unit := v_variant.price;
    ELSE
      v_unit := v_menu_item.price;
    END IF;

    -- Модификаторы: суммируем дельты
    IF v_item ? 'modifier_ids' THEN
      FOR v_mod_id IN SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID LOOP
        SELECT * INTO v_mod FROM modifiers WHERE id = v_mod_id AND org_id = v_org;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'modifier not found';
        END IF;
        v_unit := v_unit + v_mod.price_delta;
      END LOOP;
    END IF;

    v_line := v_unit * v_qty;
    v_subtotal := v_subtotal + v_line;

    INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                             name, variant_name, unit_price, qty, line_total, notes)
    VALUES (v_org, v_order_id, v_menu_item.id, v_variant.id, v_menu_item.station_id,
            v_menu_item.name, v_variant.name, v_unit, v_qty, v_line,
            NULLIF(TRIM(v_item ->> 'notes'), ''))
    RETURNING id INTO v_oi_id;

    -- Снапшоты модификаторов
    IF v_item ? 'modifier_ids' THEN
      INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta)
      SELECT v_org, v_oi_id, m.id, m.name, m.price_delta
      FROM modifiers m
      WHERE m.id IN (SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID);
    END IF;
  END LOOP;

  -- Итоги: НДС включён в цены (израильская модель)
  v_total := v_subtotal;
  v_vat := ROUND(v_total * v_vat_rate / (100 + v_vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, total = v_total, vat_amount = v_vat
  WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'daily_number', v_number, 'total', v_total, 'duplicate', FALSE);
END $$;

REVOKE EXECUTE ON FUNCTION place_order FROM anon, public;

-- ============================================================
-- RPC: смена статуса (оплата придёт в 005, пока paid одним шагом)
-- ============================================================
CREATE OR REPLACE FUNCTION set_order_status(p_order_id UUID, p_status TEXT, p_reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('paid', 'fulfilled', 'voided') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;

  UPDATE orders
  SET status = p_status,
      paid_at      = CASE WHEN p_status = 'paid'      THEN NOW() ELSE paid_at END,
      fulfilled_at = CASE WHEN p_status = 'fulfilled' THEN NOW() ELSE fulfilled_at END,
      voided_at    = CASE WHEN p_status = 'voided'    THEN NOW() ELSE voided_at END,
      void_reason  = CASE WHEN p_status = 'voided'    THEN p_reason ELSE void_reason END
  WHERE id = p_order_id AND org_id = auth_org_id()
    AND status NOT IN ('voided');  -- отменённый заказ не оживает

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found or voided';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION set_order_status FROM anon, public;
