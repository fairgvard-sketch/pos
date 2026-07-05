-- ============================================================
-- MODIFIERS: группы и варианты модификаторов для блюд
-- ============================================================

-- Группа модификаторов (напр. "Степень прожарки", "Добавки", "Убрать")
CREATE TABLE modifier_groups (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  required    BOOLEAN NOT NULL DEFAULT FALSE,
  multi       BOOLEAN NOT NULL DEFAULT TRUE
);

-- Конкретный модификатор (напр. "Без лука", "Extra соус")
CREATE TABLE modifiers (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id   UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  price_delta NUMERIC(10,2) NOT NULL DEFAULT 0
);

-- Связь: какие группы модификаторов доступны для какого блюда
CREATE TABLE menu_item_modifier_groups (
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id     UUID NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (menu_item_id, group_id)
);

-- Выбранные модификаторы для позиции заказа
CREATE TABLE order_item_modifiers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id   UUID NOT NULL REFERENCES modifiers(id)
);

-- RLS
ALTER TABLE modifier_groups             ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifiers                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_modifier_groups   ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_modifiers        ENABLE ROW LEVEL SECURITY;

CREATE POLICY "modifier_groups_read"  ON modifier_groups FOR SELECT USING (TRUE);
CREATE POLICY "modifier_groups_write" ON modifier_groups FOR ALL USING (current_staff_role() = 'manager');

CREATE POLICY "modifiers_read"  ON modifiers FOR SELECT USING (TRUE);
CREATE POLICY "modifiers_write" ON modifiers FOR ALL USING (current_staff_role() = 'manager');

CREATE POLICY "mimgs_read"  ON menu_item_modifier_groups FOR SELECT USING (TRUE);
CREATE POLICY "mimgs_write" ON menu_item_modifier_groups FOR ALL USING (current_staff_role() = 'manager');

CREATE POLICY "oim_read"  ON order_item_modifiers FOR SELECT USING (TRUE);
CREATE POLICY "oim_write" ON order_item_modifiers FOR ALL USING (TRUE);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE order_item_modifiers;

-- ============================================================
-- SEED: базовые группы модификаторов
-- ============================================================
INSERT INTO modifier_groups (id, name, required, multi) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Убрать ингредиент', FALSE, TRUE),
  ('00000000-0000-0000-0000-000000000002', 'Добавки',           FALSE, TRUE),
  ('00000000-0000-0000-0000-000000000003', 'Степень прожарки',  TRUE,  FALSE),
  ('00000000-0000-0000-0000-000000000004', 'Острота',           FALSE, FALSE);

INSERT INTO modifiers (group_id, name, price_delta) VALUES
  -- Убрать
  ('00000000-0000-0000-0000-000000000001', 'Без лука',       0),
  ('00000000-0000-0000-0000-000000000001', 'Без чеснока',    0),
  ('00000000-0000-0000-0000-000000000001', 'Без глютена',    0),
  ('00000000-0000-0000-0000-000000000001', 'Без лактозы',    0),
  ('00000000-0000-0000-0000-000000000001', 'Без соуса',      0),
  -- Добавки
  ('00000000-0000-0000-0000-000000000002', 'Extra соус',     15),
  ('00000000-0000-0000-0000-000000000002', 'Extra сыр',      25),
  ('00000000-0000-0000-0000-000000000002', 'Двойная порция', 50),
  -- Прожарка
  ('00000000-0000-0000-0000-000000000003', 'Rare',           0),
  ('00000000-0000-0000-0000-000000000003', 'Medium Rare',    0),
  ('00000000-0000-0000-0000-000000000003', 'Medium',         0),
  ('00000000-0000-0000-0000-000000000003', 'Well Done',      0),
  -- Острота
  ('00000000-0000-0000-0000-000000000004', 'Не острое',      0),
  ('00000000-0000-0000-0000-000000000004', 'Средне острое',  0),
  ('00000000-0000-0000-0000-000000000004', 'Очень острое',   0);
