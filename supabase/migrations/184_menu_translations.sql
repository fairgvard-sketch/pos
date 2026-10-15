-- 184: переводы QR-меню на английский и русский.
--
-- Гость QR-меню выбирает язык (иврит, английский, русский), а каталог
-- хранился на одном языке. Перевод — свойство самой записи каталога,
-- поэтому у категорий, блюд, размеров, групп добавок и добавок появляется
-- колонка translations:
--
--   {"en": {"name": "Cappuccino", "description": "..."},
--    "ru": {"name": "Капучино"}}
--
-- Базовые name/description не меняются и остаются языком заведения: из
-- них сервер снапшотит заказ, по ним печатаются тикеты и чеки (всегда на
-- иврите), их видит касса. Ключ he допустим: так ивритское название
-- получает позиция, чьё базовое имя набрано на другом языке.
--
-- Категории и добавки кабинет пишет прямыми запросами под RLS, а не RPC,
-- поэтому форму перевода держит триггер, а не одна функция сохранения:
-- лишние пробелы срезаются, пустые строки и языки выбрасываются, чужой
-- язык, чужое поле, не-строка и слишком длинный текст отклоняются.
--
-- save_menu_item пересоздаёт размеры при каждом сохранении (129). Без
-- снимка их переводы пропадали бы от любой правки с кассы или из старого
-- клиента, который о переводах не знает. Поэтому, как упаковка в 129,
-- переводы размеров без ключа translations переносятся по имени размера.
-- Ключ translations у товара или размера — полная замена его переводов;
-- отсутствие ключа — не трогать.
--
-- Какие языки видит гость, решает владелец: locations.settings
-- .online_orders.languages (["en","ru"], иврит всегда). Ключ пишет
-- существующий patch_location_settings_web, отдельной миграции не нужно.
--
-- ⚠️ ТРЕБУЕТ 179 (обёртка save_menu_item с курсом подачи).

ALTER TABLE menu_categories ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE menu_items      ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE item_variants   ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE modifier_groups ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE modifiers       ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN menu_items.translations IS
  'Переводы для гостя (184): {"en"|"ru"|"he": {"name", "description"}}. Заказ, тикеты и чеки берут базовые name/description.';
COMMENT ON COLUMN menu_categories.translations IS
  'Переводы названия для гостя (184): {"en"|"ru"|"he": {"name"}}.';
COMMENT ON COLUMN item_variants.translations IS
  'Переводы названия размера для гостя (184). save_menu_item переносит их по имени размера, если ключ не прислан.';
COMMENT ON COLUMN modifier_groups.translations IS
  'Переводы названия группы добавок для гостя (184).';
COMMENT ON COLUMN modifiers.translations IS
  'Переводы названия добавки для гостя (184).';

-- ── Форма перевода ─────────────────────────────────────────
-- TG_ARGV — допустимые поля таблицы: описание есть только у блюда.
CREATE FUNCTION normalize_menu_translations()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_in     JSONB := NEW.translations;
  v_out    JSONB := '{}'::jsonb;
  v_lang   TEXT;
  v_fields JSONB;
  v_field  TEXT;
  v_entry  JSONB;
  v_text   TEXT;
  v_limit  INTEGER;
BEGIN
  IF v_in IS NULL OR jsonb_typeof(v_in) = 'null' THEN
    NEW.translations := '{}'::jsonb;
    RETURN NEW;
  END IF;
  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'invalid_translations' USING ERRCODE = '22023';
  END IF;

  FOR v_lang, v_fields IN SELECT key, value FROM jsonb_each(v_in) LOOP
    IF v_lang NOT IN ('he', 'en', 'ru') THEN
      RAISE EXCEPTION 'invalid_translations: language %', v_lang USING ERRCODE = '22023';
    END IF;
    CONTINUE WHEN jsonb_typeof(v_fields) = 'null';
    IF jsonb_typeof(v_fields) <> 'object' THEN
      RAISE EXCEPTION 'invalid_translations' USING ERRCODE = '22023';
    END IF;

    v_entry := '{}'::jsonb;
    FOR v_field IN SELECT jsonb_object_keys(v_fields) LOOP
      IF NOT (v_field = ANY(TG_ARGV)) THEN
        RAISE EXCEPTION 'invalid_translations: field %', v_field USING ERRCODE = '22023';
      END IF;
      CONTINUE WHEN jsonb_typeof(v_fields -> v_field) = 'null';
      IF jsonb_typeof(v_fields -> v_field) <> 'string' THEN
        RAISE EXCEPTION 'invalid_translations' USING ERRCODE = '22023';
      END IF;
      v_text := btrim(v_fields ->> v_field, E' \t\r\n');
      -- Название — одна строка; в описании владелец может держать абзацы
      IF v_field = 'name' THEN
        v_text := regexp_replace(v_text, '\s+', ' ', 'g');
      END IF;
      -- Лимит отдельной переменной: CASE внутри IF … THEN plpgsql режет по
      -- первому THEN
      v_limit := CASE v_field WHEN 'name' THEN 120 ELSE 1000 END;
      IF char_length(v_text) > v_limit THEN
        RAISE EXCEPTION 'translation_too_long: %', v_field USING ERRCODE = '22001';
      END IF;
      IF v_text <> '' THEN
        v_entry := v_entry || jsonb_build_object(v_field, v_text);
      END IF;
    END LOOP;

    IF v_entry <> '{}'::jsonb THEN
      v_out := v_out || jsonb_build_object(v_lang, v_entry);
    END IF;
  END LOOP;

  NEW.translations := v_out;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION normalize_menu_translations() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER menu_translations_normalize BEFORE INSERT OR UPDATE OF translations ON menu_categories
  FOR EACH ROW EXECUTE FUNCTION normalize_menu_translations('name');
CREATE TRIGGER menu_translations_normalize BEFORE INSERT OR UPDATE OF translations ON menu_items
  FOR EACH ROW EXECUTE FUNCTION normalize_menu_translations('name', 'description');
CREATE TRIGGER menu_translations_normalize BEFORE INSERT OR UPDATE OF translations ON item_variants
  FOR EACH ROW EXECUTE FUNCTION normalize_menu_translations('name');
CREATE TRIGGER menu_translations_normalize BEFORE INSERT OR UPDATE OF translations ON modifier_groups
  FOR EACH ROW EXECUTE FUNCTION normalize_menu_translations('name');
CREATE TRIGGER menu_translations_normalize BEFORE INSERT OR UPDATE OF translations ON modifiers
  FOR EACH ROW EXECUTE FUNCTION normalize_menu_translations('name');

-- ── save_menu_item: переводы товара и размеров ─────────────
-- Обёртка над 179 (курс подачи), как 179 была обёрткой над 129. Гранты
-- остаются у внешней функции; внутреннюю напрямую не вызвать.
ALTER FUNCTION save_menu_item(JSONB, JSONB, JSONB, UUID, UUID, JSONB)
  RENAME TO save_menu_item_179_impl;
REVOKE ALL ON FUNCTION save_menu_item_179_impl(JSONB, JSONB, JSONB, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION save_menu_item(
  p_item JSONB, p_variants JSONB DEFAULT '[]', p_group_ids JSONB DEFAULT '[]',
  p_item_id UUID DEFAULT NULL, p_staff_session UUID DEFAULT NULL, p_supplies JSONB DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id   UUID;
  -- Имя размера → его переводы до пересоздания размеров
  v_keep JSONB := '{}'::jsonb;
BEGIN
  -- Гейт до чтения прежних переводов; внутренняя функция повторит его
  PERFORM require_org_capability('catalog_manage');

  IF p_item_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_object_agg(iv.name, iv.translations), '{}'::jsonb)
      INTO v_keep
    FROM item_variants iv
    JOIN menu_items mi ON mi.id = iv.item_id
    WHERE iv.item_id = p_item_id
      AND mi.org_id = auth_org_id()
      AND iv.translations <> '{}'::jsonb;
  END IF;

  v_id := save_menu_item_179_impl(p_item, p_variants, p_group_ids, p_item_id,
                                  p_staff_session, p_supplies);

  IF p_item ? 'translations' THEN
    UPDATE menu_items SET translations = p_item -> 'translations'
    WHERE id = v_id AND org_id = auth_org_id();
  END IF;

  -- Размеры вставлены в порядке массива с sort_order = 0..n−1 (129)
  UPDATE item_variants iv
  SET translations = CASE
    WHEN e.v ? 'translations' THEN e.v -> 'translations'
    ELSE v_keep -> iv.name
  END
  FROM jsonb_array_elements(p_variants) WITH ORDINALITY AS e(v, n)
  WHERE iv.item_id = v_id
    AND iv.sort_order = e.n - 1
    AND (e.v ? 'translations' OR v_keep ? iv.name);

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION save_menu_item(JSONB, JSONB, JSONB, UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_menu_item(JSONB, JSONB, JSONB, UUID, UUID, JSONB) TO authenticated, service_role;

-- ============================================================
-- ОТКАТ
--
-- Forward-only. Колонки пустые по умолчанию и ничего не ломают в старых
-- клиентах. Функциональный откат — новая миграция, возвращающая имя
-- save_menu_item обёртке 179; данные переводов при этом не трогать.
--
-- ПРОВЕРКА:
--   SELECT name, translations FROM menu_items WHERE translations <> '{}' LIMIT 5;
-- ============================================================
