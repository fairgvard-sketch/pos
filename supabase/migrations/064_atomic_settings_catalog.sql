-- ============================================================
-- 064: Атомарные RPC для настроек и каталога (P8)
--
-- Проблемы, которые чиним:
--  1. Клиент слал locations.settings ЦЕЛИКОМ (merge на клиенте) — при
--     параллельных мутациях (два таба/устройства) последний перетирал
--     чужие ключи (lost update). Теперь server-side JSONB deep-merge.
--  2. Сохранение товара делало отдельные DELETE+INSERT вариантов и
--     привязок групп РАЗНЫМИ запросами (частичный провал → битый товар).
--     Теперь одна транзакция (RPC).
--  3. Reorder категорий/товаров был серией независимых UPDATE (Promise.all)
--     — частичный провал оставлял смешанный порядок. Теперь один RPC.
--
-- Все три — SECURITY DEFINER, право 'manage' (менеджер+), скоуп по org.
-- Идемпотентность денег тут ни при чём: каталог/настройки — не финансовые
-- записи. Никаких DELETE финансовых данных.
-- ============================================================

-- ── 1. patch_location_settings: серверный deep-merge settings ──
-- Мержит переданный патч в locations.settings НА СЕРВЕРЕ (jsonb ||),
-- поэтому одновременная правка соседних разделов (perms vs receipt) не
-- затирает друг друга. Верхнеуровневые объекты (perms/receipt/shift/…)
-- мержатся на 1 уровень вложенности, скаляры перезаписываются.
CREATE OR REPLACE FUNCTION patch_location_settings(
  p_patch JSONB,
  p_staff_session UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc UUID := auth_location_id();
  v_cur JSONB;
  v_next JSONB;
  v_key TEXT;
  v_allowed TEXT[] := ARRAY['perms','receipt','shift','online_orders','reservations','tips','pay_methods','quick_amounts'];
BEGIN
  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'manage');

  IF jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a json object';
  END IF;

  -- Блокируем строку точки на время merge — исключаем гонку read-modify-write
  SELECT COALESCE(settings, '{}'::jsonb) INTO v_cur
  FROM locations WHERE id = v_loc FOR UPDATE;

  v_next := v_cur;

  -- Верхний уровень: известные разделы-объекты мержим (не перетираем соседей),
  -- прочие ключи присваиваем как есть.
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key = ANY(v_allowed)
       AND jsonb_typeof(v_next -> v_key) = 'object'
       AND jsonb_typeof(p_patch -> v_key) = 'object' THEN
      v_next := jsonb_set(v_next, ARRAY[v_key], (v_next -> v_key) || (p_patch -> v_key));
    ELSE
      v_next := jsonb_set(v_next, ARRAY[v_key], p_patch -> v_key);
    END IF;
  END LOOP;

  UPDATE locations SET settings = v_next WHERE id = v_loc;
  RETURN v_next;
END $$;

REVOKE EXECUTE ON FUNCTION patch_location_settings FROM anon, public;

-- ── 2. save_menu_item: товар + варианты + привязки групп транзакцией ──
-- p_item — поля товара (jsonb), p_variants — массив {name,price,is_default},
-- p_group_ids — массив group_id в порядке показа. Всё в одной транзакции:
-- частичный сбой откатывает целиком (не оставит битый товар).
-- p_item_id NULL → создание, иначе обновление существующего.
CREATE OR REPLACE FUNCTION save_menu_item(
  p_item JSONB,
  p_variants JSONB DEFAULT '[]'::jsonb,
  p_group_ids JSONB DEFAULT '[]'::jsonb,
  p_item_id UUID DEFAULT NULL,
  p_staff_session UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_id  UUID := p_item_id;
  v_v   JSONB;
  v_g   TEXT;
  v_i   INTEGER := 0;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM require_staff_perm(p_staff_session, 'manage');

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
      cost            = NULLIF(p_item ->> 'cost', '')::INTEGER,
      sku             = NULLIF(p_item ->> 'sku', ''),
      track_inventory = COALESCE((p_item ->> 'track_inventory')::BOOLEAN, track_inventory),
      stock           = NULLIF(p_item ->> 'stock', '')::INTEGER
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

  RETURN v_id;
END $$;

REVOKE EXECUTE ON FUNCTION save_menu_item FROM anon, public;

-- ── 3. reorder_menu: атомарный порядок категорий/товаров ──
-- p_kind = 'category' | 'item'; p_ids — массив id в желаемом порядке.
-- sort_order := позиция в массиве. Один UPDATE ... FROM ... вместо серии.
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

  IF p_kind NOT IN ('category', 'item') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind;
  END IF;

  IF p_kind = 'category' THEN
    UPDATE menu_categories c
    SET sort_order = o.ord
    FROM (SELECT value::UUID AS id, (ordinality - 1) AS ord
          FROM jsonb_array_elements_text(p_ids) WITH ORDINALITY) o
    WHERE c.id = o.id AND c.org_id = v_org;
  ELSE
    UPDATE menu_items m
    SET sort_order = o.ord
    FROM (SELECT value::UUID AS id, (ordinality - 1) AS ord
          FROM jsonb_array_elements_text(p_ids) WITH ORDINALITY) o
    WHERE m.id = o.id AND m.org_id = v_org;
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION reorder_menu FROM anon, public;
