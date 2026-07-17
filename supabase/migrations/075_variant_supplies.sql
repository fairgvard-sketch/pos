-- ============================================================
-- 075 VARIANT SUPPLIES — упаковка: авто-списание расходников продажей.
--
-- Большой капучино с собой тратит большой стакан и большую крышку,
-- маленький — маленькие. Связка «товар/вариант → расходник» задаётся
-- в редакторе товара (variant_supplies), само списание происходит в
-- существующих складских триггерах 047/055/056 на сервере — горячий
-- поток, offline-replay и онлайн-заказы получают его бесплатно,
-- клиентских изменений в продаже нет.
--
--   * variant_supplies: menu_item + (variant | NULL=весь товар) →
--     supply_item, qty за единицу, takeaway_only (по умолчанию TRUE —
--     списывать только для order_type IN ('takeaway','delivery')).
--   * Продажа (INSERT order_items) списывает qty×кол-во по подходящим
--     связкам и пишет строки 'sale' в stock_movements.
--   * Компенсации (void позиции/заказа, split) возвращают РОВНО то,
--     что было списано, по журналу: в stock_movements добавлен
--     order_item_id. Это принципиально: save_menu_item пересоздаёт
--     варианты (variant_id меняются при каждом сохранении товара),
--     поэтому live-каталог на момент void может уже не знать, что
--     списывалось при продаже. Журнал — знает.
--   * orders_stock_void ищет строки журнала через JOIN order_items
--     по текущему order_id: merge/split переносят позиции UPDATE'ом
--     order_id, и упаковка должна ходить за позицией, а не за заказом.
--   * Деактивированный расходник (is_active = FALSE) продажей не
--     списывается; возврат по журналу — всегда (баланс журнала).
--   * Остаток расходника может уйти в минус — как и везде на складе,
--     это честный сигнал о неточном учёте, не ошибка.
--   * save_menu_item получает p_supplies (полная пересинхронизация).
--     NULL = старый клиент, упаковку не трогаем; variant-связки при
--     этом переносятся на пересозданные варианты по имени.
--
-- Доступ (правило 071): новые объекты выдают явные GRANT сами.
-- ============================================================

-- ── Таблица связок «вариант → расходник» ─────────────────────
CREATE TABLE variant_supplies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  menu_item_id   UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  -- NULL = любой вариант товара (и товар без вариантов)
  variant_id     UUID REFERENCES item_variants(id) ON DELETE CASCADE,
  supply_item_id UUID NOT NULL REFERENCES supply_items(id) ON DELETE CASCADE,
  -- За единицу товара, в базовых единицах расходника (шт/г/мл, см. 076):
  -- стакан 1 шт, молоко 180 мл, зерно 18 г
  qty            INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 99999),
  -- TRUE: списывать только takeaway/delivery; FALSE: при любой продаже
  takeaway_only  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_variant_supplies_item ON variant_supplies(menu_item_id);

-- Дубль связки = двойное списание; NULL variant_id требует второго
-- частичного индекса (UNIQUE NULLS NOT DISTINCT недоступен на PG15)
CREATE UNIQUE INDEX uq_variant_supplies_variant
  ON variant_supplies(variant_id, supply_item_id) WHERE variant_id IS NOT NULL;
CREATE UNIQUE INDEX uq_variant_supplies_item_level
  ON variant_supplies(menu_item_id, supply_item_id) WHERE variant_id IS NULL;

ALTER TABLE variant_supplies ENABLE ROW LEVEL SECURITY;

-- Чтение — своя org (редактор товара); запись только через save_menu_item
CREATE POLICY variant_supplies_select ON variant_supplies
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

GRANT SELECT ON variant_supplies TO authenticated;
GRANT ALL ON variant_supplies TO service_role;

-- ── Журнал: ссылка на строку заказа ──────────────────────────
-- Позволяет компенсировать списание точно по факту продажи, а не по
-- текущему каталогу. Заполняется триггерами sale/void/split.
ALTER TABLE stock_movements
  ADD COLUMN order_item_id UUID REFERENCES order_items(id) ON DELETE SET NULL;

CREATE INDEX idx_stock_movements_order_item ON stock_movements(order_item_id)
  WHERE order_item_id IS NOT NULL;

-- ── Продажа: −товар (055) + −упаковка (075) ──────────────────
CREATE OR REPLACE FUNCTION order_items_stock_sale()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
  v_ord   RECORD;
  v_comp  RECORD;
BEGIN
  IF NEW.menu_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT o.org_id, o.location_id, o.staff_id, o.order_type INTO v_ord
  FROM orders o WHERE o.id = NEW.order_id;

  -- Товар: −qty, авто-стоп при нуле (как 055)
  UPDATE menu_items
  SET stock = COALESCE(stock, 0) - NEW.qty,
      is_available = CASE WHEN COALESCE(stock, 0) - NEW.qty <= 0 THEN FALSE ELSE is_available END
  WHERE id = NEW.menu_item_id AND track_inventory
  RETURNING stock, name INTO v_after, v_name;
  IF FOUND THEN
    INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, staff_id, order_id, order_item_id)
    VALUES (v_ord.org_id, v_ord.location_id, NEW.menu_item_id, v_name, 'sale', -NEW.qty, v_after, v_ord.staff_id, NEW.order_id, NEW.id);
  END IF;

  -- Упаковка: расходники варианта (и общие для товара)
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
    RETURNING stock, name INTO v_after, v_name;
    IF FOUND THEN
      INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, staff_id, order_id, order_item_id)
      VALUES (v_ord.org_id, v_ord.location_id, v_comp.supply_item_id, v_name, 'sale', -(v_comp.per_unit * NEW.qty), v_after, v_ord.staff_id, NEW.order_id, NEW.id);
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

-- ── Void позиции: +товар (055) + возврат упаковки по журналу ─
CREATE OR REPLACE FUNCTION order_items_stock_void()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
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
      RETURNING stock, name INTO v_after, v_name;
      IF FOUND THEN
        INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, staff_id, order_id, order_item_id)
        VALUES (v_ord.org_id, v_ord.location_id, NEW.menu_item_id, v_name, 'void', NEW.qty, v_after, v_ord.staff_id, NEW.order_id, NEW.id);
      END IF;
    END IF;

    -- Упаковка: вернуть ровно списанное по этой строке (журнал, не каталог)
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
      RETURNING stock, name INTO v_after, v_name;
      IF FOUND THEN
        INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, staff_id, order_id, order_item_id)
        VALUES (v_ord.org_id, v_ord.location_id, v_comp.supply_item_id, v_name, 'void', v_comp.return_qty, v_after, v_ord.staff_id, NEW.order_id, NEW.id);
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- ── Правка qty (split_order): компенсация дельты ─────────────
-- Упаковка: net по журналу этой строки = −(за единицу × текущий qty),
-- поэтому дельта = net/OLD.qty × (OLD.qty − NEW.qty) — целочисленно
-- точно и не зависит от изменений каталога после продажи.
CREATE OR REPLACE FUNCTION order_items_stock_qty()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
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
      RETURNING stock, name INTO v_after, v_name;
      IF FOUND THEN
        INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, staff_id, order_id, order_item_id)
        VALUES (v_ord.org_id, v_ord.location_id, NEW.menu_item_id, v_name, 'split', OLD.qty - NEW.qty, v_after, v_ord.staff_id, NEW.order_id, NEW.id);
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
        RETURNING stock, name INTO v_after, v_name;
        IF FOUND THEN
          INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, staff_id, order_id, order_item_id)
          VALUES (v_ord.org_id, v_ord.location_id, v_comp.supply_item_id, v_name, 'split', v_delta, v_after, v_ord.staff_id, NEW.order_id, NEW.id);
        END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- ── Void всего заказа: +товары (055) + возврат упаковки ──────
-- Упаковка ищется JOIN'ом order_items по ТЕКУЩЕМУ order_id (позиции
-- переезжают между заказами при merge/split); индивидуально void-нутые
-- строки уже вернули своё триггером выше и исключаются по voided_at.
CREATE OR REPLACE FUNCTION orders_stock_void()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_after INTEGER;
  v_name  TEXT;
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
      RETURNING mi.id, mi.name, mi.stock, agg.total_qty
    )
    INSERT INTO stock_movements (org_id, location_id, menu_item_id, name, type, qty_delta, stock_after, staff_id, order_id)
    SELECT NEW.org_id, NEW.location_id, upd.id, upd.name, 'void', upd.total_qty, upd.stock, NEW.staff_id, NEW.id
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
      RETURNING stock, name INTO v_after, v_name;
      IF FOUND THEN
        INSERT INTO stock_movements (org_id, location_id, supply_item_id, name, type, qty_delta, stock_after, staff_id, order_id)
        VALUES (NEW.org_id, NEW.location_id, v_comp.supply_item_id, v_name, 'void', v_comp.return_qty, v_after, NEW.staff_id, NEW.id);
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- ── save_menu_item: + p_supplies (упаковка) ──────────────────
-- Новый параметр меняет сигнатуру → DROP старой (иначе появился бы
-- второй overload и ambiguity в PostgREST) и re-GRANT.
-- p_supplies: [{ variant_index?, supply_item_id, qty?, takeaway_only? }]
--   * variant_index — позиция в p_variants (id вариантов пересоздаются,
--     клиент их не знает); NULL = связка на весь товар.
--   * NULL (параметр целиком) = клиент без поддержки упаковки: связки
--     не трогаем, variant-скоуп переносим на новые варианты по имени.
DROP FUNCTION IF EXISTS save_menu_item(JSONB, JSONB, JSONB, UUID, UUID);

CREATE FUNCTION save_menu_item(
  p_item JSONB,
  p_variants JSONB DEFAULT '[]'::jsonb,
  p_group_ids JSONB DEFAULT '[]'::jsonb,
  p_item_id UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL,
  p_supplies JSONB DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org     UUID := auth_org_id();
  v_id      UUID := p_item_id;
  v_v       JSONB;
  v_g       TEXT;
  v_i       INTEGER := 0;
  v_keep    JSONB := '[]'::jsonb;
  v_vidx    INTEGER;
  v_variant UUID;
  v_supply  UUID;
  v_qty     INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'manage');

  -- Упаковку не прислали → снапшот variant-связок ПО ИМЕНИ варианта:
  -- пересоздание вариантов ниже каскадом удалит их строки
  IF p_supplies IS NULL AND v_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'variant_name',   iv.name,
      'supply_item_id', vs.supply_item_id,
      'qty',            vs.qty,
      'takeaway_only',  vs.takeaway_only
    )), '[]'::jsonb) INTO v_keep
    FROM variant_supplies vs
    JOIN item_variants iv ON iv.id = vs.variant_id
    WHERE vs.menu_item_id = v_id;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO menu_items (
      org_id, category_id, station_id, name, description, price, image_url,
      is_available, is_favorite, ask_modifiers, cost, sku, track_inventory, stock
    ) VALUES (
      v_org,
      (p_item ->> 'category_id')::UUID,
      NULLIF(p_item ->> 'station_id', '')::UUID,
      p_item ->> 'name',
      p_item ->> 'description',
      (p_item ->> 'price')::INTEGER,
      p_item ->> 'image_url',
      COALESCE((p_item ->> 'is_available')::BOOLEAN, TRUE),
      COALESCE((p_item ->> 'is_favorite')::BOOLEAN, FALSE),
      COALESCE((p_item ->> 'ask_modifiers')::BOOLEAN, FALSE),
      NULLIF(p_item ->> 'cost', '')::INTEGER,
      NULLIF(p_item ->> 'sku', ''),
      COALESCE((p_item ->> 'track_inventory')::BOOLEAN, FALSE),
      NULLIF(p_item ->> 'stock', '')::INTEGER
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE menu_items SET
      category_id     = (p_item ->> 'category_id')::UUID,
      station_id      = NULLIF(p_item ->> 'station_id', '')::UUID,
      name            = p_item ->> 'name',
      description     = p_item ->> 'description',
      price           = (p_item ->> 'price')::INTEGER,
      image_url       = p_item ->> 'image_url',
      is_available    = COALESCE((p_item ->> 'is_available')::BOOLEAN, is_available),
      is_favorite     = COALESCE((p_item ->> 'is_favorite')::BOOLEAN, is_favorite),
      ask_modifiers   = COALESCE((p_item ->> 'ask_modifiers')::BOOLEAN, ask_modifiers),
      cost            = NULLIF(p_item ->> 'cost', '')::INTEGER,
      sku             = NULLIF(p_item ->> 'sku', ''),
      track_inventory = COALESCE((p_item ->> 'track_inventory')::BOOLEAN, track_inventory),
      stock           = NULLIF(p_item ->> 'stock', '')::INTEGER
    WHERE id = v_id AND org_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'item not found';
    END IF;
  END IF;

  -- Варианты: полная пересинхронизация (каталог — не финансовые данные)
  DELETE FROM item_variants WHERE item_id = v_id;
  v_i := 0;
  FOR v_v IN SELECT * FROM jsonb_array_elements(p_variants) LOOP
    INSERT INTO item_variants (org_id, item_id, name, price, is_default, sort_order)
    VALUES (
      v_org, v_id, v_v ->> 'name', (v_v ->> 'price')::INTEGER,
      COALESCE((v_v ->> 'is_default')::BOOLEAN, FALSE), v_i
    );
    v_i := v_i + 1;
  END LOOP;

  -- Привязки групп модификаторов
  DELETE FROM menu_item_modifier_groups WHERE item_id = v_id;
  v_i := 0;
  FOR v_g IN SELECT jsonb_array_elements_text(p_group_ids) LOOP
    INSERT INTO menu_item_modifier_groups (item_id, group_id, org_id, sort_order)
    VALUES (v_id, v_g::UUID, v_org, v_i);
    v_i := v_i + 1;
  END LOOP;

  -- Упаковка (075)
  IF p_supplies IS NULL THEN
    -- вернуть variant-связки на пересозданные варианты по имени;
    -- item-level связки каскад не трогал, они на месте
    INSERT INTO variant_supplies (org_id, menu_item_id, variant_id, supply_item_id, qty, takeaway_only)
    SELECT v_org, v_id, iv.id,
           (k ->> 'supply_item_id')::UUID,
           (k ->> 'qty')::INTEGER,
           (k ->> 'takeaway_only')::BOOLEAN
    FROM jsonb_array_elements(v_keep) k
    JOIN item_variants iv ON iv.item_id = v_id AND iv.name = (k ->> 'variant_name')
    ON CONFLICT DO NOTHING;
  ELSE
    IF jsonb_array_length(p_supplies) > 50 THEN
      RAISE EXCEPTION 'too many supplies';
    END IF;
    DELETE FROM variant_supplies WHERE menu_item_id = v_id;
    FOR v_v IN SELECT * FROM jsonb_array_elements(p_supplies) LOOP
      v_supply := (v_v ->> 'supply_item_id')::UUID;
      v_qty    := COALESCE((v_v ->> 'qty')::INTEGER, 1);
      v_vidx   := (v_v ->> 'variant_index')::INTEGER;
      IF v_qty < 1 OR v_qty > 99999 THEN
        RAISE EXCEPTION 'invalid supply qty';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM supply_items si WHERE si.id = v_supply AND si.org_id = v_org) THEN
        RAISE EXCEPTION 'supply item not found';
      END IF;
      v_variant := NULL;
      IF v_vidx IS NOT NULL THEN
        SELECT iv.id INTO v_variant FROM item_variants iv
        WHERE iv.item_id = v_id AND iv.sort_order = v_vidx;
        IF v_variant IS NULL THEN
          RAISE EXCEPTION 'invalid variant index';
        END IF;
      END IF;
      INSERT INTO variant_supplies (org_id, menu_item_id, variant_id, supply_item_id, qty, takeaway_only)
      VALUES (v_org, v_id, v_variant, v_supply, v_qty, COALESCE((v_v ->> 'takeaway_only')::BOOLEAN, TRUE))
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  RETURN v_id;
END $$;

REVOKE EXECUTE ON FUNCTION save_menu_item FROM anon, public;
GRANT EXECUTE ON FUNCTION save_menu_item(JSONB, JSONB, JSONB, UUID, UUID, JSONB)
  TO authenticated, service_role;
