-- ============================================================
-- 067 TABLE ZONE ORDER — drag-and-drop порядок зон.
-- Один атомарный RPC обновляет всю последовательность выбранной точки.
-- ============================================================

CREATE OR REPLACE FUNCTION reorder_table_zones(p_zone_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
  v_updated INTEGER;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_zone_ids IS NULL OR cardinality(p_zone_ids) = 0 THEN RAISE EXCEPTION 'zones required'; END IF;
  IF (SELECT count(*) FROM table_zones
      WHERE org_id = v_org AND location_id = v_loc AND is_active) <> cardinality(p_zone_ids)
  THEN RAISE EXCEPTION 'all active zones required'; END IF;

  UPDATE table_zones AS zone
  SET sort_order = ordered.position - 1
  FROM unnest(p_zone_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE zone.id = ordered.id
    AND zone.org_id = v_org
    AND zone.location_id = v_loc
    AND zone.is_active;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> cardinality(p_zone_ids) THEN RAISE EXCEPTION 'invalid zone order'; END IF;
END $$;

REVOKE EXECUTE ON FUNCTION reorder_table_zones(UUID[]) FROM anon, public;
GRANT EXECUTE ON FUNCTION reorder_table_zones(UUID[]) TO authenticated;
