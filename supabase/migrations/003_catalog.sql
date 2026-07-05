-- ============================================================
-- 003 CATALOG — станции, категории, товары, варианты (размеры),
-- модификаторы.
--
-- Принципы:
--   * Все цены — ЦЕЛЫЕ АГОРОТЫ (1₪ = 100). Никаких NUMERIC для денег.
--   * Станции маршрутизируют позиции: кофе → бариста, еда → кухня.
--   * Варианты = размеры (S/M/L) с собственной ценой. Нет вариантов —
--     товар продаётся по базовой цене.
--   * Модификатор с is_default = TRUE применяется одним тапом
--     (принцип скорости: типовой заказ ≤3 тапа).
-- ============================================================

-- ============================================================
-- STATIONS (станции приготовления: бар, кухня, пекарня)
-- ============================================================
CREATE TABLE stations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- MENU CATEGORIES
-- ============================================================
CREATE TABLE menu_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============================================================
-- MENU ITEMS
-- ============================================================
CREATE TABLE menu_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  category_id   UUID NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  station_id    UUID REFERENCES stations(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  -- Базовая цена в агоротах; если есть варианты — цена берётся из варианта
  price         INTEGER NOT NULL CHECK (price >= 0),
  image_url     TEXT,
  is_available  BOOLEAN NOT NULL DEFAULT TRUE,
  -- Открывать выбор модификаторов сразу при добавлении
  ask_modifiers BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- ITEM VARIANTS (размеры: S/M/L со своей ценой)
-- ============================================================
CREATE TABLE item_variants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  price      INTEGER NOT NULL CHECK (price >= 0),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- MODIFIER GROUPS (молоко, сиропы, температура...)
-- ============================================================
CREATE TABLE modifier_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- Сколько опций можно/нужно выбрать: 0..N; max 0 = без ограничения
  min_select INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select INTEGER NOT NULL DEFAULT 0 CHECK (max_select >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE modifiers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  group_id     UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  price_delta  INTEGER NOT NULL DEFAULT 0,  -- агороты, может быть 0
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- Привязка групп модификаторов к товарам (many-to-many)
CREATE TABLE menu_item_modifier_groups (
  item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_stations_org        ON stations(org_id);
CREATE INDEX idx_menu_cat_org        ON menu_categories(org_id);
CREATE INDEX idx_menu_items_org      ON menu_items(org_id);
CREATE INDEX idx_menu_items_cat      ON menu_items(category_id);
CREATE INDEX idx_item_variants_item  ON item_variants(item_id);
CREATE INDEX idx_mod_groups_org      ON modifier_groups(org_id);
CREATE INDEX idx_modifiers_group     ON modifiers(group_id);
CREATE INDEX idx_mimg_item           ON menu_item_modifier_groups(item_id);

-- ============================================================
-- RLS — скоуп по org из JWT
-- ============================================================
ALTER TABLE stations                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items                ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_variants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_groups           ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifiers                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_modifier_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY stations_all ON stations FOR ALL TO authenticated
  USING (org_id = auth_org_id()) WITH CHECK (org_id = auth_org_id());
CREATE POLICY menu_cat_all ON menu_categories FOR ALL TO authenticated
  USING (org_id = auth_org_id()) WITH CHECK (org_id = auth_org_id());
CREATE POLICY menu_items_all ON menu_items FOR ALL TO authenticated
  USING (org_id = auth_org_id()) WITH CHECK (org_id = auth_org_id());
CREATE POLICY item_variants_all ON item_variants FOR ALL TO authenticated
  USING (org_id = auth_org_id()) WITH CHECK (org_id = auth_org_id());
CREATE POLICY mod_groups_all ON modifier_groups FOR ALL TO authenticated
  USING (org_id = auth_org_id()) WITH CHECK (org_id = auth_org_id());
CREATE POLICY modifiers_all ON modifiers FOR ALL TO authenticated
  USING (org_id = auth_org_id()) WITH CHECK (org_id = auth_org_id());
CREATE POLICY mimg_all ON menu_item_modifier_groups FOR ALL TO authenticated
  USING (org_id = auth_org_id()) WITH CHECK (org_id = auth_org_id());

-- ============================================================
-- SEED: станции по умолчанию для существующих локаций
-- ============================================================
INSERT INTO stations (org_id, location_id, name, sort_order)
SELECT l.org_id, l.id, 'Бар', 0 FROM locations l
UNION ALL
SELECT l.org_id, l.id, 'Кухня', 1 FROM locations l;
