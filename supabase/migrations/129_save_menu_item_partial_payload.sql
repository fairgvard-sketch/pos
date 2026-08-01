-- ============================================================
-- 129. save_menu_item не стирает поля, которых нет в payload
--
-- Найдено приёмкой каталога: артикула не видно ни в строке, ни в
-- редакторе. Причина глубже отсутствующего поля — на UPDATE функция
-- писала `sku = NULLIF(p_item ->> 'sku','')` напрямую, а веб-кабинет
-- эти ключи никогда не слал. Значит КАЖДАЯ правка позиции из кабинета
-- молча обнуляла артикул, себестоимость и остаток; форма кассы их
-- присылала, поэтому там всё выглядело нормально.
--
-- Частичный payload не имеет права стирать колонки, о которых он
-- ничего не говорит. `is_available` и остальные булевы так и работали
-- (COALESCE) — приводим к тому же поведению cost, sku и stock.
--
-- Уже потерянные значения восстановить неоткуда: старых копий этих
-- колонок нет. Владельцу придётся проставить артикулы заново.
--
-- ⚠️ ТРЕБУЕТ 092.
-- ============================================================

CREATE OR REPLACE FUNCTION save_menu_item(
  p_item JSONB,
  p_variants JSONB DEFAULT '[]'::jsonb,
  p_group_ids JSONB DEFAULT '[]'::jsonb,
  p_item_id UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL,
  p_supplies JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  PERFORM require_backoffice_or_staff(p_staff_session, 'manage');

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
      -- Ключа нет в payload — поле НЕ трогаем. Прежняя запись напрямую
      -- обнуляла артикул, себестоимость и остаток при каждом сохранении
      -- из кабинета: он эти поля не присылал, а форма кассы присылала.
      cost            = CASE WHEN p_item ? 'cost'
                             THEN NULLIF(p_item ->> 'cost', '')::INTEGER ELSE cost END,
      sku             = CASE WHEN p_item ? 'sku'
                             THEN NULLIF(p_item ->> 'sku', '') ELSE sku END,
      track_inventory = COALESCE((p_item ->> 'track_inventory')::BOOLEAN, track_inventory),
      stock           = CASE WHEN p_item ? 'stock'
                             THEN NULLIF(p_item ->> 'stock', '')::INTEGER ELSE stock END
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

-- Гранты и REVOKE не меняются: сигнатура прежняя, CREATE OR REPLACE
-- сохраняет права (092/075).

-- ============================================================
-- ОТКАТ
--
-- Forward-only, схему не меняет. Функциональный откат — вернуть тело из
-- 092, но тогда вернётся и обнуление полей.
--
-- ПРОВЕРКА: сохранить товар из кабинета и убедиться, что sku/cost/stock
-- на месте:
--   SELECT sku, cost, stock FROM menu_items WHERE id = '<item>';
-- ============================================================
