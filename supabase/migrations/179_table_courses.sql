-- ============================================================
-- 179 КУРСЫ ПОДАЧИ И FIRE ДЛЯ СЧЁТА СТОЛА
--
-- Ресторан пробивает стол сразу целиком: закуска (курс 1), горячее
-- (курс 2), десерт (курс 3). Кухня должна получить только то, что
-- готовить сейчас; следующий курс официант отправляет кнопкой Fire,
-- когда гость готов. Кухня придержанное НЕ видит вовсе.
--
-- МОДЕЛЬ.
--   menu_items.course   — курс по умолчанию (NULL = без курса: уходит
--                         сразу; так у всех существующих позиций, поэтому
--                         кофейни ничего не замечают).
--   order_items.course  — снимок курса строки на момент заказа. Официант
--                         может сменить его на кассе (ключ course в p_items).
--   order_items.held    — строка придержана и не видна кухне до Fire.
--   fired_at/fired_by   — кто и когда отправил придержанное.
--
-- ПРАВИЛО УДЕРЖАНИЯ (только счёт стола, append_to_order): строка курса
-- c >= 2 придерживается, если в счёте есть активная строка более раннего
-- курса — уже поданная или пришедшая этим же дозаказом. Нет закуски →
-- горячее уходит сразу (решение владельца). Касса считает то же правило
-- локально (src/features/sell/courses.ts) — для тикета и офлайн-эха.
--
-- FIRE — fire_order_items: абсолютная установка состояния, повтор —
-- no-op, поэтому отдельный ключ идемпотентности не нужен (как у
-- mark_item_ready). Офлайн-строки получают id на кассе до первой попытки
-- (ключ id в p_items), чтобы Fire без сети ссылался на те же строки.
--
-- ИНВАРИАНТ: придержанное живёт только в открытом счёте. Оплата
-- освобождает оставшееся (триггер ниже): оплаченное блюдо обязано дойти
-- до кухни, иначе гость заплатит за то, чего не получит. Не нужное
-- официант снимает со счёта до оплаты.
--
-- Деньги не трогаются: цены, итоги и НДС считаются как прежде.
--
-- ⚠️ ТРЕБУЕТ 086 (append/mark *_impl), 105 (обёртки), 168 (save_menu_item).
-- ============================================================

-- ── Схема ───────────────────────────────────────────────────
ALTER TABLE menu_items
  ADD COLUMN course SMALLINT
    CONSTRAINT menu_items_course_range CHECK (course BETWEEN 1 AND 3);

ALTER TABLE order_items
  ADD COLUMN course SMALLINT
    CONSTRAINT order_items_course_range CHECK (course BETWEEN 1 AND 3),
  ADD COLUMN held BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN fired_at TIMESTAMPTZ,
  ADD COLUMN fired_by UUID REFERENCES staff(id) ON DELETE SET NULL,
  -- Придержать можно только второй и следующие курсы
  ADD CONSTRAINT order_items_held_course CHECK (NOT held OR course >= 2);

COMMENT ON COLUMN menu_items.course IS
  'Курс подачи по умолчанию (1–3); NULL — без курса, уходит на кухню сразу (179)';
COMMENT ON COLUMN order_items.course IS
  'Снимок курса строки на момент заказа (179)';
COMMENT ON COLUMN order_items.held IS
  'Строка придержана до Fire и не видна кухне; бывает только в открытом счёте (179)';

-- ── append_to_order_impl: курс, удержание, id строки с кассы ──
-- Тело 042 дословно; добавлены course, id и правило удержания.
CREATE OR REPLACE FUNCTION append_to_order_impl(
  p_order_id UUID,
  p_staff_id UUID,
  p_items    JSONB,
  p_op_uuid  UUID DEFAULT NULL  -- ключ идемпотентности (op_log)
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
  v_line_id   UUID;
  v_course    SMALLINT;
  v_new_ids   UUID[] := '{}';
  v_subtotal  INTEGER;
  v_disc_amount INTEGER;
  v_total     INTEGER;
  v_vat       INTEGER;
  v_result    JSONB;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Идемпотентность: этот дозаказ уже проведён → тот же ответ, без мутаций
  IF p_op_uuid IS NOT NULL THEN
    SELECT result INTO v_result FROM op_log
    WHERE op_uuid = p_op_uuid AND org_id = v_org;
    IF FOUND THEN
      RETURN v_result::JSON;
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order has no items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_order.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 1);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;

    v_override := NULLIF(v_item ->> 'unit_price_override', '')::INTEGER;
    v_is_custom := (v_item ->> 'menu_item_id') IS NULL;
    -- id строки, выданный кассой до первой попытки (офлайн-Fire, 179)
    v_line_id := NULLIF(v_item ->> 'id', '')::UUID;

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
      -- Свободная позиция: курс только тот, что выбрал официант
      v_course := NULLIF(v_item ->> 'course', '')::SMALLINT;
      IF v_course IS NOT NULL AND v_course NOT BETWEEN 1 AND 3 THEN
        RAISE EXCEPTION 'invalid course';
      END IF;

      INSERT INTO order_items (id, org_id, order_id, menu_item_id, variant_id, station_id,
                               name, variant_name, unit_price, qty, line_total, notes,
                               is_price_overridden, course)
      VALUES (COALESCE(v_line_id, gen_random_uuid()), v_org, p_order_id, NULL, NULL, NULL,
              v_name, NULL, v_unit, v_qty, v_line,
              NULLIF(TRIM(v_item ->> 'notes'), ''), TRUE, v_course)
      RETURNING id INTO v_oi_id;
      v_new_ids := v_new_ids || v_oi_id;
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

    -- Курс: явный выбор официанта (ключ прислан, null = «без курса»)
    -- перебивает курс блюда из каталога. Старые клиенты и QR-заказы
    -- ключа не шлют — действует каталог.
    IF v_item ? 'course' THEN
      v_course := NULLIF(v_item ->> 'course', '')::SMALLINT;
    ELSE
      v_course := v_menu_item.course;
    END IF;
    IF v_course IS NOT NULL AND v_course NOT BETWEEN 1 AND 3 THEN
      RAISE EXCEPTION 'invalid course';
    END IF;

    INSERT INTO order_items (id, org_id, order_id, menu_item_id, variant_id, station_id,
                             name, variant_name, unit_price, qty, line_total, notes,
                             is_price_overridden, course)
    VALUES (COALESCE(v_line_id, gen_random_uuid()), v_org, p_order_id, v_menu_item.id,
            v_variant.id, v_menu_item.station_id,
            v_menu_item.name, v_variant.name, v_unit, v_qty, v_line,
            NULLIF(TRIM(v_item ->> 'notes'), ''), v_override IS NOT NULL, v_course)
    RETURNING id INTO v_oi_id;
    v_new_ids := v_new_ids || v_oi_id;

    IF v_item ? 'modifier_ids' THEN
      INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta)
      SELECT v_org, v_oi_id, m.id, m.name, m.price_delta
      FROM modifiers m
      WHERE m.id IN (SELECT (jsonb_array_elements_text(v_item -> 'modifier_ids'))::UUID);
    END IF;
  END LOOP;

  -- Удержание курсов — только счёт стола: у стойки заказ оплачен сразу,
  -- готовить его надо целиком. Новая строка курса c ждёт Fire, если в
  -- счёте есть активная строка более раннего курса (уже поданная или из
  -- этого же дозаказа).
  IF v_order.table_id IS NOT NULL THEN
    UPDATE order_items oi
    SET held = TRUE
    WHERE oi.id = ANY(v_new_ids)
      AND oi.course >= 2
      AND EXISTS (
        SELECT 1 FROM order_items e
        WHERE e.order_id = p_order_id
          AND e.voided_at IS NULL
          AND e.course IS NOT NULL
          AND e.course < oi.course
      );
  END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO v_subtotal
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;

  v_disc_amount := 0;
  IF v_order.discount_type = 'percent' THEN
    v_disc_amount := ROUND(v_subtotal * v_order.discount_value / 100.0);
  ELSIF v_order.discount_type = 'fixed' THEN
    v_disc_amount := v_order.discount_value;
  END IF;
  IF v_disc_amount > v_subtotal THEN
    v_disc_amount := v_subtotal;
  END IF;

  v_total := round_order_total(v_subtotal - v_disc_amount, v_subtotal, v_disc_amount > 0);
  IF v_disc_amount > 0 THEN v_disc_amount := v_subtotal - v_total; END IF;
  v_vat := ROUND(v_total * v_order.vat_rate / (100 + v_order.vat_rate));

  UPDATE orders
  SET subtotal = v_subtotal, discount_amount = v_disc_amount,
      total = v_total, vat_amount = v_vat
  WHERE id = p_order_id;

  v_result := jsonb_build_object('order_id', p_order_id, 'total', v_total, 'subtotal', v_subtotal);

  IF p_op_uuid IS NOT NULL THEN
    INSERT INTO op_log (op_uuid, org_id, fn, result)
    VALUES (p_op_uuid, v_org, 'append_to_order', v_result);
  END IF;

  RETURN v_result::JSON;
END $$;

-- ── mark_order_ready_impl: «всё готово» не трогает придержанное ──
-- Тело 015; иначе тап кухни «заказ готов» молча отметил бы готовым
-- горячее, которое ещё не отправлено, и после Fire оно не появилось бы.
CREATE OR REPLACE FUNCTION mark_order_ready_impl(p_order_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE order_items
  SET prep_status = 'ready', ready_at = NOW()
  WHERE order_id = p_order_id AND org_id = v_org AND prep_status = 'pending'
    AND voided_at IS NULL AND NOT held;

  UPDATE orders SET status = 'fulfilled', fulfilled_at = NOW()
  WHERE id = p_order_id AND org_id = v_org AND status = 'paid';

  RETURN json_build_object('order_id', p_order_id, 'order_status', 'fulfilled');
END $$;

-- ── split_order: часть строки уносит курс и удержание ──────
-- Тело 034; при частичном переносе новая строка копирует course/held/
-- fired_*, иначе перенесённая половина придержанного блюда «подалась» бы.
CREATE OR REPLACE FUNCTION split_order(
  p_order_id UUID,
  p_staff_id UUID,
  p_items    JSONB
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_src       orders%ROWTYPE;
  v_new_id    UUID;
  v_item      JSONB;
  v_row       order_items%ROWTYPE;
  v_move_qty  INTEGER;
  v_new_oi    UUID;
  v_src_sub   INTEGER;
  v_new_sub   INTEGER;
  v_disc      INTEGER;
  v_total     INTEGER;
  v_vat       INTEGER;
  v_remaining INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'nothing to split';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_src FROM orders WHERE id = p_order_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF v_src.status <> 'open' THEN
    RAISE EXCEPTION 'order not open';
  END IF;

  INSERT INTO orders (org_id, location_id, staff_id, client_uuid, daily_number,
                      order_type, customer_name, status, vat_rate, shift_id, table_label)
  VALUES (v_org, v_src.location_id, p_staff_id, gen_random_uuid(), v_src.daily_number,
          v_src.order_type, v_src.customer_name, 'open', v_src.vat_rate, v_src.shift_id, v_src.table_label)
  RETURNING id INTO v_new_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_row FROM order_items
    WHERE id = (v_item ->> 'item_id')::UUID AND order_id = p_order_id
      AND org_id = v_org AND voided_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'item not found in order';
    END IF;

    v_move_qty := COALESCE((v_item ->> 'qty')::INTEGER, v_row.qty);
    IF v_move_qty < 1 OR v_move_qty > v_row.qty THEN
      RAISE EXCEPTION 'invalid split qty';
    END IF;

    IF v_move_qty = v_row.qty THEN
      UPDATE order_items SET order_id = v_new_id WHERE id = v_row.id;
    ELSE
      UPDATE order_items
      SET qty = qty - v_move_qty, line_total = unit_price * (qty - v_move_qty)
      WHERE id = v_row.id;

      INSERT INTO order_items (org_id, order_id, menu_item_id, variant_id, station_id,
                               name, variant_name, unit_price, qty, line_total, notes,
                               is_price_overridden, prep_status, ready_at,
                               course, held, fired_at, fired_by)
      VALUES (v_org, v_new_id, v_row.menu_item_id, v_row.variant_id, v_row.station_id,
              v_row.name, v_row.variant_name, v_row.unit_price, v_move_qty,
              v_row.unit_price * v_move_qty, v_row.notes,
              v_row.is_price_overridden, v_row.prep_status, v_row.ready_at,
              v_row.course, v_row.held, v_row.fired_at, v_row.fired_by)
      RETURNING id INTO v_new_oi;

      INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta)
      SELECT org_id, v_new_oi, modifier_id, name, price_delta
      FROM order_item_modifiers WHERE order_item_id = v_row.id;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(line_total), 0) INTO v_src_sub
  FROM order_items WHERE order_id = p_order_id AND voided_at IS NULL;
  IF v_src_sub = 0 THEN
    RAISE EXCEPTION 'cannot split all items';
  END IF;

  -- Итоги исходного (скидка остаётся тут, округляется как в остальных)
  v_disc := 0;
  IF v_src.discount_type = 'percent' THEN
    v_disc := ROUND(v_src_sub * v_src.discount_value / 100.0);
  ELSIF v_src.discount_type = 'fixed' THEN
    v_disc := v_src.discount_value;
  END IF;
  IF v_disc > v_src_sub THEN v_disc := v_src_sub; END IF;
  v_total := round_order_total(v_src_sub - v_disc, v_src_sub, v_disc > 0);
  IF v_disc > 0 THEN v_disc := v_src_sub - v_total; END IF;
  v_vat := ROUND(v_total * v_src.vat_rate / (100 + v_src.vat_rate));
  UPDATE orders SET subtotal = v_src_sub, discount_amount = v_disc, total = v_total, vat_amount = v_vat
  WHERE id = p_order_id;
  v_remaining := v_total;

  -- Итоги нового (без скидки — округление не применяется)
  SELECT COALESCE(SUM(line_total), 0) INTO v_new_sub
  FROM order_items WHERE order_id = v_new_id AND voided_at IS NULL;
  v_vat := ROUND(v_new_sub * v_src.vat_rate / (100 + v_src.vat_rate));
  UPDATE orders SET subtotal = v_new_sub, total = v_new_sub, vat_amount = v_vat
  WHERE id = v_new_id;

  RETURN json_build_object(
    'new_order_id', v_new_id,
    'new_total', v_new_sub,
    'daily_number', v_src.daily_number,
    'remaining_total', v_remaining
  );
END $$;

REVOKE EXECUTE ON FUNCTION split_order(UUID, UUID, JSONB) FROM anon, public;

-- ── fire_order_items: отправить придержанное на кухню ──────
-- Абсолютная установка состояния: уже отправленные, снятые и строки
-- закрытого счёта пропускаются, повтор из офлайн-очереди — no-op.
-- Несуществующая строка — ошибка: это не повтор, а рассинхрон кассы.
CREATE FUNCTION fire_order_items(
  p_item_ids      UUID[],
  p_staff_id      UUID,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_want  INTEGER;
  v_found INTEGER;
  v_fired UUID[];
BEGIN
  PERFORM require_org_capability('pos_operate');
  PERFORM require_staff_session(p_staff_session);
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT COUNT(DISTINCT x) INTO v_want FROM unnest(p_item_ids) x;
  IF v_want = 0 THEN
    RAISE EXCEPTION 'nothing to fire';
  END IF;
  IF v_want > 200 THEN
    RAISE EXCEPTION 'too many items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  -- Сериализуемся с дозаказом и оплатой того же счёта
  PERFORM 1 FROM orders o
  WHERE o.org_id = v_org
    AND o.id IN (SELECT i.order_id FROM order_items i
                 WHERE i.id = ANY(p_item_ids) AND i.org_id = v_org)
  ORDER BY o.id
  FOR UPDATE;

  SELECT COUNT(*) INTO v_found
  FROM order_items WHERE id = ANY(p_item_ids) AND org_id = v_org;
  IF v_found < v_want THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  WITH fired AS (
    UPDATE order_items i
    SET held = FALSE, fired_at = NOW(), fired_by = p_staff_id
    FROM orders o
    WHERE i.id = ANY(p_item_ids)
      AND i.org_id = v_org
      AND i.held
      AND i.voided_at IS NULL
      AND o.id = i.order_id
      AND o.status = 'open'
    RETURNING i.id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_fired FROM fired;

  RETURN json_build_object('fired', to_json(v_fired));
END $$;

REVOKE ALL ON FUNCTION fire_order_items(UUID[], UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fire_order_items(UUID[], UUID, UUID) TO authenticated;

COMMENT ON FUNCTION fire_order_items(UUID[], UUID, UUID) IS
  'Fire: придержанные строки открытого счёта уходят на кухню; повтор — no-op (179)';

-- ── Оплата освобождает придержанное ────────────────────────
-- Любой путь open → paid/fulfilled (оплата, оплата части после split):
-- оплаченное блюдо обязано дойти до кухни. fired_by пуст — отправила
-- оплата, а не официант.
CREATE FUNCTION release_held_items_on_close()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE order_items
  SET held = FALSE, fired_at = COALESCE(fired_at, NOW())
  WHERE order_id = NEW.id AND held;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION release_held_items_on_close() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER orders_release_held_items
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND NEW.status IN ('paid', 'fulfilled'))
  EXECUTE FUNCTION release_held_items_on_close();

-- ── save_menu_item: курс по умолчанию из карточки блюда ────
-- Обёртка 168 + поле course. Тело 129 ключ не знает и его не трогает;
-- курс пишется после него и только когда ключ прислан (частичный
-- payload не стирает курс, как cost/sku/stock в 129).
CREATE OR REPLACE FUNCTION save_menu_item(
  p_item JSONB, p_variants JSONB DEFAULT '[]', p_group_ids JSONB DEFAULT '[]',
  p_item_id UUID DEFAULT NULL, p_staff_session UUID DEFAULT NULL, p_supplies JSONB DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id     UUID;
  v_course SMALLINT;
BEGIN
  PERFORM require_org_capability('catalog_manage');
  -- Проверяем до записи: битый курс не должен оставить полусохранённый товар
  IF p_item ? 'course' THEN
    v_course := NULLIF(p_item ->> 'course', '')::SMALLINT;
    IF v_course IS NOT NULL AND v_course NOT BETWEEN 1 AND 3 THEN
      RAISE EXCEPTION 'invalid course';
    END IF;
  END IF;

  v_id := save_menu_item_129_impl(p_item, p_variants, p_group_ids, p_item_id,
                                  p_staff_session, p_supplies);

  IF p_item ? 'course' THEN
    UPDATE menu_items SET course = v_course
    WHERE id = v_id AND org_id = auth_org_id();
  END IF;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION save_menu_item(JSONB,JSONB,JSONB,UUID,UUID,JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_menu_item(JSONB,JSONB,JSONB,UUID,UUID,JSONB) TO authenticated, service_role;
