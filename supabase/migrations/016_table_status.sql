-- ============================================================
-- 016 TABLE STATUS — ручной статус стола (резерв / недоступность).
--
-- Занятость (есть open-заказ) вычисляется динамически и в БД не хранится —
-- это отдельная ось. Здесь только РУЧНОЙ статус, который персонал ставит
-- сам: свободен / зарезервирован / недоступен.
--
-- Цветовая схема рамки в зале (приоритет сверху вниз):
--   занят (open-заказ) → красный   (динамика, не тут)
--   reserved           → синий
--   disabled           → серый (некликабелен)
--   free               → зелёный
-- ============================================================

ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'free'
    CHECK (status IN ('free', 'reserved', 'disabled'));

-- Сменить ручной статус стола. Занятость (open-заказ) не трогаем — это
-- ортогональная ось; занятый стол всё равно рисуется красным поверх status.
CREATE OR REPLACE FUNCTION set_table_status(p_table_id UUID, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_status NOT IN ('free', 'reserved', 'disabled') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;

  UPDATE tables SET status = p_status
  WHERE id = p_table_id AND org_id = v_org AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION set_table_status FROM anon, public;
