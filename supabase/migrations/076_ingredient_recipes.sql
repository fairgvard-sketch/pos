-- ============================================================
-- 076 INGREDIENT RECIPES — рецептуры: ингредиенты и расход модификаторов.
--
-- Ингредиент — тот же supply_item (056), но склад ведётся в БАЗОВЫХ
-- единицах (г/мл/шт) ЦЕЛЫМИ числами — как деньги в агоротах, float
-- запрещён. Мешок муки 25 кг = 25000 г. Конвенция стоимости: для unit
-- 'г'/'мл' supply_items.cost — агороты за 1000 базовых единиц (т.е.
-- за кг/л), для штучных — за штуку. Сервер стоимость не перемножает,
-- конвенция живёт в UI и docs/database.md.
--
--   * Рецепт варианта — те же variant_supplies (075): лимит qty там
--     расширен до 99999 (граммы на единицу товара).
--   * modifier_supplies: расход МОДИФИКАТОРА (сироп 20 мл, доп. шот
--     9 г зерна, овсяное молоко 180 мл). Списывается триггером на
--     order_item_modifiers, без условия takeaway — сироп тратится и в
--     зале. Дефолтные модификаторы кассир получает автоматически
--     (SellPage defaultConfig), поэтому ЗАМЕНА молока моделируется
--     расходом на модификаторах группы «Молоко»: рецепт товара молока
--     не содержит, дефолтный модификатор несёт коровье, выбранный —
--     альтернативное. Ограничение фазы 1: расход модификатора один на
--     все размеры товара.
--   * Компенсации не тронуты: возврат по журналу
--     stock_movements.order_item_id (075) охватывает и строки
--     модификаторов автоматически — void/split уже точные.
--   * Лимиты receive_stock / stock_take / add_waste для kind='supply'
--     подняты под граммы; для товаров меню лимиты прежние.
--
-- Доступ (правило 071): новые объекты выдают явные GRANT сами.
-- ============================================================

-- ── Расход модификатора ──────────────────────────────────────
CREATE TABLE modifier_supplies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  modifier_id    UUID NOT NULL REFERENCES modifiers(id) ON DELETE CASCADE,
  supply_item_id UUID NOT NULL REFERENCES supply_items(id) ON DELETE CASCADE,
  -- За единицу товара, в базовых единицах расходника
  qty            INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 99999),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (modifier_id, supply_item_id)
);

CREATE INDEX idx_modifier_supplies_mod ON modifier_supplies(modifier_id);

ALTER TABLE modifier_supplies ENABLE ROW LEVEL SECURITY;

-- CRUD как у modifiers (003): прямой доступ authenticated в своей org.
-- WITH CHECK дополнительно связывает модификатор И расходник со своей
-- организацией: чужой supply_item в связке дал бы cross-tenant списание
-- триггером продажи.
CREATE POLICY modifier_supplies_all ON modifier_supplies FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (
    org_id = auth_org_id()
    AND EXISTS (SELECT 1 FROM modifiers m
                WHERE m.id = modifier_id AND m.org_id = auth_org_id())
    AND EXISTS (SELECT 1 FROM supply_items si
                WHERE si.id = supply_item_id AND si.org_id = auth_org_id())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON modifier_supplies TO authenticated;
GRANT ALL ON modifier_supplies TO service_role;

-- ── Продажа: расход модификаторов ────────────────────────────
-- Триггер на order_item_modifiers, а не на order_items: строки
-- модификаторов вставляются ПОСЛЕ строки заказа (FK), момент INSERT
-- модификатора — единственный, когда состав известен. Работает для
-- place_order, append_to_order, offline-replay и копирования
-- модификаторов при split без правок их тел.
CREATE OR REPLACE FUNCTION order_item_modifiers_stock_sale()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_oi    RECORD;
  v_ord   RECORD;
  v_comp  RECORD;
  v_after INTEGER;
  v_name  TEXT;
BEGIN
  IF NEW.modifier_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT oi.id, oi.order_id, oi.qty INTO v_oi
  FROM order_items oi WHERE oi.id = NEW.order_item_id;
  SELECT o.org_id, o.location_id, o.staff_id INTO v_ord
  FROM orders o WHERE o.id = v_oi.order_id;

  FOR v_comp IN
    SELECT ms.supply_item_id, SUM(ms.qty) AS per_unit
    FROM modifier_supplies ms
    WHERE ms.modifier_id = NEW.modifier_id AND ms.org_id = v_ord.org_id
    GROUP BY ms.supply_item_id
  LOOP
    UPDATE supply_items
    SET stock = stock - v_comp.per_unit * v_oi.qty
    WHERE id = v_comp.supply_item_id AND is_active
    RETURNING stock, name INTO v_after, v_name;
    IF FOUND THEN
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, staff_id, order_id, order_item_id)
      VALUES (v_ord.org_id, v_ord.location_id, v_comp.supply_item_id, v_name, 'sale', -(v_comp.per_unit * v_oi.qty), v_after, v_ord.staff_id, v_oi.order_id, v_oi.id);
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_order_item_modifiers_stock_sale ON order_item_modifiers;
CREATE TRIGGER trg_order_item_modifiers_stock_sale
  AFTER INSERT ON order_item_modifiers
  FOR EACH ROW EXECUTE FUNCTION order_item_modifiers_stock_sale();

-- ── receive_stock: лимиты по kind (граммы для расходников) ───
-- Тело 056; меняется только проверка qty: menu ≤ 9999 (как было),
-- supply ≤ 1 000 000 (тонна муки в граммах).
CREATE OR REPLACE FUNCTION receive_stock(
  p_staff_id UUID,
  p_items    JSONB,
  p_note     TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_loc   UUID := auth_location_id();
  v_item  JSONB;
  v_kind  TEXT;
  v_id    UUID;
  v_qty   INTEGER;
  v_max   INTEGER;
  v_cost  INTEGER;
  v_upd   BOOLEAN;
  v_after INTEGER;
  v_name  TEXT;
  v_count INTEGER := 0;
  v_batch UUID := gen_random_uuid();
  v_note  TEXT := NULLIF(TRIM(p_note), '');
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'stock_receive');
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'nothing to receive';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_kind := COALESCE(v_item ->> 'kind', 'menu');
    v_qty  := COALESCE((v_item ->> 'qty')::INTEGER, 0);
    v_cost := (v_item ->> 'unit_cost')::INTEGER;
    v_upd  := COALESCE((v_item ->> 'update_cost')::BOOLEAN, FALSE);
    IF v_kind = 'supply' THEN
      v_max := 1000000;
    ELSE
      v_max := 9999;
    END IF;
    IF v_qty < 1 OR v_qty > v_max THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;
    IF v_cost IS NOT NULL AND (v_cost < 0 OR v_cost > 100000000) THEN
      RAISE EXCEPTION 'invalid cost';
    END IF;

    IF v_kind = 'supply' THEN
      v_id := (v_item ->> 'supply_item_id')::UUID;
      UPDATE supply_items
      SET stock = stock + v_qty,
          cost = CASE WHEN v_upd AND v_cost IS NOT NULL THEN v_cost ELSE cost END
      WHERE id = v_id AND org_id = v_org
      RETURNING stock, name INTO v_after, v_name;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'supply item not found';
      END IF;
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'receive', v_qty, v_after, v_cost, v_note, p_staff_id, v_batch);
    ELSE
      v_id := (v_item ->> 'menu_item_id')::UUID;
      UPDATE menu_items
      SET stock = COALESCE(stock, 0) + v_qty,
          track_inventory = TRUE,
          cost = CASE WHEN v_upd AND v_cost IS NOT NULL THEN v_cost ELSE cost END
      WHERE id = v_id AND org_id = v_org
      RETURNING stock, name INTO v_after, v_name;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'menu item not found';
      END IF;
      INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'receive', v_qty, v_after, v_cost, v_note, p_staff_id, v_batch);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('batch_id', v_batch, 'items', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION receive_stock FROM anon, public;

-- ── stock_take: лимиты по kind ───────────────────────────────
-- Тело 056; counted: menu ≤ 99999 (как было), supply ≤ 10 000 000.
CREATE OR REPLACE FUNCTION stock_take(
  p_staff_id UUID,
  p_items    JSONB,
  p_note     TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org     UUID := auth_org_id();
  v_loc     UUID := auth_location_id();
  v_item    JSONB;
  v_kind    TEXT;
  v_id      UUID;
  v_counted INTEGER;
  v_max     INTEGER;
  v_old     INTEGER;
  v_name    TEXT;
  v_count   INTEGER := 0;
  v_batch   UUID := gen_random_uuid();
  v_note    TEXT := NULLIF(TRIM(p_note), '');
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'stock_take');
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'nothing to count';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_kind    := COALESCE(v_item ->> 'kind', 'menu');
    v_counted := (v_item ->> 'counted')::INTEGER;
    IF v_kind = 'supply' THEN
      v_max := 10000000;
    ELSE
      v_max := 99999;
    END IF;
    IF v_counted IS NULL OR v_counted < 0 OR v_counted > v_max THEN
      RAISE EXCEPTION 'invalid counted';
    END IF;

    IF v_kind = 'supply' THEN
      v_id := (v_item ->> 'supply_item_id')::UUID;
      SELECT stock, name INTO v_old, v_name FROM supply_items
      WHERE id = v_id AND org_id = v_org FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'supply item not found';
      END IF;
      UPDATE supply_items SET stock = v_counted WHERE id = v_id;
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'count', v_counted - COALESCE(v_old, 0), v_counted, v_note, p_staff_id, v_batch);
    ELSE
      v_id := (v_item ->> 'menu_item_id')::UUID;
      SELECT stock, name INTO v_old, v_name FROM menu_items
      WHERE id = v_id AND org_id = v_org FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'menu item not found';
      END IF;
      UPDATE menu_items SET stock = v_counted, track_inventory = TRUE WHERE id = v_id;
      INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'count', v_counted - COALESCE(v_old, 0), v_counted, v_note, p_staff_id, v_batch);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('batch_id', v_batch, 'items', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION stock_take FROM anon, public;

-- ── add_waste: лимиты по kind ────────────────────────────────
-- Тело 056; qty: menu ≤ 999 (как было), supply ≤ 1 000 000
-- (вылить прокисшие 5 л молока = 5000 мл).
CREATE OR REPLACE FUNCTION add_waste(
  p_staff_id UUID,
  p_items    JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_loc   UUID := auth_location_id();
  v_item  JSONB;
  v_kind  TEXT;
  v_mi    menu_items%ROWTYPE;
  v_si    supply_items%ROWTYPE;
  v_qty   INTEGER;
  v_max   INTEGER;
  v_count INTEGER := 0;
  v_batch UUID := gen_random_uuid();
  v_after INTEGER;
  v_reason TEXT;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'waste');
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'nothing to waste';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_kind := COALESCE(v_item ->> 'kind', 'menu');
    v_qty  := COALESCE((v_item ->> 'qty')::INTEGER, 0);
    IF v_kind = 'supply' THEN
      v_max := 1000000;
    ELSE
      v_max := 999;
    END IF;
    IF v_qty < 1 OR v_qty > v_max THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;
    v_reason := NULLIF(TRIM(v_item ->> 'reason'), '');

    IF v_kind = 'supply' THEN
      SELECT * INTO v_si FROM supply_items
      WHERE id = (v_item ->> 'supply_item_id')::UUID AND org_id = v_org;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'supply item not found';
      END IF;
      UPDATE supply_items SET stock = stock - v_qty WHERE id = v_si.id
      RETURNING stock INTO v_after;
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_si.id, v_si.name, 'waste', -v_qty, v_after, v_si.cost, v_reason, p_staff_id, v_batch);
    ELSE
      SELECT * INTO v_mi FROM menu_items
      WHERE id = (v_item ->> 'menu_item_id')::UUID AND org_id = v_org;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'menu item not found';
      END IF;

      INSERT INTO waste_entries (org_id, location_id, staff_id, menu_item_id, name, qty, unit_cost, reason)
      VALUES (v_org, v_loc, p_staff_id, v_mi.id, v_mi.name, v_qty, v_mi.cost, v_reason);

      UPDATE menu_items SET stock = COALESCE(stock, 0) - v_qty
      WHERE id = v_mi.id AND track_inventory
      RETURNING stock INTO v_after;
      IF FOUND THEN
        INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, note, staff_id, batch_id)
        VALUES (v_org, v_loc, v_mi.id, v_mi.name, 'waste', -v_qty, v_after, v_mi.cost, v_reason, p_staff_id, v_batch);
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('entries', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION add_waste FROM anon, public;
