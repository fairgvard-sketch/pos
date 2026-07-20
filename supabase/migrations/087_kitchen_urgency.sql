-- ============================================================
-- 087 KITCHEN URGENCY — срочность заказа и порядок станций.
--
-- 1. orders.is_urgent: срочный заказ всплывает наверх очереди бариста
--    и подсвечивается. Флаг переключается с карточки очереди (кассир или
--    бариста), не финансовый — компенсаций/аудита не требует.
-- 2. set_order_urgent(): идемпотентный toggle. Мягкий режим staff-сессий
--    горячего потока (086): p_staff_session валидируется, NULL пропускается.
--    Заказ вне очереди (fulfilled/voided) или чужой org → тихий no-op:
--    offline-replay не должен падать из-за уже закрытого заказа.
-- 3. reorder_menu(): + p_kind='station'. Порядок станций (stations.sort_order,
--    колонка с 003) задаёт очередность позиций для кухни: чипы на экране
--    бариста и строки внутри карточки сортируются по порядку станций.
-- ============================================================

ALTER TABLE orders ADD COLUMN is_urgent BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION set_order_urgent(
  p_order_id      UUID,
  p_urgent        BOOLEAN DEFAULT TRUE,
  p_staff_session UUID    DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_session(p_staff_session);

  -- Только заказы, живущие в очереди готовки; остальное — no-op (replay-safe)
  UPDATE orders
  SET is_urgent = p_urgent
  WHERE id = p_order_id
    AND org_id = v_org
    AND status IN ('open', 'paid');
END $$;

REVOKE EXECUTE ON FUNCTION set_order_urgent(UUID, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_order_urgent(UUID, BOOLEAN, UUID) TO authenticated;

COMMENT ON FUNCTION set_order_urgent(UUID, BOOLEAN, UUID) IS
  'Срочность заказа в очереди бариста (087): идемпотентный флаг, no-op вне статусов open/paid.';

-- ── reorder_menu: + станции ─────────────────────────────────
-- CREATE OR REPLACE сохраняет ACL 064/070: EXECUTE только authenticated.
CREATE OR REPLACE FUNCTION reorder_menu(
  p_kind TEXT,
  p_ids JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'manage');

  IF p_kind NOT IN ('category', 'item', 'station') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind;
  END IF;

  IF p_kind = 'category' THEN
    UPDATE menu_categories c
    SET sort_order = o.ord
    FROM (SELECT value::UUID AS id, (ordinality - 1) AS ord
          FROM jsonb_array_elements_text(p_ids) WITH ORDINALITY) o
    WHERE c.id = o.id AND c.org_id = v_org;
  ELSIF p_kind = 'item' THEN
    UPDATE menu_items m
    SET sort_order = o.ord
    FROM (SELECT value::UUID AS id, (ordinality - 1) AS ord
          FROM jsonb_array_elements_text(p_ids) WITH ORDINALITY) o
    WHERE m.id = o.id AND m.org_id = v_org;
  ELSE
    UPDATE stations s
    SET sort_order = o.ord
    FROM (SELECT value::UUID AS id, (ordinality - 1) AS ord
          FROM jsonb_array_elements_text(p_ids) WITH ORDINALITY) o
    WHERE s.id = o.id AND s.org_id = v_org;
  END IF;
END $$;
