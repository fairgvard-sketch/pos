-- ============================================================
-- 017 TABLE LAYOUT — визуальный план зала (drag-n-drop).
--
-- Позиция стола на холсте в ПРОЦЕНТАХ (0–100) от размера холста —
-- план тянется под любой экран, столы держат взаимное расположение.
-- Размер стола — доля ширины холста (%), форма — квадрат/круг.
--
-- pos_x / pos_y = NULL → стол ещё не размещён на плане (старые столы
-- или только что созданные). Клиент раскладывает их сеткой-дефолтом
-- и сохраняет позицию при первом перетаскивании.
-- ============================================================

ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS pos_x NUMERIC(5,2),   -- 0..100, % от ширины холста
  ADD COLUMN IF NOT EXISTS pos_y NUMERIC(5,2),   -- 0..100, % от высоты холста
  ADD COLUMN IF NOT EXISTS width NUMERIC(5,2) NOT NULL DEFAULT 10   -- % от ширины холста
    CHECK (width > 0 AND width <= 50),
  ADD COLUMN IF NOT EXISTS shape TEXT NOT NULL DEFAULT 'square'
    CHECK (shape IN ('square', 'circle'));

-- Сохранить раскладку стола (позиция/размер/форма) одним вызовом.
-- Только структурные поля плана; статус/занятость не трогаем.
CREATE OR REPLACE FUNCTION set_table_layout(
  p_table_id UUID,
  p_x        NUMERIC,
  p_y        NUMERIC,
  p_width    NUMERIC DEFAULT NULL,
  p_shape    TEXT    DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_x < 0 OR p_x > 100 OR p_y < 0 OR p_y > 100 THEN
    RAISE EXCEPTION 'position out of range';
  END IF;
  IF p_width IS NOT NULL AND (p_width <= 0 OR p_width > 50) THEN
    RAISE EXCEPTION 'invalid width';
  END IF;
  IF p_shape IS NOT NULL AND p_shape NOT IN ('square', 'circle') THEN
    RAISE EXCEPTION 'invalid shape';
  END IF;

  UPDATE tables SET
    pos_x = p_x,
    pos_y = p_y,
    width = COALESCE(p_width, width),
    shape = COALESCE(p_shape, shape)
  WHERE id = p_table_id AND org_id = v_org AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION set_table_layout FROM anon, public;
