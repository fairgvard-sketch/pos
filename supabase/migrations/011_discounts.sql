-- ============================================================
-- 011 DISCOUNTS — скидка на заказ + ручная цена позиции.
--
-- Принципы (те же финансовые инварианты, что и в 004/009):
--   * Скидка снапшотится в заказ: тип/значение/сумма/причина.
--     Клиент присылает НАМЕРЕНИЕ (тип+значение), сумму считает
--     СЕРВЕР — как и цены (клиент не источник денег).
--   * НДС в Израиле включён в цену: скидка снижает total, значит
--     снижает и НДС-компонент. vat = total * rate / (100 + rate),
--     где total = subtotal - discount_amount.
--   * Ручная цена позиции (unit_price_override) — для свободных
--     позиций (menu_item_id = null) и ручных коррекций. Помечается
--     флагом is_price_overridden, чтобы в чеке/отчёте была видна
--     ручная правка.
--   * Никаких UPDATE/DELETE задним числом: всё это снапшот на
--     момент продажи. Аудит-трейл цел.
-- ============================================================

-- ── Скидка на заказ ──────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN discount_type   TEXT
    CHECK (discount_type IN ('percent', 'fixed')),
  ADD COLUMN discount_value  INTEGER,     -- % (целые) или агороты, смысл зависит от type
  ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0,  -- фактически вычтено, агороты
  ADD COLUMN discount_reason TEXT;

-- ── Ручная цена позиции ──────────────────────────────────
ALTER TABLE order_items
  ADD COLUMN is_price_overridden BOOLEAN NOT NULL DEFAULT FALSE;

-- Свободная позиция: menu_item_id уже nullable (004), делаем nullable name-ссылку?
-- name остаётся NOT NULL — у свободной позиции просто приходит своё имя.

-- ============================================================
-- RPC: place_order — пересоздаём целиком (добавили скидку и override).
--
-- Формат p_items (новое поле unit_price_override — опционально):
-- [{ "menu_item_id": "..."|null, "variant_id": "..."|null,
--    "modifier_ids": ["..."], "qty": 2, "notes": "...",
--    "custom_name": "..."|null,          -- для свободной позиции
--    "unit_price_override": 1500|null }] -- ручная цена, агороты
--
-- Скидка: p_discount = { "type": "percent"|"fixed",
--                        "value": 10|1500, "reason": "..."|null } | null
--
-- Добавляем аргумент p_discount → это НОВАЯ сигнатура. Postgres
-- перегружает функции по сигнатуре, поэтому старую 5-аргументную
-- версию сначала явно удаляем (иначе останутся обе и вызовы/REVOKE
-- станут неоднозначными).
-- ============================================================
DROP FUNCTION IF EXISTS place_order(UUID, UUID, TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION place_order(
  p_client_uuid   UUID,
  p_staff_id      UUID,
  p_order_type    TEXT,
  p_customer_name TEXT,
  p_items         JSONB,
  p_discount      JSONB DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_loc       UUID := auth_location_id();
  v_existing  orders%ROWTYPE;
  v_shift     UUID;
  v_vat_rate  NUMERIC(5,2);
  v_number    INTEGER;
  v_order_id  UUID;
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
  v_subtotal  INTEGER := 0;
  v_oi_id     UUID;
  -- скидка
  v_disc_type   TEXT := NULL;
  v_disc_value  INTEGER := NULL;
  v_disc_reason TEXT := NULL;
  v_disc_amount INTEGER := 0;
  v_total     INTEGER;
  v_vat       INTEGER;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

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
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

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
                      order_type, customer_name, status, vat_rate, shift_id)
  VALUES (v_org, v_loc, p_staff_id, p_client_uuid, v_number,
          p_order_type, NULLIF(TRIM(p_customer_name), ''), 'open', v_vat_rate, v_shift)
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;

    v_override := NULLIF(v_item ->> 'unit_price_override', '')::INTEGER;
    v_is_custom := (v_item ->> 'menu_item_id') IS NULL;

    IF v_is_custom THEN
      -- Свободная позиция: нет каталога, цена ОБЯЗАНА прийти от кассы
      IF v_override IS NULL OR v_override < 0 THEN
        RAISE EXCEPTION 'custom item requires unit_price_override';
      END IF;
      v_name := NULLIF(TRIM(v_item ->> 'custom_name'), '');
      IF v_name IS NULL THEN
        RAISE EXCEPTION 'custom item requires name';
      END IF;

      v_unit := v_override;
      v_line := v_unit * v_qty;
      v_subtotal := v_subtotal + v_line;

      INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                               name, variant_name, unit_price, qty, line_total, notes,
                               is_price_overridden)
      VALUES (v_org, v_order_id, NULL, NULL, NULL,
              v_name, NULL, v_unit, v_qty, v_line,
              NULLIF(TRIM(v_item ->> 'notes'), ''), TRUE);
      CONTINUE;
    END IF;

    -- Каталожная позиция
    SELECT * INTO v_menu_item FROM menu_items
      WHERE id = (v_item ->> 'menu_item_id')::UUID AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'menu item not found: %', v_item ->> 'menu_item_id';
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

    -- Ручная цена перебивает каталожную (модификаторы уже не прибавляем)
    IF v_override IS NOT NULL THEN
      IF v_override < 0 THEN
        RAISE EXCEPTION 'invalid price override';
      END IF;
      v_unit := v_override;
    END IF;

    v_line := v_unit * v_qty;
    v_subtotal := v_subtotal + v_line;

    INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                             name, variant_name, unit_price, qty, line_total, notes,
                             is_price_overridden)
    VALUES (v_org, v_order_id, v_menu_item.id, v_variant.id, v_menu_item.station_id,
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

  -- ── Скидка на заказ ──────────────────────────────────
  IF p_discount IS NOT NULL AND (p_discount ->> 'type') IS NOT NULL THEN
    v_disc_type   := p_discount ->> 'type';
    v_disc_value  := NULLIF(p_discount ->> 'value', '')::INTEGER;
    v_disc_reason := NULLIF(TRIM(p_discount ->> 'reason'), '');

    IF v_disc_type NOT IN ('percent', 'fixed') THEN
      RAISE EXCEPTION 'invalid discount type';
    END IF;
    IF v_disc_value IS NULL OR v_disc_value < 0 THEN
      RAISE EXCEPTION 'invalid discount value';
    END IF;

    IF v_disc_type = 'percent' THEN
      IF v_disc_value > 100 THEN
        RAISE EXCEPTION 'discount percent out of range';
      END IF;
      v_disc_amount := ROUND(v_subtotal * v_disc_value / 100.0);
    ELSE
      v_disc_amount := v_disc_value;
    END IF;

    -- Скидка не может увести итог в минус
    IF v_disc_amount > v_subtotal THEN
      v_disc_amount := v_subtotal;
    END IF;
  END IF;

  v_total := v_subtotal - v_disc_amount;
  v_vat := ROUND(v_total * v_vat_rate / (100 + v_vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal,
      discount_type = v_disc_type,
      discount_value = v_disc_value,
      discount_amount = v_disc_amount,
      discount_reason = v_disc_reason,
      total = v_total,
      vat_amount = v_vat
  WHERE id = v_order_id;

  RETURN json_build_object('order_id', v_order_id, 'daily_number', v_number, 'total', v_total, 'duplicate', FALSE);
END $$;

REVOKE EXECUTE ON FUNCTION place_order(UUID, UUID, TEXT, TEXT, JSONB, JSONB) FROM anon, public;
