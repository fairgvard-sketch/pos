-- ============================================================
-- 138 FLOOR LAYOUT WEB — план зала как план, а не как список.
--
-- МОТИВ. Раскладка зала (017/018) существует с первых версий: у стола
-- есть координаты в процентах холста, размер и форма. Но правит их
-- ТОЛЬКО касса: `set_table_layout` читает `auth_org_id()` и не проверяет
-- ни членство в кабинете, ни capability — то есть по модели прав она из
-- другого мира, чем весь остальной веб-контур (123). Владелец Reserve
-- без кассы не может расставить столы вообще: кабинет показывает списки,
-- и «стол 12» никак не связан с местом в зале.
--
-- Плюс два свойства, которых нет нигде, а спрашивают их постоянно:
--
--   * `min_party` — «двойку за стол на шестерых не сажаем». Без него
--     автоподбор честно отдаёт первый подходящий стол, и в пятницу
--     шестёрка занята парой;
--   * `auto_assign` — стол существует, но в автоматическом подборе не
--     участвует: витринный столик у кассы, стол под персонал, место,
--     которое хостес отдаёт вручную и по ситуации.
--
-- ЧЕСТНОСТЬ ФЛАГА. `auto_assign` действует и для гостя, и для кабинета —
-- то есть везде, где стол подбирается АВТОМАТИЧЕСКИ. Ручное назначение
-- столов хостес он не ограничивает: там занятость проверяет
-- `_table_free`, и запрет «этот стол нельзя» превратил бы аварийную
-- посадку в тупик. Такое поведение делает флаг проверяемым в одном
-- месте (`_pick_tables`) вместо шести переопределённых функций — а
-- значит, оно останется правдой и через год.
--
-- ⚠️ ТРЕБУЕТ 017/018 (координаты и форма), 072 (`_pick_tables`),
-- 123 (веб-план зала, `_floor_plan_web_member`).
-- ============================================================

-- ── Свойства стола ───────────────────────────────────────────
ALTER TABLE tables ADD COLUMN IF NOT EXISTS min_party INTEGER;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS auto_assign BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE tables DROP CONSTRAINT IF EXISTS tables_min_party_check;
ALTER TABLE tables ADD CONSTRAINT tables_min_party_check
  CHECK (min_party IS NULL OR (min_party >= 1 AND min_party <= 100));

COMMENT ON COLUMN tables.min_party IS
  'Минимальная компания для автоподбора (138). NULL — ограничения нет. Ручное назначение хостес не ограничивает.';
COMMENT ON COLUMN tables.auto_assign IS
  'Участвует ли стол в автоматическом подборе (138). FALSE — только по явному выбору хостес.';

-- ── Подбор столов уважает оба свойства ───────────────────────
/**
 * Сигнатура НЕ меняется: у функции девять вызывающих в семи миграциях,
 * и добавление параметра заставило бы переписать их все — то есть
 * скопировать сотни строк чужой логики ради одного условия. Правила
 * живут там, где принимается решение.
 */
CREATE OR REPLACE FUNCTION _pick_tables(
  p_location_id UUID,
  p_party       INTEGER,
  p_at          TIMESTAMPTZ,
  p_dur_min     INTEGER,
  p_buffer      INTEGER DEFAULT 0,
  p_combine     BOOLEAN DEFAULT FALSE,
  p_exclude     UUID DEFAULT NULL,
  p_zone_id     UUID DEFAULT NULL
) RETURNS UUID[]
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_id    UUID;
  v_seats INTEGER;
  v_acc   INTEGER := 0;
  v_out   UUID[] := '{}';
BEGIN
  -- 1) Наименьший одиночный свободный стол, вмещающий всю компанию
  SELECT t.id INTO v_id
  FROM tables t
  WHERE t.location_id = p_location_id AND t.is_active AND t.seats >= p_party
    AND t.auto_assign
    AND (t.min_party IS NULL OR p_party >= t.min_party)
    AND (p_zone_id IS NULL OR t.zone_id = p_zone_id)
    AND _table_free(t.id, p_at, p_dur_min, p_buffer, p_exclude)
  ORDER BY t.seats ASC, t.sort_order ASC
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN ARRAY[v_id];
  END IF;

  IF NOT p_combine THEN
    RETURN '{}';
  END IF;

  -- 2) Жадно набираем combinable-столы, пока не наберём вместимость.
  --    Порог min_party здесь тоже действует: он про то, кому стол
  --    достаётся, а не про то, один он или в связке.
  FOR v_id, v_seats IN
    SELECT t.id, t.seats
    FROM tables t
    WHERE t.location_id = p_location_id AND t.is_active AND t.combinable
      AND t.auto_assign
      AND (t.min_party IS NULL OR p_party >= t.min_party)
      AND (p_zone_id IS NULL OR t.zone_id = p_zone_id)
      AND _table_free(t.id, p_at, p_dur_min, p_buffer, p_exclude)
    ORDER BY t.seats DESC, t.sort_order ASC
  LOOP
    v_out := array_append(v_out, v_id);
    v_acc := v_acc + v_seats;
    EXIT WHEN v_acc >= p_party;
  END LOOP;

  IF v_acc >= p_party THEN
    RETURN v_out;
  END IF;
  RETURN '{}';  -- не хватило даже объединением
END $$;

REVOKE ALL ON FUNCTION _pick_tables(UUID, INTEGER, TIMESTAMPTZ, INTEGER, INTEGER, BOOLEAN, UUID, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _pick_tables(UUID, INTEGER, TIMESTAMPTZ, INTEGER, INTEGER, BOOLEAN, UUID, UUID)
  TO authenticated, service_role;

-- ── Сохранение раскладки одним вызовом ───────────────────────
/**
 * План зала сохраняется целиком и по кнопке, а не по каждому
 * перетаскиванию.
 *
 * Почему пакетом: владелец двигает пять столов подряд, и пять запросов —
 * это пять шансов сохранить половину плана. Здесь либо применяется вся
 * раскладка, либо ничего.
 *
 * Почему по кнопке: автосохранение каждого drag'а лишает возможности
 * передумать. Отмена до сохранения — это просто «не нажимать Save».
 *
 * Формат: [{"id": uuid, "x": 0..100, "y": 0..100, "w": 1..50,
 *           "h": 1..60, "shape": "square"|"circle"}]
 * Координаты в ПРОЦЕНТАХ холста (017): план тянется под любой экран, а
 * столы держат взаимное расположение.
 */
CREATE OR REPLACE FUNCTION save_floor_layout_web(
  p_location_id UUID,
  p_layout      JSONB
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_item  JSONB;
  v_id    UUID;
  v_x     NUMERIC;
  v_y     NUMERIC;
  v_w     NUMERIC;
  v_h     NUMERIC;
  v_shape TEXT;
  v_count INTEGER := 0;
BEGIN
  PERFORM _floor_plan_web_member(p_location_id);

  IF jsonb_typeof(p_layout) <> 'array' THEN
    RAISE EXCEPTION 'invalid_layout';
  END IF;
  IF jsonb_array_length(p_layout) > 300 THEN
    RAISE EXCEPTION 'too_many_tables';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_layout) LOOP
    v_id    := (v_item ->> 'id')::UUID;
    v_x     := (v_item ->> 'x')::NUMERIC;
    v_y     := (v_item ->> 'y')::NUMERIC;
    v_w     := NULLIF(v_item ->> 'w', '')::NUMERIC;
    v_h     := NULLIF(v_item ->> 'h', '')::NUMERIC;
    v_shape := NULLIF(v_item ->> 'shape', '');

    IF v_x IS NULL OR v_y IS NULL OR v_x < 0 OR v_x > 100 OR v_y < 0 OR v_y > 100 THEN
      RAISE EXCEPTION 'position out of range';
    END IF;
    IF v_w IS NOT NULL AND (v_w <= 0 OR v_w > 50) THEN
      RAISE EXCEPTION 'invalid width';
    END IF;
    IF v_h IS NOT NULL AND (v_h <= 0 OR v_h > 60) THEN
      RAISE EXCEPTION 'invalid height';
    END IF;
    IF v_shape IS NOT NULL AND v_shape NOT IN ('square', 'circle') THEN
      RAISE EXCEPTION 'invalid shape';
    END IF;

    UPDATE tables SET
      pos_x  = v_x,
      pos_y  = v_y,
      width  = COALESCE(v_w, width),
      height = COALESCE(v_h, height),
      shape  = COALESCE(v_shape, shape)
    WHERE id = v_id
      AND org_id = v_org
      AND location_id = p_location_id
      AND is_active;

    -- Стол из чужой точки или уже снятый с плана молча пропускаем: у
    -- владельца могла быть открыта вкладка со вчерашним залом, и ронять
    -- из-за неё сохранение остальных столов незачем.
    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION save_floor_layout_web(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_floor_layout_web(UUID, JSONB) TO authenticated;

COMMENT ON FUNCTION save_floor_layout_web(UUID, JSONB) IS
  'Сохранить раскладку зала целиком (138): координаты в процентах холста, размер и форма. Право — членство owner/manager, гейт Reserve или POS.';

-- ── Свойства стола из инспектора ─────────────────────────────
-- Старая 7-арг сигнатура (123) дропается, а не переопределяется:
-- добавить параметры через CREATE OR REPLACE нельзя — получилась бы
-- перегрузка и неоднозначность вызова (тот же приём, что в 072/119).
-- Выложенный кабинет шлёт параметры ИМЕНАМИ, поэтому его вызовы с семью
-- аргументами разрешатся в новую функцию: новые поля возьмут дефолты и
-- ничего не изменят.
DROP FUNCTION IF EXISTS save_table_web(UUID, UUID, TEXT, UUID, INTEGER, BOOLEAN, INTEGER);

CREATE FUNCTION save_table_web(
  p_location_id UUID,
  p_id          UUID,
  p_label       TEXT,
  p_zone_id     UUID DEFAULT NULL,
  p_seats       INTEGER DEFAULT 2,
  p_combinable  BOOLEAN DEFAULT FALSE,
  p_sort_order  INTEGER DEFAULT 0,
  p_shape       TEXT DEFAULT NULL,
  p_min_party   INTEGER DEFAULT NULL,
  p_auto_assign BOOLEAN DEFAULT NULL
) RETURNS tables
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org       UUID := auth_org_id();
  v_label     TEXT := btrim(COALESCE(p_label, ''));
  v_zone_name TEXT;
  v_cur       tables%ROWTYPE;
  v_row       tables%ROWTYPE;
BEGIN
  PERFORM _floor_plan_web_member(p_location_id);

  IF length(v_label) = 0 THEN RAISE EXCEPTION 'table_label_required'; END IF;
  IF length(v_label) > 24 THEN RAISE EXCEPTION 'table_label_too_long'; END IF;
  IF p_seats < 1 OR p_seats > 100 THEN RAISE EXCEPTION 'invalid_seats'; END IF;
  IF p_shape IS NOT NULL AND p_shape NOT IN ('square', 'circle') THEN
    RAISE EXCEPTION 'invalid shape';
  END IF;
  IF p_min_party IS NOT NULL AND (p_min_party < 1 OR p_min_party > p_seats) THEN
    -- Порог больше вместимости означал бы стол, который не достанется
    -- никому: такую настройку лучше отклонить, чем молча потерять стол.
    RAISE EXCEPTION 'invalid_min_party';
  END IF;

  IF p_zone_id IS NOT NULL THEN
    SELECT name INTO v_zone_name FROM table_zones
    WHERE id = p_zone_id AND org_id = v_org AND location_id = p_location_id AND is_active;
    IF v_zone_name IS NULL THEN RAISE EXCEPTION 'invalid_zone'; END IF;
  END IF;

  SELECT * INTO v_cur FROM tables
  WHERE id = p_id AND org_id = v_org AND location_id = p_location_id
  FOR UPDATE;

  -- Дубль имени ловим на создании и на переименовании; уже существующие
  -- повторы (заведённые кассой) правку стола не блокируют.
  IF NOT FOUND OR lower(v_cur.label) <> lower(v_label) THEN
    IF EXISTS (
      SELECT 1 FROM tables
      WHERE location_id = p_location_id AND is_active
        AND id <> p_id AND lower(label) = lower(v_label)
    ) THEN
      RAISE EXCEPTION 'table_exists';
    END IF;
  END IF;

  IF v_cur.id IS NULL THEN
    INSERT INTO tables (id, org_id, location_id, label, zone, zone_id,
                        sort_order, seats, combinable, shape, min_party, auto_assign)
    VALUES (p_id, v_org, p_location_id, v_label, v_zone_name, p_zone_id,
            COALESCE(p_sort_order, 0), p_seats, COALESCE(p_combinable, FALSE),
            COALESCE(p_shape, 'square'), p_min_party, COALESCE(p_auto_assign, TRUE))
    RETURNING * INTO v_row;
  ELSE
    UPDATE tables
    SET label      = v_label,
        zone       = v_zone_name,
        zone_id    = p_zone_id,
        seats      = p_seats,
        combinable = COALESCE(p_combinable, FALSE),
        sort_order = COALESCE(p_sort_order, v_cur.sort_order),
        shape      = COALESCE(p_shape, v_cur.shape),
        -- NULL здесь означает «не трогать»: старый кабинет не знает про
        -- эти поля и не должен их обнулять при обычном переименовании.
        min_party   = CASE WHEN p_min_party IS NULL THEN v_cur.min_party ELSE p_min_party END,
        auto_assign = COALESCE(p_auto_assign, v_cur.auto_assign),
        -- Правка стола возвращает его в работу: владелец открыл план
        -- именно затем, чтобы стол снова использовался.
        is_active  = TRUE
    WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION save_table_web(UUID, UUID, TEXT, UUID, INTEGER, BOOLEAN, INTEGER, TEXT, INTEGER, BOOLEAN)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_table_web(UUID, UUID, TEXT, UUID, INTEGER, BOOLEAN, INTEGER, TEXT, INTEGER, BOOLEAN)
  TO authenticated;

COMMENT ON FUNCTION save_table_web(UUID, UUID, TEXT, UUID, INTEGER, BOOLEAN, INTEGER, TEXT, INTEGER, BOOLEAN) IS
  'Создать или изменить стол из кабинета (123, расширено 138): форма, минимальная компания и участие в автоподборе. NULL в новых полях — «не трогать».';

-- ── Сброс минимальной компании ───────────────────────────────
/**
 * NULL в `save_table_web` означает «не трогать», поэтому снять порог им
 * нельзя — для этого отдельный вызов. Без него настройка была бы
 * необратимой: поставил «от 4» и живи с этим.
 */
CREATE OR REPLACE FUNCTION clear_table_min_party_web(
  p_location_id UUID,
  p_id          UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  PERFORM _floor_plan_web_member(p_location_id);

  UPDATE tables SET min_party = NULL
  WHERE id = p_id AND org_id = v_org AND location_id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table_not_found';
  END IF;
END $$;

REVOKE ALL ON FUNCTION clear_table_min_party_web(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION clear_table_min_party_web(UUID, UUID) TO authenticated;

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only. Кассовый `set_table_layout` (017/018) не тронут и
-- продолжает работать для POS-конструктора.
--
-- Новые правила подбора выключаются данными, а не откатом: столы по
-- умолчанию `auto_assign = TRUE` и `min_party = NULL`, то есть до первой
-- настройки поведение ровно прежнее.
--
-- Проверка на целевой базе:
--   SELECT label, pos_x, pos_y, shape, min_party, auto_assign
--   FROM tables WHERE is_active ORDER BY sort_order;
-- ============================================================
