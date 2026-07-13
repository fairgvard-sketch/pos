-- ============================================================
-- 066 TABLE ZONES — зоны плана зала в стиле Square.
--
-- Раньше зона хранилась только текстом в tables.zone. Это не позволяло
-- создать пустую зону, упорядочить зоны или безопасно переименовать их.
-- Оставляем текстовое поле как денормализованный снимок для совместимости
-- с бронями и старыми клиентами, а источником структуры становится zone_id.
-- ============================================================

CREATE TABLE table_zones (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX table_zones_location_name_active
  ON table_zones(location_id, lower(name)) WHERE is_active;
CREATE INDEX table_zones_location_active
  ON table_zones(location_id, sort_order) WHERE is_active;
ALTER TABLE table_zones
  ADD CONSTRAINT table_zones_scope_key UNIQUE (id, org_id, location_id);

ALTER TABLE table_zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY table_zones_all ON table_zones FOR ALL TO authenticated
  USING (org_id = auth_org_id())
  WITH CHECK (org_id = auth_org_id());

ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS zone_id UUID;

ALTER TABLE tables
  ADD CONSTRAINT tables_zone_scope_fk
  FOREIGN KEY (zone_id, org_id, location_id)
  REFERENCES table_zones(id, org_id, location_id);

CREATE INDEX IF NOT EXISTS tables_zone_active
  ON tables(zone_id, sort_order) WHERE is_active;

-- Переносим уже существующие текстовые зоны без потери данных.
INSERT INTO table_zones (org_id, location_id, name, sort_order)
SELECT org_id, location_id, btrim(zone),
       (row_number() OVER (PARTITION BY location_id ORDER BY min(sort_order), btrim(zone)) - 1)::INTEGER
FROM tables
WHERE is_active AND zone IS NOT NULL AND btrim(zone) <> ''
GROUP BY org_id, location_id, btrim(zone)
ON CONFLICT DO NOTHING;

UPDATE tables AS t
SET zone_id = z.id,
    zone = z.name
FROM table_zones AS z
WHERE t.zone_id IS NULL
  AND z.org_id = t.org_id
  AND z.location_id = t.location_id
  AND z.is_active
  AND lower(z.name) = lower(btrim(t.zone));

-- Столы без зоны помещаем в основной «Зал», чтобы после миграции план
-- сразу был пригоден для работы и ни один стол не исчез из конструктора.
INSERT INTO table_zones (org_id, location_id, name, sort_order)
SELECT DISTINCT t.org_id, t.location_id, 'Зал', 0
FROM tables t
WHERE t.is_active AND t.zone_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM table_zones z
    WHERE z.location_id = t.location_id AND z.is_active AND lower(z.name) = lower('Зал')
  )
ON CONFLICT DO NOTHING;

UPDATE tables AS t
SET zone_id = z.id,
    zone = z.name
FROM table_zones AS z
WHERE t.zone_id IS NULL
  AND z.org_id = t.org_id
  AND z.location_id = t.location_id
  AND z.is_active
  AND lower(z.name) = lower('Зал');

-- Создание зоны и набора столов — одна транзакция. Повтор с тем же UUID
-- идемпотентно возвращает уже созданную зону и не дублирует столы.
CREATE OR REPLACE FUNCTION create_table_zone_with_tables(
  p_zone_id          UUID,
  p_name             TEXT,
  p_sort_order       INTEGER,
  p_table_count      INTEGER,
  p_table_prefix     TEXT,
  p_table_sort_order INTEGER
) RETURNS table_zones
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org  UUID := auth_org_id();
  v_loc  UUID := auth_location_id();
  v_zone table_zones%ROWTYPE;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF length(btrim(p_name)) = 0 THEN RAISE EXCEPTION 'zone name required'; END IF;
  IF p_table_count < 1 OR p_table_count > 50 THEN RAISE EXCEPTION 'invalid table count'; END IF;

  SELECT * INTO v_zone FROM table_zones
  WHERE id = p_zone_id AND org_id = v_org AND location_id = v_loc;
  IF FOUND THEN RETURN v_zone; END IF;

  INSERT INTO table_zones (id, org_id, location_id, name, sort_order)
  VALUES (p_zone_id, v_org, v_loc, btrim(p_name), p_sort_order)
  RETURNING * INTO v_zone;

  INSERT INTO tables (org_id, location_id, label, zone, zone_id, sort_order, seats, combinable)
  SELECT v_org, v_loc, coalesce(btrim(p_table_prefix), '') || n::TEXT,
         v_zone.name, v_zone.id, p_table_sort_order + n - 1, 2, FALSE
  FROM generate_series(1, p_table_count) AS n;

  RETURN v_zone;
END $$;

CREATE OR REPLACE FUNCTION rename_table_zone(p_zone_id UUID, p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
  v_name TEXT := btrim(p_name);
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF length(v_name) = 0 THEN RAISE EXCEPTION 'zone name required'; END IF;

  UPDATE table_zones SET name = v_name
  WHERE id = p_zone_id AND org_id = v_org AND location_id = v_loc AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'zone not found'; END IF;

  UPDATE tables SET zone = v_name
  WHERE zone_id = p_zone_id AND org_id = v_org AND location_id = v_loc AND is_active;
END $$;

CREATE OR REPLACE FUNCTION delete_table_zone(p_zone_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  UPDATE tables SET zone_id = NULL, zone = NULL
  WHERE zone_id = p_zone_id AND org_id = v_org AND location_id = v_loc AND is_active;

  UPDATE table_zones SET is_active = FALSE
  WHERE id = p_zone_id AND org_id = v_org AND location_id = v_loc AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'zone not found'; END IF;
END $$;

REVOKE EXECUTE ON FUNCTION create_table_zone_with_tables(UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER) FROM anon, public;
REVOKE EXECUTE ON FUNCTION rename_table_zone(UUID, TEXT) FROM anon, public;
REVOKE EXECUTE ON FUNCTION delete_table_zone(UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION create_table_zone_with_tables(UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION rename_table_zone(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_table_zone(UUID) TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE table_zones;
