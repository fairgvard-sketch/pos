-- ============================================================
-- 055 STOCK LEDGER — склад v2: приход, инвентаризация, журнал.
--
-- Единый журнал движения остатков stock_movements (только INSERT,
-- инвариант №2). menu_items.stock остаётся живым счётчиком, вся
-- механика 047 (авто-стоп, компенсация split) сохранена — триггеры
-- пересоздаются с дописыванием строки журнала через
-- UPDATE ... RETURNING stock → stock_after.
--
--   * Приход: receive_stock (право 'stock_receive', дефолт все) —
--     +qty, снапшот закупочной цены, опционально обновляет cost.
--   * Инвентаризация: stock_take (право 'stock_take', дефолт
--     manager — новый WHEN в require_staff_perm) — остаток := факт,
--     в журнал пишется дельта (0 = «пересчитано, совпало»).
--   * Приход/инвентаризация неучитываемого товара включает
--     track_inventory (быстрое включение учёта из шита).
--   * is_available не трогаем: возврат в продажу — только руками
--     из стоп-листа (философия 047).
--   * Сводка за период: stock_report (агрегация журнала).
--
-- Известное ограничение: офлайн-продажа попадает в журнал временем
-- синка (created_at триггера), не временем продажи — в строках
-- sale/void есть order_id, журнал показывает #daily_number заказа.
--
-- ⚠️ Применять ДО 045 (строгий режим). Если 045 уже применён —
-- после 055 повторно применить обновлённый 045 (в него добавлен
-- тот же WHEN 'stock_take' → manager).
-- ============================================================

-- ── Журнал движения остатков ─────────────────────────────────
CREATE TABLE stock_movements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,                    -- снапшот названия
  type         TEXT NOT NULL CHECK (type IN ('sale', 'void', 'split', 'waste', 'receive', 'count')),
  qty_delta    INTEGER NOT NULL CHECK (qty_delta <> 0 OR type = 'count'),
  stock_after  INTEGER NOT NULL,                 -- остаток после операции
  unit_cost    INTEGER,                          -- закупочная цена/ед (агороты): receive, waste
  note         TEXT,                             -- накладная/поставщик, причина, заметка
  staff_id     UUID REFERENCES staff(id),
  order_id     UUID REFERENCES orders(id) ON DELETE SET NULL, -- sale/void/split
  batch_id     UUID,                             -- группа строк одного прихода/пересчёта/списания
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stock_movements_loc_time ON stock_movements(location_id, created_at DESC);
CREATE INDEX idx_stock_movements_item     ON stock_movements(menu_item_id, created_at DESC);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;

-- Чтение — своя org; запись только из SECURITY DEFINER (триггеры/RPC)
CREATE POLICY stock_movements_select ON stock_movements
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

-- ── require_staff_perm: дефолт manager для stock_take ────────
-- Тело 044 (мягкий режим), меняется только фолбэк-CASE.
CREATE OR REPLACE FUNCTION require_staff_perm(p_session UUID, p_perm TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff staff%ROWTYPE;
  v_level TEXT;
BEGIN
  -- МЯГКИЙ режим (044): без токена пропускаем — дорабатывают старые
  -- клиенты и хвост офлайн-очереди. 045 заменяет ветку на RAISE.
  IF p_session IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT s.* INTO v_staff
  FROM staff_sessions ss
  JOIN staff s ON s.id = ss.staff_id
  WHERE ss.token = p_session
    AND ss.org_id = auth_org_id()
    AND ss.revoked_at IS NULL
    AND ss.expires_at > NOW()
    AND s.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff session invalid';
  END IF;

  -- Скользящее продление: активная сессия не протухает посреди смены
  UPDATE staff_sessions
  SET expires_at = GREATEST(expires_at, NOW() + INTERVAL '72 hours')
  WHERE token = p_session;

  v_level := COALESCE(
    (SELECT l.settings #>> ARRAY['perms', p_perm] FROM locations l WHERE l.id = auth_location_id()),
    CASE p_perm WHEN 'refund' THEN 'manager' WHEN 'manage' THEN 'manager'
                WHEN 'stock_take' THEN 'manager' ELSE 'all' END
  );

  IF v_level = 'manager' AND v_staff.role NOT IN ('manager', 'owner') THEN
    RAISE EXCEPTION 'forbidden: %', p_perm;
  END IF;

  RETURN v_staff.id;
END $$;

-- ── Триггеры 047 + запись в журнал (имена те же, перевес не нужен) ─

-- Продажа: −qty, авто-стоп при нуле
CREATE OR REPLACE FUNCTION order_items_stock_sale()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
  v_ord   RECORD;
BEGIN
  IF NEW.menu_item_id IS NOT NULL THEN
    UPDATE menu_items
    SET stock = COALESCE(stock, 0) - NEW.qty,
        is_available = CASE WHEN COALESCE(stock, 0) - NEW.qty <= 0 THEN FALSE ELSE is_available END
    WHERE id = NEW.menu_item_id AND track_inventory
    RETURNING stock, name INTO v_after, v_name;
    IF FOUND THEN
      SELECT o.org_id, o.location_id, o.staff_id INTO v_ord FROM orders o WHERE o.id = NEW.order_id;
      INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, staff_id, order_id)
      VALUES (v_ord.org_id, v_ord.location_id, NEW.menu_item_id, v_name, 'sale', -NEW.qty, v_after, v_ord.staff_id, NEW.order_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Void позиции: +qty (без авто-возврата в продажу)
CREATE OR REPLACE FUNCTION order_items_stock_void()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
  v_ord   RECORD;
BEGIN
  IF NEW.menu_item_id IS NOT NULL
     AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
    UPDATE menu_items
    SET stock = COALESCE(stock, 0) + NEW.qty
    WHERE id = NEW.menu_item_id AND track_inventory
    RETURNING stock, name INTO v_after, v_name;
    IF FOUND THEN
      SELECT o.org_id, o.location_id, o.staff_id INTO v_ord FROM orders o WHERE o.id = NEW.order_id;
      INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, staff_id, order_id)
      VALUES (v_ord.org_id, v_ord.location_id, NEW.menu_item_id, v_name, 'void', NEW.qty, v_after, v_ord.staff_id, NEW.order_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Правка qty (split_order): компенсация дельты — в паре со строкой
-- 'sale' нового заказа суммарное движение по журналу = 0
CREATE OR REPLACE FUNCTION order_items_stock_qty()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
  v_ord   RECORD;
BEGIN
  IF NEW.menu_item_id IS NOT NULL AND NEW.qty <> OLD.qty THEN
    UPDATE menu_items
    SET stock = COALESCE(stock, 0) + (OLD.qty - NEW.qty)
    WHERE id = NEW.menu_item_id AND track_inventory
    RETURNING stock, name INTO v_after, v_name;
    IF FOUND THEN
      SELECT o.org_id, o.location_id, o.staff_id INTO v_ord FROM orders o WHERE o.id = NEW.order_id;
      INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, staff_id, order_id)
      VALUES (v_ord.org_id, v_ord.location_id, NEW.menu_item_id, v_name, 'split', OLD.qty - NEW.qty, v_after, v_ord.staff_id, NEW.order_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Void всего заказа: вернуть остатки активных позиций
CREATE OR REPLACE FUNCTION orders_stock_void()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'voided' AND OLD.status = 'open' THEN
    WITH agg AS (
      SELECT oi.menu_item_id, SUM(oi.qty) AS total_qty
      FROM order_items oi
      WHERE oi.order_id = NEW.id AND oi.voided_at IS NULL AND oi.menu_item_id IS NOT NULL
      GROUP BY oi.menu_item_id
    ),
    upd AS (
      UPDATE menu_items mi
      SET stock = COALESCE(mi.stock, 0) + agg.total_qty
      FROM agg
      WHERE mi.id = agg.menu_item_id AND mi.track_inventory
      RETURNING mi.id, mi.name, mi.stock, agg.total_qty
    )
    INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, staff_id, order_id)
    SELECT NEW.org_id, NEW.location_id, upd.id, upd.name, 'void', upd.total_qty, upd.stock, NEW.staff_id, NEW.id
    FROM upd;
  END IF;
  RETURN NEW;
END $$;

-- ── add_waste: + строка журнала (waste_entries не трогаем) ───
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
  v_batch UUID := gen_random_uuid();
  v_after INTEGER;
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
    WHERE id = v_mi.id AND track_inventory
    RETURNING stock INTO v_after;
    IF FOUND THEN
      INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_mi.id, v_mi.name, 'waste', -v_qty, v_after, v_mi.cost,
              NULLIF(TRIM(v_item ->> 'reason'), ''), p_staff_id, v_batch);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('entries', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION add_waste FROM anon, public;

-- ── receive_stock: приход товара ─────────────────────────────
-- p_items: [{ "menu_item_id": "...", "qty": 3,
--             "unit_cost": 450, "update_cost": true }, ...]
-- unit_cost (агороты/ед) снапшотится в журнал; update_cost переносит
-- его в menu_items.cost. Приход неучитываемого товара включает учёт.
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
    v_id   := (v_item ->> 'menu_item_id')::UUID;
    v_qty  := COALESCE((v_item ->> 'qty')::INTEGER, 0);
    v_cost := (v_item ->> 'unit_cost')::INTEGER;
    v_upd  := COALESCE((v_item ->> 'update_cost')::BOOLEAN, FALSE);
    IF v_qty < 1 OR v_qty > 9999 THEN
      RAISE EXCEPTION 'invalid qty';
    END IF;
    IF v_cost IS NOT NULL AND (v_cost < 0 OR v_cost > 100000000) THEN
      RAISE EXCEPTION 'invalid cost';
    END IF;

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

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('batch_id', v_batch, 'items', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION receive_stock FROM anon, public;

-- ── stock_take: инвентаризация (остаток := факт) ─────────────
-- p_items: [{ "menu_item_id": "...", "counted": 12 }, ...]
-- Нулевая дельта пишется («пересчитано, совпало» — аудит).
-- Семантика — last-write-wins против конкурентной продажи после
-- нажатия «Сохранить»; FOR UPDATE закрывает гонку внутри RPC.
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
    v_id      := (v_item ->> 'menu_item_id')::UUID;
    v_counted := (v_item ->> 'counted')::INTEGER;
    IF v_counted IS NULL OR v_counted < 0 OR v_counted > 99999 THEN
      RAISE EXCEPTION 'invalid counted';
    END IF;

    SELECT stock, name INTO v_old, v_name FROM menu_items
    WHERE id = v_id AND org_id = v_org
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'menu item not found';
    END IF;

    UPDATE menu_items
    SET stock = v_counted, track_inventory = TRUE
    WHERE id = v_id;

    INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, note, staff_id, batch_id)
    VALUES (v_org, v_loc, v_id, v_name, 'count', v_counted - COALESCE(v_old, 0), v_counted, v_note, p_staff_id, v_batch);

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('batch_id', v_batch, 'items', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION stock_take FROM anon, public;

-- ── stock_report: сводка движения за период ──────────────────
-- SECURITY INVOKER (как sales_report в 026) — журнал и так читается
-- RLS-SELECT устройства, отдельного права не требует.
CREATE OR REPLACE FUNCTION stock_report(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH agg AS (
    SELECT sm.menu_item_id,
           MAX(sm.name) AS moved_name,
           -COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type = 'sale'), 0)            AS sold,
            COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type IN ('void', 'split')), 0) AS returned,
           -COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type = 'waste'), 0)           AS waste,
            COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type = 'receive'), 0)         AS received,
            COALESCE(SUM(sm.qty_delta) FILTER (WHERE sm.type = 'count'), 0)           AS count_adj
    FROM stock_movements sm
    WHERE sm.location_id = auth_location_id()
      AND sm.created_at >= p_from AND sm.created_at < p_to
    GROUP BY sm.menu_item_id
  )
  SELECT jsonb_build_object('items', COALESCE(jsonb_agg(
    jsonb_build_object(
      'menu_item_id', a.menu_item_id,
      'name',         COALESCE(mi.name, a.moved_name),
      'sold',         a.sold,
      'returned',     a.returned,
      'waste',        a.waste,
      'received',     a.received,
      'count_adj',    a.count_adj,
      'stock_now',    CASE WHEN mi.track_inventory THEN mi.stock ELSE NULL END
    ) ORDER BY a.sold DESC, COALESCE(mi.name, a.moved_name)
  ), '[]'::jsonb))
  FROM agg a
  LEFT JOIN menu_items mi ON mi.id = a.menu_item_id;
$$;

REVOKE EXECUTE ON FUNCTION stock_report FROM anon, public;
GRANT EXECUTE ON FUNCTION stock_report(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
