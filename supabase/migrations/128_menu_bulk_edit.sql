-- ============================================================
-- 128. Массовые правки каталога из кабинета
--
-- Владелец, поднимающий цены на 5% или снимающий с продажи десяток
-- позиций, делал это по одной карточке. Через save_menu_item (092) так
-- нельзя вообще: она ПЕРЕСОЗДАЁТ варианты и связки модификаторов, то
-- есть «поменять доступность десяти товаров» переписало бы им состав.
--
-- Отсюда узкая функция с белым списком полей и одной транзакцией: либо
-- изменились все выбранные позиции, либо ни одна. Половина применённой
-- переоценки хуже, чем непринятая.
--
-- ⚠️ ТРЕБУЕТ 092 (require_backoffice_or_staff).
-- ============================================================

/**
 * Массовая правка выбранных позиций.
 *
 * `p_action`:
 *   'availability' — снять с продажи / вернуть (p_available);
 *   'category'     — перенести в категорию (p_category_id);
 *   'price'        — изменить цену: процентом (p_percent) или
 *                    фиксированной суммой в агоротах (p_delta).
 *
 * Цена меняется И у вариантов: у товара с размерами цена берётся из
 * варианта, и переоценка только базовой цены не изменила бы ничего в
 * чеке — владелец решил бы, что поднял цены, а касса продавала бы по
 * старым.
 *
 * Деньги — целые агороты (инвариант кассы): процент округляется до
 * агоры, ниже нуля цена не опускается.
 */
CREATE OR REPLACE FUNCTION bulk_update_menu_items(
  p_ids            JSONB,
  p_action         TEXT,
  p_available      BOOLEAN DEFAULT NULL,
  p_category_id    UUID    DEFAULT NULL,
  p_percent        NUMERIC DEFAULT NULL,
  p_delta          INTEGER DEFAULT NULL,
  p_staff_session  UUID    DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_ids   UUID[];
  v_count INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

  SELECT ARRAY(SELECT (jsonb_array_elements_text(COALESCE(p_ids, '[]'::jsonb)))::UUID)
  INTO v_ids;
  IF array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no_items';
  END IF;
  IF array_length(v_ids, 1) > 500 THEN
    RAISE EXCEPTION 'too_many';
  END IF;

  -- Чужие позиции не трогаем и молча не пропускаем: расхождение числа
  -- выбранного и изменённого владелец заметить не сможет.
  SELECT count(*)::INTEGER INTO v_count
  FROM menu_items WHERE id = ANY(v_ids) AND org_id = v_org;
  IF v_count <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'foreign_items';
  END IF;

  IF p_action = 'availability' THEN
    IF p_available IS NULL THEN
      RAISE EXCEPTION 'availability_required';
    END IF;
    UPDATE menu_items SET is_available = p_available
    WHERE id = ANY(v_ids) AND org_id = v_org;

  ELSIF p_action = 'category' THEN
    IF p_category_id IS NULL THEN
      RAISE EXCEPTION 'category_required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM menu_categories WHERE id = p_category_id AND org_id = v_org
    ) THEN
      RAISE EXCEPTION 'invalid_category';
    END IF;
    UPDATE menu_items SET category_id = p_category_id
    WHERE id = ANY(v_ids) AND org_id = v_org;

  ELSIF p_action = 'price' THEN
    IF (p_percent IS NULL) = (p_delta IS NULL) THEN
      RAISE EXCEPTION 'price_change_required';
    END IF;
    IF p_percent IS NOT NULL AND (p_percent < -90 OR p_percent > 500) THEN
      RAISE EXCEPTION 'invalid_percent';
    END IF;

    UPDATE menu_items SET price = GREATEST(0, CASE
      WHEN p_percent IS NOT NULL THEN ROUND(price * (1 + p_percent / 100.0))::INTEGER
      ELSE price + p_delta END)
    WHERE id = ANY(v_ids) AND org_id = v_org;

    -- Варианты: цена в чеке берётся отсюда, значит и переоценка здесь
    UPDATE item_variants SET price = GREATEST(0, CASE
      WHEN p_percent IS NOT NULL THEN ROUND(price * (1 + p_percent / 100.0))::INTEGER
      ELSE price + p_delta END)
    WHERE item_id = ANY(v_ids) AND org_id = v_org;

  ELSE
    RAISE EXCEPTION 'unknown_action';
  END IF;

  RETURN json_build_object('action', p_action, 'items', v_count);
END $$;

REVOKE EXECUTE ON FUNCTION bulk_update_menu_items(JSONB, TEXT, BOOLEAN, UUID, NUMERIC, INTEGER, UUID)
  FROM anon, public;
GRANT EXECUTE ON FUNCTION bulk_update_menu_items(JSONB, TEXT, BOOLEAN, UUID, NUMERIC, INTEGER, UUID)
  TO authenticated;

COMMENT ON FUNCTION bulk_update_menu_items(JSONB, TEXT, BOOLEAN, UUID, NUMERIC, INTEGER, UUID) IS
  'Массовая правка каталога (128): доступность, категория, цена. Белый список полей — save_menu_item для этого не годится, она пересоздаёт варианты и модификаторы. Одна транзакция: половина применённой переоценки хуже непринятой.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only, схему не меняет — только функция. Функциональный откат:
-- отозвать EXECUTE у `authenticated`, кабинет вернётся к правке по
-- одной карточке (save_menu_item не затрагивается).
--
-- ПРОВЕРКА: под веб-владельцем
--   SELECT bulk_update_menu_items('["<id>"]'::jsonb, 'availability', FALSE);
--   SELECT bulk_update_menu_items('["<id>"]'::jsonb, 'price', NULL, NULL, 5);
-- ============================================================
