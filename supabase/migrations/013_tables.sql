-- ============================================================
-- 013 TABLES — полный режим столов (service_mode = 'tables').
--
-- Модель открытого счёта:
--   * Стол — запись в справочнике зала (tables). Заводится списком
--     (номер + зона), без визуального плана.
--   * Заказ за столом живёт в status='open' сколько нужно: гость
--     сидит, к счёту добавляют позиции (append_to_order), оплата —
--     в конце (существующий pay_order: open → paid).
--   * Готовка идёт СРАЗУ: позиции получают prep_status='pending'
--     при добавлении, бариста видит open-заказы столов в очереди.
--   * На один стол — один активный (open) заказ. Повторный заход
--     за занятый стол = дозаказ в тот же счёт.
--
-- Финансовые инварианты (004/008/011) соблюдены:
--   * Дозаказ = новые order_items + пересчёт снапшот-итогов заказа
--     (не правка старых строк). Аудит цел.
--   * Цены считает сервер из каталога.
-- ============================================================

-- ── Справочник столов ────────────────────────────────────
CREATE TABLE tables (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,               -- «5», «Терраса-2»
  zone         TEXT,                         -- «Зал», «Терраса» (необязательно)
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tables_loc ON tables(location_id) WHERE is_active;

-- Заказ ссылается на стол (в дополнение к текстовому table_label из 012)
ALTER TABLE orders ADD COLUMN table_id UUID REFERENCES tables(id) ON DELETE SET NULL;

-- Один активный (open) заказ на стол: частичный уникальный индекс
CREATE UNIQUE INDEX idx_one_open_order_per_table
  ON orders(table_id) WHERE status = 'open' AND table_id IS NOT NULL;

CREATE INDEX idx_orders_table ON orders(table_id);

-- ── RLS ──────────────────────────────────────────────────
ALTER TABLE tables ENABLE ROW LEVEL SECURITY;

-- Столы читают все; заводит/меняет manager+ — но роль enforced на клиенте
-- (см. модель авторизации), поэтому здесь скоуп только по org.
CREATE POLICY tables_all ON tables FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());

ALTER PUBLICATION supabase_realtime ADD TABLE tables;

-- ============================================================
-- RPC: open_or_get_table_order — вернуть открытый счёт стола либо
-- создать новый пустой заказ за столом (status='open', без позиций).
-- Идемпотентно по столу: повторный вызов вернёт тот же open-заказ.
-- ============================================================
CREATE OR REPLACE FUNCTION open_or_get_table_order(p_table_id UUID, p_staff_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_loc      UUID := auth_location_id();
  v_shift    UUID;
  v_vat_rate NUMERIC(5,2);
  v_number   INTEGER;
  v_order    orders%ROWTYPE;
  v_label    TEXT;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  -- Стол существует и наш
  SELECT label INTO v_label FROM tables
  WHERE id = p_table_id AND org_id = v_org AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table not found';
  END IF;

  -- Уже есть открытый счёт → вернуть его
  SELECT * INTO v_order FROM orders
  WHERE table_id = p_table_id AND status = 'open';
  IF FOUND THEN
    RETURN json_build_object('order_id', v_order.id, 'daily_number', v_order.daily_number,
                             'total', v_order.total, 'existing', TRUE);
  END IF;

  -- Продажа только при открытой смене
  SELECT id INTO v_shift FROM shifts WHERE location_id = v_loc AND status = 'open';
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  SELECT vat_rate INTO v_vat_rate FROM locations WHERE id = v_loc;

  INSERT INTO order_counters (location_id, day, counter)
  VALUES (v_loc, (NOW() AT TIME ZONE (SELECT timezone FROM locations WHERE id = v_loc))::date, 1)
  ON CONFLICT (location_id, day)
  DO UPDATE SET counter = order_counters.counter + 1
  RETURNING counter INTO v_number;

  INSERT INTO orders (org_id, location_id, staff_id, client_uuid, daily_number,
                      order_type, status, vat_rate, shift_id, table_id, table_label)
  VALUES (v_org, v_loc, p_staff_id, gen_random_uuid(), v_number,
          'here', 'open', v_vat_rate, v_shift, p_table_id, v_label)
  RETURNING * INTO v_order;

  RETURN json_build_object('order_id', v_order.id, 'daily_number', v_order.daily_number,
                           'total', 0, 'existing', FALSE);
END $$;

-- ============================================================
-- RPC: append_to_order — дозаказ в существующий open-заказ.
-- Добавляет позиции (цены из каталога), пересчитывает снапшот-итоги
-- всего заказа. Формат p_items — как в place_order.
-- ============================================================
CREATE OR REPLACE FUNCTION append_to_order(
  p_order_id UUID,
  p_staff_id UUID,
  p_items    JSONB
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_order     orders%ROWTYPE;
  v_item      JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_variant   item_variants%ROWTYPE;
  v_mod       modifiers%ROWTYPE;
  v_mod_id    UUID;
  v_unit      INTEGER;
  v_override  INTEGER;
  v_is_custom BOOLEAN;
  v_name      TEXT;
  v_qty       INTEGER;
  v_line      INTEGER;
  v_oi_id     UUID;
  v_subtotal  INTEGER;
  v_disc_amount INTEGER;
  v_total     INTEGER;
  v_vat       INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order has no items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';  -- оплаченный/отменённый счёт не дозаказать
  END IF;

  -- Позиции (та же логика, что place_order)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;

    v_override := NULLIF(v_item ->> 'unit_price_override', '')::INTEGER;
    v_is_custom := (v_item ->> 'menu_item_id') IS NULL;

    IF v_is_custom THEN
      IF v_override IS NULL OR v_override < 0 THEN
        RAISE EXCEPTION 'custom item requires unit_price_override';
      END IF;
      v_name := NULLIF(TRIM(v_item ->> 'custom_name'), '');
      IF v_name IS NULL THEN
        RAISE EXCEPTION 'custom item requires name';
      END IF;
      v_unit := v_override;
      v_line := v_unit * v_qty;

      INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                               name, variant_name, unit_price, qty, line_total, notes,
                               is_price_overridden)
      VALUES (v_org, p_order_id, NULL, NULL, NULL,
              v_name, NULL, v_unit, v_qty, v_line,
              NULLIF(TRIM(v_item ->> 'notes'), ''), TRUE);
      CONTINUE;
    END IF;

    SELECT * INTO v_menu_item FROM menu_items
      WHERE id = (v_item ->> 'menu_item_id')::UUID AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'menu item not found';
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

    IF v_item ? 'modifier_ids' THEN
      FOR v_mod_id IN SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID LOOP
        SELECT * INTO v_mod FROM modifiers WHERE id = v_mod_id AND org_id = v_org;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'modifier not found';
        END IF;
        v_unit := v_unit + v_mod.price_delta;
      END LOOP;
    END IF;

    IF v_override IS NOT NULL THEN
      IF v_override < 0 THEN
        RAISE EXCEPTION 'invalid price override';
      END IF;
      v_unit := v_override;
    END IF;

    v_line := v_unit * v_qty;

    INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                             name, variant_name, unit_price, qty, line_total, notes,
                             is_price_overridden)
    VALUES (v_org, p_order_id, v_menu_item.id, v_variant.id, v_menu_item.station_id,
            v_menu_item.name, v_variant.name, v_unit, v_qty, v_line,
            NULLIF(TRIM(v_item ->> 'notes'), ''), v_override IS NOT NULL)
    RETURNING id INTO v_oi_id;

    IF v_item ? 'modifier_ids' THEN
      INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta)
      SELECT v_org, v_oi_id, m.id, m.name, m.price_delta
      FROM modifiers m
      WHERE m.id IN (SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID);
    END IF;
  END LOOP;

  -- Пересчёт снапшот-итогов ВСЕГО заказа из его позиций
  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = p_order_id;

  -- Скидка на заказ пересчитывается от нового подытога (тип/значение сохранены)
  v_disc_amount := 0;
  IF v_order.discount_type = 'percent' THEN
    v_disc_amount := ROUND(v_subtotal * v_order.discount_value / 100.0);
  ELSIF v_order.discount_type = 'fixed' THEN
    v_disc_amount := v_order.discount_value;
  END IF;
  IF v_disc_amount > v_subtotal THEN
    v_disc_amount := v_subtotal;
  END IF;

  v_total := v_subtotal - v_disc_amount;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, discount_amount = v_disc_amount,
      total = v_total, vat_amount = v_vat
  WHERE id = p_order_id;

  RETURN json_build_object('order_id', p_order_id, 'total', v_total, 'subtotal', v_subtotal);
END $$;

-- ============================================================
-- RPC: void_table_order — отменить открытый счёт стола (ушёл гость,
-- ничего не заказал/ошибка). Void, не delete — аудит цел.
-- ============================================================
CREATE OR REPLACE FUNCTION void_table_order(p_order_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  UPDATE orders
  SET status = 'voided', voided_at = NOW(), void_reason = NULLIF(TRIM(p_reason), '')
  WHERE id = p_order_id AND org_id = v_org AND status = 'open';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found or not open';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION open_or_get_table_order, append_to_order, void_table_order FROM anon, public;
