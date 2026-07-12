-- ============================================================
-- 056 SUPPLY ITEMS — расходники на складе (стаканы, крышки, упаковка).
--
-- Расходник НЕ продаётся: у него нет цены продажи, категории, он не
-- всплывает на витрине/в поиске меню/в отчётах продаж. Отдельная
-- таблица supply_items, но живёт в том же складском журнале
-- stock_movements (055) — приход/инвентаризация/списание вручную.
--
--   * Журнал разотождествляется от menu_items: source-строка теперь
--     ссылается ЛИБО на menu_item_id, ЛИБО на supply_item_id (оба
--     nullable, name-снапшот делает строку читаемой в любом случае).
--   * receive_stock / stock_take / add_waste принимают в каждой
--     строке p_items поле kind ('menu' | 'supply'), дефолт 'menu'
--     (старые клиенты и хвост офлайн-очереди продолжают слать товары).
--   * Продажи расходников нет — триггеры 047 не трогаем.
--   * Права те же: stock_receive / stock_take / waste.
-- ============================================================

-- ── Таблица расходников ──────────────────────────────────────
CREATE TABLE supply_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  unit         TEXT,                             -- ед. измерения: шт/уп/кг/л (текстовая метка)
  stock        INTEGER NOT NULL DEFAULT 0,       -- может уйти в минус (как у товаров)
  cost         INTEGER,                          -- закупочная цена/ед, агороты
  sku          TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,    -- деактивация вместо удаления (аудит-трейл)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_supply_items_loc ON supply_items(location_id) WHERE is_active;

ALTER TABLE supply_items ENABLE ROW LEVEL SECURITY;

-- Чтение — своя org; запись только через SECURITY DEFINER RPC
CREATE POLICY supply_items_select ON supply_items
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

-- ── Журнал: ссылка на расходник (наряду с menu_item_id) ──────
ALTER TABLE stock_movements
  ADD COLUMN supply_item_id UUID REFERENCES supply_items(id) ON DELETE SET NULL;

CREATE INDEX idx_stock_movements_supply ON stock_movements(supply_item_id, created_at DESC)
  WHERE supply_item_id IS NOT NULL;

-- ── CRUD расходников (manager-сессия: справочник — как настройки) ─
-- Заведение/переименование/деактивация. Остаток и cost меняются
-- ТОЛЬКО через receive_stock/stock_take (журнал движения), здесь — нет.
CREATE OR REPLACE FUNCTION upsert_supply_item(
  p_id    UUID,                 -- NULL = создать
  p_name  TEXT,
  p_unit  TEXT DEFAULT NULL,
  p_sku   TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org  UUID := auth_org_id();
  v_loc  UUID := auth_location_id();
  v_id   UUID;
  v_name TEXT := NULLIF(TRIM(p_name), '');
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'stock_take'); -- справочник ведёт тот, кто делает инвентаризацию
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'name required';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO supply_items (org_id, location_id, name, unit, sku)
    VALUES (v_org, v_loc, v_name, NULLIF(TRIM(p_unit), ''), NULLIF(TRIM(p_sku), ''))
    RETURNING id INTO v_id;
  ELSE
    UPDATE supply_items
    SET name = v_name, unit = NULLIF(TRIM(p_unit), ''), sku = NULLIF(TRIM(p_sku), '')
    WHERE id = p_id AND org_id = v_org
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'supply item not found';
    END IF;
  END IF;

  RETURN json_build_object('id', v_id);
END $$;

REVOKE EXECUTE ON FUNCTION upsert_supply_item FROM anon, public;

CREATE OR REPLACE FUNCTION set_supply_item_active(
  p_id     UUID,
  p_active BOOLEAN,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_id  UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'stock_take');
  UPDATE supply_items SET is_active = p_active
  WHERE id = p_id AND org_id = v_org
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'supply item not found';
  END IF;
  RETURN json_build_object('id', v_id);
END $$;

REVOKE EXECUTE ON FUNCTION set_supply_item_active FROM anon, public;

-- ── receive_stock: + kind ('menu'|'supply') ──────────────────
-- p_items: [{ kind?, menu_item_id? | supply_item_id?, qty,
--             unit_cost?, update_cost? }]. kind по умолчанию 'menu'.
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
    IF v_qty < 1 OR v_qty > 9999 THEN
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

-- ── stock_take: + kind ('menu'|'supply') ─────────────────────
-- p_items: [{ kind?, menu_item_id? | supply_item_id?, counted }]
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
    IF v_counted IS NULL OR v_counted < 0 OR v_counted > 99999 THEN
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

-- ── add_waste: + kind (расходники тоже списываются) ──────────
-- p_items: [{ kind?, menu_item_id? | supply_item_id?, qty, reason? }]
-- Товары меню — как раньше: пишем waste_entries + журнал. Расходники —
-- только журнал (waste_entries.menu_item_id обязателен, расходника там нет).
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
    IF v_qty < 1 OR v_qty > 999 THEN
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

-- ── stock_report: + расходники (source-метка) ────────────────
CREATE OR REPLACE FUNCTION stock_report(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH agg AS (
    SELECT sm.menu_item_id,
           sm.supply_item_id,
           MAX(sm.name) AS moved_name,
           -COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type = 'sale'), 0)            AS sold,
            COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type IN ('void', 'split')), 0) AS returned,
           -COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type = 'waste'), 0)           AS waste,
            COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type = 'receive'), 0)         AS received,
            COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type = 'count'), 0)           AS count_adj
    FROM stock_movements sm
    WHERE sm.location_id = auth_location_id()
      AND sm.created_at >= p_from AND sm.created_at < p_to
    GROUP BY sm.menu_item_id, sm.supply_item_id
  )
  SELECT jsonb_build_object('items', COALESCE(jsonb_agg(
    jsonb_build_object(
      'menu_item_id',   a.menu_item_id,
      'supply_item_id', a.supply_item_id,
      'kind',           CASE WHEN a.supply_item_id IS NOT NULL THEN 'supply' ELSE 'menu' END,
      'name',           COALESCE(mi.name, si.name, a.moved_name),
      'unit',           si.unit,
      'sold',           a.sold,
      'returned',       a.returned,
      'waste',          a.waste,
      'received',       a.received,
      'count_adj',      a.count_adj,
      'stock_now',      CASE WHEN a.supply_item_id IS NOT NULL THEN si.stock
                             WHEN mi.track_inventory THEN mi.stock ELSE NULL END
    ) ORDER BY a.sold DESC, COALESCE(mi.name, si.name, a.moved_name)
  ), '[]'::jsonb))
  FROM agg a
  LEFT JOIN menu_items   mi ON mi.id = a.menu_item_id
  LEFT JOIN supply_items si ON si.id = a.supply_item_id;
$$;

REVOKE EXECUTE ON FUNCTION stock_report FROM anon, public;
GRANT EXECUTE ON FUNCTION stock_report(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
