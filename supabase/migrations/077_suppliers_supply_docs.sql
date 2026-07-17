-- ============================================================
-- 077 SUPPLIERS + SUPPLY DOCS — поставщики, приходные накладные,
-- средневзвешенная себестоимость и денежная оценка журнала.
--
-- Четыре шага к складу уровня Poster и точнее:
--
--   * suppliers: справочник поставщиков (телефон — под будущие
--     заявки в WhatsApp). Ведётся RPC с правом 'stock_receive' —
--     поставщика заводит тот, кто принимает поставку.
--   * supply_docs: приход становится ДОКУМЕНТОМ. id документа =
--     batch_id строк журнала (строки накладной — это её строки
--     stock_movements). Клиент передаёт p_doc_id (UUID, создаётся до
--     первой попытки) → повтор после timeout возвращает первый
--     результат, а не удваивает остатки (инвариант №6). Документ
--     неизменяем; ошибка прихода правится инвентаризацией.
--   * Средневзвешенная себестоимость: приход с ценой пересчитывает
--     cost = (остаток×cost + qty×цена)/(остаток+qty) автоматически.
--     update_cost=TRUE остаётся ручным «установить точно» (иная
--     семантика, чем в 055/056: раньше цена без флага cost не меняла).
--     При нулевом/минусовом остатке или пустом cost база для среднего
--     отсутствует — берётся цена прихода.
--   * stock_movements.value: денежная оценка каждого движения в
--     агоротах (знак = знак qty_delta), считается в момент записи по
--     текущей себестоимости (для receive — по цене прихода). Отчёты в
--     деньгах становятся историческими фактами: ретроактивная правка
--     cost не переписывает прошлое (в отличие от Poster). Конвенция
--     076: для unit 'г'/'мл' cost — агороты за 1000 базовых единиц,
--     divisor живёт в movement_value().
--   * supply_packagings: фасовки («мешок 25 кг» = 25000 г) — чистый
--     UI-хелпер приёмки, на списание не влияет.
--
-- Доступ (правило 071): новые объекты выдают явные GRANT сами.
-- ============================================================

-- ── Поставщики ───────────────────────────────────────────────
CREATE TABLE suppliers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT,
  note       TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,     -- деактивация вместо удаления
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_suppliers_org ON suppliers(org_id) WHERE is_active;

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY suppliers_select ON suppliers
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

GRANT SELECT ON suppliers TO authenticated;
GRANT ALL ON suppliers TO service_role;

-- ── Приходные накладные ──────────────────────────────────────
-- id = batch_id строк журнала этого прихода. total — снапшот суммы
-- строк в агоротах на момент проведения (BIGINT: qty×cost без потолка).
CREATE TABLE supply_docs (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  doc_no      TEXT,                              -- номер накладной поставщика
  note        TEXT,
  total       BIGINT NOT NULL DEFAULT 0,
  staff_id    UUID REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_supply_docs_loc_time ON supply_docs(location_id, created_at DESC);

ALTER TABLE supply_docs ENABLE ROW LEVEL SECURITY;

-- Чтение — своя org; запись только из receive_stock (SECURITY DEFINER)
CREATE POLICY supply_docs_select ON supply_docs
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

GRANT SELECT ON supply_docs TO authenticated;
GRANT ALL ON supply_docs TO service_role;

-- ── Фасовки ──────────────────────────────────────────────────
-- CRUD как у modifier_supplies (076): прямой доступ authenticated в
-- своей org; WITH CHECK привязывает расходник к org (чужая фасовка
-- бессмысленна и не должна протекать между tenant'ами).
CREATE TABLE supply_packagings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  supply_item_id UUID NOT NULL REFERENCES supply_items(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,                  -- «мешок 25 кг»
  qty            INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 10000000), -- базовых единиц в фасовке
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_supply_packagings_item ON supply_packagings(supply_item_id);

ALTER TABLE supply_packagings ENABLE ROW LEVEL SECURITY;

CREATE POLICY supply_packagings_all ON supply_packagings FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (
    org_id = auth_org_id()
    AND EXISTS (SELECT 1 FROM supply_items si
                WHERE si.id = supply_item_id AND si.org_id = auth_org_id())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON supply_packagings TO authenticated;
GRANT ALL ON supply_packagings TO service_role;

-- ── Журнал: денежная оценка движения ─────────────────────────
ALTER TABLE stock_movements
  ADD COLUMN value BIGINT;                       -- агороты, знак = знак qty_delta

-- Оценка движения: qty × cost с учётом конвенции единиц (076).
-- BIGINT: продукт qty×cost может не влезть в INTEGER на граммах, а
-- qty в триггерах приходит из SUM() уже как BIGINT.
CREATE FUNCTION movement_value(p_qty BIGINT, p_cost INTEGER, p_unit TEXT)
RETURNS BIGINT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_cost IS NULL THEN NULL
    WHEN p_unit IN ('г', 'мл') THEN round(p_qty::numeric * p_cost / 1000)::BIGINT
    ELSE p_qty * p_cost
  END
$$;

REVOKE EXECUTE ON FUNCTION movement_value FROM anon, public;
GRANT EXECUTE ON FUNCTION movement_value(BIGINT, INTEGER, TEXT) TO authenticated, service_role;

-- ── CRUD поставщиков ─────────────────────────────────────────
CREATE FUNCTION upsert_supplier(
  p_id    UUID,                 -- NULL = создать
  p_name  TEXT,
  p_phone TEXT DEFAULT NULL,
  p_note  TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org  UUID := auth_org_id();
  v_id   UUID;
  v_name TEXT := NULLIF(TRIM(p_name), '');
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'stock_receive');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'name required';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO suppliers (org_id, name, phone, note)
    VALUES (v_org, v_name, NULLIF(TRIM(p_phone), ''), NULLIF(TRIM(p_note), ''))
    RETURNING id INTO v_id;
  ELSE
    UPDATE suppliers
    SET name = v_name, phone = NULLIF(TRIM(p_phone), ''), note = NULLIF(TRIM(p_note), '')
    WHERE id = p_id AND org_id = v_org
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'supplier not found';
    END IF;
  END IF;

  RETURN json_build_object('id', v_id);
END $$;

REVOKE EXECUTE ON FUNCTION upsert_supplier FROM anon, public;
GRANT EXECUTE ON FUNCTION upsert_supplier(UUID, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE FUNCTION set_supplier_active(
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
  PERFORM require_staff_perm(p_staff_session, 'stock_receive');
  UPDATE suppliers SET is_active = p_active
  WHERE id = p_id AND org_id = v_org
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'supplier not found';
  END IF;
  RETURN json_build_object('id', v_id);
END $$;

REVOKE EXECUTE ON FUNCTION set_supplier_active FROM anon, public;
GRANT EXECUTE ON FUNCTION set_supplier_active(UUID, BOOLEAN, UUID) TO authenticated, service_role;

-- ── receive_stock: накладная + средневзвешенный cost + value ─
-- Новые параметры меняют сигнатуру → DROP старой (075-паттерн) и
-- re-GRANT. p_doc_id — клиентский UUID документа (идемпотентность);
-- NULL = старый клиент, документ создаётся с server-generated id.
DROP FUNCTION IF EXISTS receive_stock(UUID, JSONB, TEXT, UUID);

CREATE FUNCTION receive_stock(
  p_staff_id UUID,
  p_items    JSONB,
  p_note     TEXT DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL,
  p_supplier_id UUID DEFAULT NULL,
  p_doc_no   TEXT DEFAULT NULL,
  p_doc_id   UUID DEFAULT NULL
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
  v_ncost INTEGER;
  v_unit  TEXT;
  v_value BIGINT;
  v_total BIGINT := 0;
  v_count INTEGER := 0;
  v_batch UUID := COALESCE(p_doc_id, gen_random_uuid());
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
  IF p_supplier_id IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND org_id = v_org) THEN
    RAISE EXCEPTION 'supplier not found';
  END IF;

  -- Повтор того же документа (timeout/replay) возвращает первый
  -- результат, остатки не трогаются (инвариант №6)
  IF p_doc_id IS NOT NULL THEN
    SELECT total INTO v_total FROM supply_docs
    WHERE id = p_doc_id AND org_id = v_org;
    IF FOUND THEN
      RETURN json_build_object(
        'batch_id', p_doc_id,
        'items', (SELECT COUNT(*) FROM stock_movements
                  WHERE batch_id = p_doc_id AND org_id = v_org),
        'total', v_total,
        'duplicate', TRUE
      );
    END IF;
    v_total := 0;  -- SELECT INTO без строки затёр инициализацию NULL'ом
  END IF;

  -- Документ создаётся ДО строк: гонка двух повторов одного p_doc_id
  -- упирается в PRIMARY KEY, проигравшая транзакция откатывается целиком
  INSERT INTO supply_docs (id, org_id, location_id, supplier_id, doc_no, note, staff_id)
  VALUES (v_batch, v_org, v_loc, p_supplier_id, NULLIF(TRIM(p_doc_no), ''), v_note, p_staff_id);

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
          cost = CASE
            WHEN v_cost IS NULL THEN cost
            WHEN v_upd THEN v_cost
            WHEN cost IS NULL OR stock <= 0 THEN v_cost
            ELSE round((stock::numeric * cost + v_qty::numeric * v_cost) / (stock + v_qty))::INTEGER
          END
      WHERE id = v_id AND org_id = v_org
      RETURNING stock, name, cost, unit INTO v_after, v_name, v_ncost, v_unit;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'supply item not found';
      END IF;
      v_value := movement_value(v_qty, COALESCE(v_cost, v_ncost), v_unit);
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, value, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'receive', v_qty, v_after, v_cost, v_value, v_note, p_staff_id, v_batch);
    ELSE
      v_id := (v_item ->> 'menu_item_id')::UUID;
      UPDATE menu_items
      SET stock = COALESCE(stock, 0) + v_qty,
          track_inventory = TRUE,
          cost = CASE
            WHEN v_cost IS NULL THEN cost
            WHEN v_upd THEN v_cost
            WHEN cost IS NULL OR COALESCE(stock, 0) <= 0 THEN v_cost
            ELSE round((COALESCE(stock, 0)::numeric * cost + v_qty::numeric * v_cost) / (COALESCE(stock, 0) + v_qty))::INTEGER
          END
      WHERE id = v_id AND org_id = v_org
      RETURNING stock, name, cost INTO v_after, v_name, v_ncost;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'menu item not found';
      END IF;
      v_value := movement_value(v_qty, COALESCE(v_cost, v_ncost), NULL);
      INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, value, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'receive', v_qty, v_after, v_cost, v_value, v_note, p_staff_id, v_batch);
    END IF;

    v_total := v_total + COALESCE(v_value, 0);
    v_count := v_count + 1;
  END LOOP;

  UPDATE supply_docs SET total = v_total WHERE id = v_batch;

  RETURN json_build_object('batch_id', v_batch, 'items', v_count, 'total', v_total);
END $$;

REVOKE EXECUTE ON FUNCTION receive_stock FROM anon, public;
GRANT EXECUTE ON FUNCTION receive_stock(UUID, JSONB, TEXT, UUID, UUID, TEXT, UUID)
  TO authenticated, service_role;

-- ── Триггеры продажи/компенсаций: + unit_cost и value ────────
-- Тела 075/076 без изменений логики; каждая строка журнала получает
-- снапшот себестоимости на момент движения. Компенсации оцениваются по
-- ТЕКУЩЕМУ cost (симметрично продаже при неизменной цене; дрейф между
-- продажей и void — осознанное упрощение, количества точны по журналу).

-- Продажа: −товар + −упаковка/рецепт (075)
CREATE OR REPLACE FUNCTION order_items_stock_sale()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
  v_cost  INTEGER;
  v_unit  TEXT;
  v_ord   RECORD;
  v_comp  RECORD;
BEGIN
  IF NEW.menu_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT o.org_id, o.location_id, o.staff_id, o.order_type INTO v_ord
  FROM orders o WHERE o.id = NEW.order_id;

  UPDATE menu_items
  SET stock = COALESCE(stock, 0) - NEW.qty,
      is_available = CASE WHEN COALESCE(stock, 0) - NEW.qty <= 0 THEN FALSE ELSE is_available END
  WHERE id = NEW.menu_item_id AND track_inventory
  RETURNING stock, name, cost INTO v_after, v_name, v_cost;
  IF FOUND THEN
    INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, value, staff_id, order_id, order_item_id)
    VALUES (v_ord.org_id, v_ord.location_id, NEW.menu_item_id, v_name, 'sale', -NEW.qty, v_after,
            v_cost, movement_value(-NEW.qty, v_cost, NULL), v_ord.staff_id, NEW.order_id, NEW.id);
  END IF;

  FOR v_comp IN
    SELECT vs.supply_item_id, SUM(vs.qty) AS per_unit
    FROM variant_supplies vs
    WHERE vs.menu_item_id = NEW.menu_item_id
      AND (vs.variant_id IS NULL OR vs.variant_id = NEW.variant_id)
      AND (NOT vs.takeaway_only OR v_ord.order_type IN ('takeaway', 'delivery'))
    GROUP BY vs.supply_item_id
  LOOP
    UPDATE supply_items
    SET stock = stock - v_comp.per_unit * NEW.qty
    WHERE id = v_comp.supply_item_id AND is_active
    RETURNING stock, name, cost, unit INTO v_after, v_name, v_cost, v_unit;
    IF FOUND THEN
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, value, staff_id, order_id, order_item_id)
      VALUES (v_ord.org_id, v_ord.location_id, v_comp.supply_item_id, v_name, 'sale', -(v_comp.per_unit * NEW.qty), v_after,
              v_cost, movement_value(-(v_comp.per_unit * NEW.qty), v_cost, v_unit), v_ord.staff_id, NEW.order_id, NEW.id);
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

-- Void позиции: +товар + возврат упаковки по журналу (075)
CREATE OR REPLACE FUNCTION order_items_stock_void()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
  v_cost  INTEGER;
  v_unit  TEXT;
  v_ord   RECORD;
  v_comp  RECORD;
BEGIN
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
    SELECT o.org_id, o.location_id, o.staff_id INTO v_ord
    FROM orders o WHERE o.id = NEW.order_id;

    IF NEW.menu_item_id IS NOT NULL THEN
      UPDATE menu_items
      SET stock = COALESCE(stock, 0) + NEW.qty
      WHERE id = NEW.menu_item_id AND track_inventory
      RETURNING stock, name, cost INTO v_after, v_name, v_cost;
      IF FOUND THEN
        INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, value, staff_id, order_id, order_item_id)
        VALUES (v_ord.org_id, v_ord.location_id, NEW.menu_item_id, v_name, 'void', NEW.qty, v_after,
                v_cost, movement_value(NEW.qty, v_cost, NULL), v_ord.staff_id, NEW.order_id, NEW.id);
      END IF;
    END IF;

    FOR v_comp IN
      SELECT sm.supply_item_id, -SUM(sm.qty_delta) AS return_qty
      FROM stock_movements sm
      WHERE sm.order_item_id = NEW.id AND sm.supply_item_id IS NOT NULL
        AND sm.type IN ('sale', 'split')
      GROUP BY sm.supply_item_id
      HAVING SUM(sm.qty_delta) < 0
    LOOP
      UPDATE supply_items SET stock = stock + v_comp.return_qty
      WHERE id = v_comp.supply_item_id
      RETURNING stock, name, cost, unit INTO v_after, v_name, v_cost, v_unit;
      IF FOUND THEN
        INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, value, staff_id, order_id, order_item_id)
        VALUES (v_ord.org_id, v_ord.location_id, v_comp.supply_item_id, v_name, 'void', v_comp.return_qty, v_after,
                v_cost, movement_value(v_comp.return_qty, v_cost, v_unit), v_ord.staff_id, NEW.order_id, NEW.id);
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- Правка qty (split_order): компенсация дельты (075)
CREATE OR REPLACE FUNCTION order_items_stock_qty()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
  v_cost  INTEGER;
  v_unit  TEXT;
  v_ord   RECORD;
  v_comp  RECORD;
  v_delta INTEGER;
BEGIN
  IF NEW.qty <> OLD.qty THEN
    SELECT o.org_id, o.location_id, o.staff_id INTO v_ord
    FROM orders o WHERE o.id = NEW.order_id;

    IF NEW.menu_item_id IS NOT NULL THEN
      UPDATE menu_items
      SET stock = COALESCE(stock, 0) + (OLD.qty - NEW.qty)
      WHERE id = NEW.menu_item_id AND track_inventory
      RETURNING stock, name, cost INTO v_after, v_name, v_cost;
      IF FOUND THEN
        INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, value, staff_id, order_id, order_item_id)
        VALUES (v_ord.org_id, v_ord.location_id, NEW.menu_item_id, v_name, 'split', OLD.qty - NEW.qty, v_after,
                v_cost, movement_value(OLD.qty - NEW.qty, v_cost, NULL), v_ord.staff_id, NEW.order_id, NEW.id);
      END IF;
    END IF;

    FOR v_comp IN
      SELECT sm.supply_item_id, SUM(sm.qty_delta) AS net
      FROM stock_movements sm
      WHERE sm.order_item_id = NEW.id AND sm.supply_item_id IS NOT NULL
        AND sm.type IN ('sale', 'split')
      GROUP BY sm.supply_item_id
      HAVING SUM(sm.qty_delta) < 0
    LOOP
      v_delta := ((-v_comp.net) * (OLD.qty - NEW.qty)) / OLD.qty;
      IF v_delta <> 0 THEN
        UPDATE supply_items SET stock = stock + v_delta
        WHERE id = v_comp.supply_item_id
        RETURNING stock, name, cost, unit INTO v_after, v_name, v_cost, v_unit;
        IF FOUND THEN
          INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, value, staff_id, order_id, order_item_id)
          VALUES (v_ord.org_id, v_ord.location_id, v_comp.supply_item_id, v_name, 'split', v_delta, v_after,
                  v_cost, movement_value(v_delta, v_cost, v_unit), v_ord.staff_id, NEW.order_id, NEW.id);
        END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- Void всего заказа (075)
CREATE OR REPLACE FUNCTION orders_stock_void()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
  v_cost  INTEGER;
  v_unit  TEXT;
  v_comp  RECORD;
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
      RETURNING mi.id, mi.name, mi.stock, mi.cost, agg.total_qty
    )
    INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, value, staff_id, order_id)
    SELECT NEW.org_id, NEW.location_id, upd.id, upd.name, 'void', upd.total_qty, upd.stock,
           upd.cost, movement_value(upd.total_qty, upd.cost, NULL), NEW.staff_id, NEW.id
    FROM upd;

    FOR v_comp IN
      SELECT sm.supply_item_id, -SUM(sm.qty_delta) AS return_qty
      FROM stock_movements sm
      JOIN order_items oi ON oi.id = sm.order_item_id
      WHERE oi.order_id = NEW.id AND oi.voided_at IS NULL
        AND sm.supply_item_id IS NOT NULL AND sm.type IN ('sale', 'split')
      GROUP BY sm.supply_item_id
      HAVING SUM(sm.qty_delta) < 0
    LOOP
      UPDATE supply_items SET stock = stock + v_comp.return_qty
      WHERE id = v_comp.supply_item_id
      RETURNING stock, name, cost, unit INTO v_after, v_name, v_cost, v_unit;
      IF FOUND THEN
        INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, value, staff_id, order_id)
        VALUES (NEW.org_id, NEW.location_id, v_comp.supply_item_id, v_name, 'void', v_comp.return_qty, v_after,
                v_cost, movement_value(v_comp.return_qty, v_cost, v_unit), NEW.staff_id, NEW.id);
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- Расход модификаторов (076)
CREATE OR REPLACE FUNCTION order_item_modifiers_stock_sale()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_oi    RECORD;
  v_ord   RECORD;
  v_comp  RECORD;
  v_after INTEGER;
  v_name  TEXT;
  v_cost  INTEGER;
  v_unit  TEXT;
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
    RETURNING stock, name, cost, unit INTO v_after, v_name, v_cost, v_unit;
    IF FOUND THEN
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, value, staff_id, order_id, order_item_id)
      VALUES (v_ord.org_id, v_ord.location_id, v_comp.supply_item_id, v_name, 'sale', -(v_comp.per_unit * v_oi.qty), v_after,
              v_cost, movement_value(-(v_comp.per_unit * v_oi.qty), v_cost, v_unit), v_ord.staff_id, v_oi.order_id, v_oi.id);
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

-- ── stock_take: + снапшот cost и value дельты ────────────────
-- Тело 076; расхождение инвентаризации получает денежную оценку —
-- недостача видна в шекелях, а не только в штуках/граммах.
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
  v_cost    INTEGER;
  v_unit    TEXT;
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
      SELECT stock, name, cost, unit INTO v_old, v_name, v_cost, v_unit FROM supply_items
      WHERE id = v_id AND org_id = v_org FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'supply item not found';
      END IF;
      UPDATE supply_items SET stock = v_counted WHERE id = v_id;
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, value, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'count', v_counted - COALESCE(v_old, 0), v_counted,
              v_cost, movement_value(v_counted - COALESCE(v_old, 0), v_cost, v_unit), v_note, p_staff_id, v_batch);
    ELSE
      v_id := (v_item ->> 'menu_item_id')::UUID;
      SELECT stock, name, cost INTO v_old, v_name, v_cost FROM menu_items
      WHERE id = v_id AND org_id = v_org FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'menu item not found';
      END IF;
      UPDATE menu_items SET stock = v_counted, track_inventory = TRUE WHERE id = v_id;
      INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, value, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_id, v_name, 'count', v_counted - COALESCE(v_old, 0), v_counted,
              v_cost, movement_value(v_counted - COALESCE(v_old, 0), v_cost, NULL), v_note, p_staff_id, v_batch);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('batch_id', v_batch, 'items', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION stock_take FROM anon, public;

-- ── add_waste: + value ───────────────────────────────────────
-- Тело 076; строка журнала получает денежную оценку списания.
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
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, unit_cost, value, note, staff_id, batch_id)
      VALUES (v_org, v_loc, v_si.id, v_si.name, 'waste', -v_qty, v_after,
              v_si.cost, movement_value(-v_qty, v_si.cost, v_si.unit), v_reason, p_staff_id, v_batch);
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
        INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, unit_cost, value, note, staff_id, batch_id)
        VALUES (v_org, v_loc, v_mi.id, v_mi.name, 'waste', -v_qty, v_after,
                v_mi.cost, movement_value(-v_qty, v_mi.cost, NULL), v_reason, p_staff_id, v_batch);
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN json_build_object('entries', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION add_waste FROM anon, public;
