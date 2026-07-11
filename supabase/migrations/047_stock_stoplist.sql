-- ============================================================
-- 047 STOCK & STOP-LIST — рабочие остатки и списание дня (пекарня).
--
-- Схема уже была готова (menu_items.track_inventory / stock из 003),
-- но остаток ничего не делал. Теперь:
--
--   * Продажа списывает остаток (триггеры на order_items — работают
--     для place_order, append_to_order И offline-replay без правок
--     их тел). При остатке ≤ 0 товар автоматически уходит в стоп
--     (is_available = false) — экран продажи его прячет.
--   * Void позиции возвращает остаток (+qty). Доступность обратно
--     НЕ включаем: авто-возврат в продажу без человека опасен
--     (может, товар сняли руками) — вернуть можно в один тап из
--     стоп-листа на экране продажи.
--   * Częściowый split_order: у исходной строки qty уменьшается, а
--     на ту же дельту вставляется новая строка → UPDATE-триггер по
--     qty компенсирует INSERT-триггер, суммарно остаток не меняется.
--   * waste_entries — списание дня («сколько выбросили», ритуал
--     закрытия пекарни): только INSERT (аудит, инвариант №2),
--     add_waste уменьшает остаток товаров с учётом.
--
-- Остаток может уйти в минус (продали больше, чем ввели) — это
-- честный сигнал о неточном учёте, не ошибка.
-- ============================================================

-- ── Продажа: −qty, авто-стоп при нуле ────────────────────────
CREATE OR REPLACE FUNCTION order_items_stock_sale()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.menu_item_id IS NOT NULL THEN
    UPDATE menu_items
    SET stock = COALESCE(stock, 0) - NEW.qty,
        is_available = CASE WHEN COALESCE(stock, 0) - NEW.qty <= 0 THEN FALSE ELSE is_available END
    WHERE id = NEW.menu_item_id AND track_inventory;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_order_items_stock_sale ON order_items;
CREATE TRIGGER trg_order_items_stock_sale
  AFTER INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_stock_sale();

-- ── Void позиции: +qty (без авто-возврата в продажу) ─────────
CREATE OR REPLACE FUNCTION order_items_stock_void()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.menu_item_id IS NOT NULL
     AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
    UPDATE menu_items
    SET stock = COALESCE(stock, 0) + NEW.qty
    WHERE id = NEW.menu_item_id AND track_inventory;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_order_items_stock_void ON order_items;
CREATE TRIGGER trg_order_items_stock_void
  AFTER UPDATE OF voided_at ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_stock_void();

-- ── Правка qty (split_order): компенсация дельты ─────────────
CREATE OR REPLACE FUNCTION order_items_stock_qty()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.menu_item_id IS NOT NULL AND NEW.qty <> OLD.qty THEN
    UPDATE menu_items
    SET stock = COALESCE(stock, 0) + (OLD.qty - NEW.qty)
    WHERE id = NEW.menu_item_id AND track_inventory;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_order_items_stock_qty ON order_items;
CREATE TRIGGER trg_order_items_stock_qty
  AFTER UPDATE OF qty ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_stock_qty();

-- ── Void всего заказа: вернуть остатки активных позиций ──────
-- Покрывает void_table_order и авто-void брошенных заказов при
-- закрытии смены. merge_table_orders не задет: позиции переезжают
-- в целевой заказ ДО void источника (возвращать нечего).
-- Индивидуально void-нутые строки уже вернули остаток триггером выше.
CREATE OR REPLACE FUNCTION orders_stock_void()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'voided' AND OLD.status = 'open' THEN
    UPDATE menu_items mi
    SET stock = COALESCE(mi.stock, 0) + agg.total_qty
    FROM (
      SELECT oi.menu_item_id, SUM(oi.qty) AS total_qty
      FROM order_items oi
      WHERE oi.order_id = NEW.id AND oi.voided_at IS NULL AND oi.menu_item_id IS NOT NULL
      GROUP BY oi.menu_item_id
    ) agg
    WHERE mi.id = agg.menu_item_id AND mi.track_inventory;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_orders_stock_void ON orders;
CREATE TRIGGER trg_orders_stock_void
  AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_stock_void();

-- ── Списание дня ─────────────────────────────────────────────
CREATE TABLE waste_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  staff_id     UUID NOT NULL REFERENCES staff(id),
  menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,                     -- снапшот названия
  qty          INTEGER NOT NULL CHECK (qty > 0),
  unit_cost    INTEGER,                           -- себестоимость на момент списания (агороты), если задана
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_waste_entries_loc_day ON waste_entries(location_id, created_at);

ALTER TABLE waste_entries ENABLE ROW LEVEL SECURITY;

-- Чтение — своя org; запись только через add_waste (SECURITY DEFINER)
CREATE POLICY waste_entries_select ON waste_entries
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

-- ── add_waste: записи списания + уменьшение остатков ─────────
-- p_items: [{ "menu_item_id": "...", "qty": 2, "reason": "..." }, ...]
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
  v_mi    menu_items%ROWTYPE;
  v_qty   INTEGER;
  v_count INTEGER := 0;
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
    v_qty := COALESCE((v_item ->> 'qty')::INTEGER, 0);
    IF v_qty < 1 OR v_qty > 999 THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;

    SELECT * INTO v_mi FROM menu_items
    WHERE id = (v_item ->> 'menu_item_id')::UUID AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'menu item not found';
    END IF;

    INSERT INTO waste_entries (org_id, location_id, staff_id, menu_item_id, name, qty, unit_cost, reason)
    VALUES (v_org, v_loc, p_staff_id, v_mi.id, v_mi.name, v_qty, v_mi.cost,
            NULLIF(TRIM(v_item ->> 'reason'), ''));

    -- Списание уменьшает остаток учитываемых товаров (в минус можно)
    UPDATE menu_items
    SET stock = COALESCE(stock, 0) - v_qty
    WHERE id = v_mi.id AND track_inventory;

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('entries', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION add_waste FROM anon, public;
