-- ============================================================
-- 018 TABLE HEIGHT — прямоугольные столы на плане.
--
-- До этого стол квадратный (одна величина width, аспект 1:1).
-- Добавляем независимую высоту (% от ВЫСОТЫ холста), чтобы делать
-- длинные/узкие столы и барные стойки. Форма 'circle' → овал.
--
-- Существующим столам height := width (остаются квадратными визуально,
-- т.к. холст ~16:10 — квадрат в % width ≠ % height, но близко; ок для MVP).
-- ============================================================

ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS height NUMERIC(5,2) NOT NULL DEFAULT 10
    CHECK (height > 0 AND height <= 60);

-- Проставить height = width там, где ещё дефолт (первый прогон)
UPDATE tables SET height = width WHERE height = 10 AND width <> 10;

-- Старая 5-аргументная версия из 017: дропаем явно, иначе новая сигнатура
-- (с p_height) создаст перегрузку, и имя станет неоднозначным.
DROP FUNCTION IF EXISTS set_table_layout(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT);

-- Расширяем set_table_layout под height (клиент шлёт прямой UPDATE,
-- но держим RPC консистентным на случай использования).
CREATE OR REPLACE FUNCTION set_table_layout(
  p_table_id UUID,
  p_x        NUMERIC,
  p_y        NUMERIC,
  p_width    NUMERIC DEFAULT NULL,
  p_shape    TEXT    DEFAULT NULL,
  p_height   NUMERIC DEFAULT NULL
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
  IF p_height IS NOT NULL AND (p_height <= 0 OR p_height > 60) THEN
    RAISE EXCEPTION 'invalid height';
  END IF;
  IF p_shape IS NOT NULL AND p_shape NOT IN ('square', 'circle') THEN
    RAISE EXCEPTION 'invalid shape';
  END IF;

  UPDATE tables SET
    pos_x  = p_x,
    pos_y  = p_y,
    width  = COALESCE(p_width, width),
    height = COALESCE(p_height, height),
    shape  = COALESCE(p_shape, shape)
  WHERE id = p_table_id AND org_id = v_org AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table not found';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION set_table_layout(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC) FROM anon, public;
