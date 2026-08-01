-- ============================================================
-- 123 FLOOR PLAN WEB — зоны и столы точки из веб-кабинета.
--
-- МОТИВ. Reserve продаётся отдельно от кассы (103–107), но завести зал
-- умела ТОЛЬКО касса: `create_table_zone_with_tables`, `rename_table_zone`,
-- `delete_table_zone`, `reorder_table_zones` (066/067) читают точку из
-- `auth_location_id()`, а в токене веб-владельца её нет — вызов падает на
-- 'not authenticated'. Столы заводились прямым INSERT из POS-конструктора,
-- где org_id и location_id берутся из контекста устройства.
--
-- Итог: организация, купившая только Reserve, не могла создать ни одного
-- стола. Без столов пуст таймлайн хостес (119/120), instant-режим не
-- находит, кого посадить (`_pick_tables` 063), а гостю выдаётся «мест
-- нет» на пустой зал. Это и был последний блокер отдельной продажи
-- Reserve — Phase 6, пункт 5 плана `claude-angle-reserve-improvement-plan`.
--
-- Здесь — веб-зеркала по модели 091/102/120: право даёт членство
-- owner/manager в `organization_members`, точка приходит параметром,
-- сверху capability-гейт. Гейт ШИРЕ, чем у стола хостес: план зала нужен
-- и Reserve (`reservations_desk`), и кассе в режиме столов (`pos_operate`),
-- поэтому достаточно любой из двух возможностей.
--
-- Отличия от кассового пути — сознательные, а не побочные:
--   1) Стол не «удаляется», если на нём висит живая бронь будущего или
--      открытый счёт. Касса (`deleteTable`) молча гасит is_active, и
--      бронь остаётся привязанной к столу, которого больше нет на плане.
--      Для владельца standalone-точки, который правит зал сам и без
--      подсказки хостес, это тихая потеря визита — здесь она запрещена.
--   2) Дубль названия стола отклоняется при СОЗДАНИИ и при смене
--      названия. Правку существующего стола (вместимость, зона) дубль
--      названия не блокирует: в данных, заведённых кассой, повторы уже
--      могли остаться, и чинить их принудительно — не задача этого RPC.
--
-- Кассовые функции не тронуты: POS-конструктор продолжает работать через
-- 066/067 и прямые UPDATE под RLS.
--
-- ⚠️ ТРЕБУЕТ 066/067 (зоны), 088/091 (членство), 103/105 (capabilities).
-- ============================================================

-- ── Общий guard плана зала ───────────────────────────────────
/**
 * Активный owner/manager кабинета этой организации + точка организации +
 * подключён Reserve или POS. Возвращает id членства (атрибуция не пишется
 * в сам план — столы аудита не ведут, — но guard симметричен 120).
 */
CREATE OR REPLACE FUNCTION _floor_plan_web_member(p_location_id UUID)
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID;
BEGIN
  IF auth_backoffice_role() IS NULL
     OR auth_backoffice_role() NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;

  SELECT id INTO v_member
  FROM organization_members
  WHERE auth_user_id = auth.uid() AND org_id = auth_org_id() AND is_active
  LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'backoffice access denied';
  END IF;

  PERFORM assert_backoffice_location(p_location_id);

  -- План зала обслуживает оба продукта: столы Reserve и столы кассы.
  IF NOT (org_has_capability(auth_org_id(), 'reservations_desk')
          OR org_has_capability(auth_org_id(), 'pos_operate')) THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  RETURN v_member;
END $$;

REVOKE ALL ON FUNCTION _floor_plan_web_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _floor_plan_web_member(UUID) TO authenticated, service_role;

-- ── Зоны ─────────────────────────────────────────────────────
/**
 * Создать зону вместе с набором столов — одна транзакция, как в 066.
 * Идемпотентно по p_zone_id: повтор после таймаута возвращает уже
 * созданную зону и НЕ добавляет столы второй раз.
 *
 * p_table_count = 0 создаёт пустую зону: владелец заводит столы поимённо.
 */
CREATE OR REPLACE FUNCTION create_table_zone_web(
  p_location_id      UUID,
  p_zone_id          UUID,
  p_name             TEXT,
  p_sort_order       INTEGER DEFAULT 0,
  p_table_count      INTEGER DEFAULT 0,
  p_table_prefix     TEXT DEFAULT '',
  p_table_sort_order INTEGER DEFAULT 0,
  p_table_seats      INTEGER DEFAULT 2
) RETURNS table_zones
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org  UUID := auth_org_id();
  v_name TEXT := btrim(COALESCE(p_name, ''));
  v_zone table_zones%ROWTYPE;
BEGIN
  PERFORM _floor_plan_web_member(p_location_id);

  IF length(v_name) = 0 THEN RAISE EXCEPTION 'zone_name_required'; END IF;
  IF p_table_count < 0 OR p_table_count > 50 THEN RAISE EXCEPTION 'invalid_table_count'; END IF;
  IF p_table_seats < 1 OR p_table_seats > 100 THEN RAISE EXCEPTION 'invalid_seats'; END IF;

  SELECT * INTO v_zone FROM table_zones
  WHERE id = p_zone_id AND org_id = v_org AND location_id = p_location_id;
  IF FOUND THEN RETURN v_zone; END IF;

  IF EXISTS (
    SELECT 1 FROM table_zones
    WHERE location_id = p_location_id AND is_active AND lower(name) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'zone_exists';
  END IF;

  INSERT INTO table_zones (id, org_id, location_id, name, sort_order)
  VALUES (p_zone_id, v_org, p_location_id, v_name, COALESCE(p_sort_order, 0))
  RETURNING * INTO v_zone;

  IF p_table_count > 0 THEN
    -- Пачка столов не должна создать имена, которые одиночный редактор
    -- потом откажется сохранять: правило уникальности одно на весь план.
    IF EXISTS (
      SELECT 1 FROM tables t
      JOIN generate_series(1, p_table_count) AS n ON TRUE
      WHERE t.location_id = p_location_id AND t.is_active
        AND lower(t.label) = lower(COALESCE(btrim(p_table_prefix), '') || n::TEXT)
    ) THEN
      RAISE EXCEPTION 'table_exists';
    END IF;

    INSERT INTO tables (org_id, location_id, label, zone, zone_id, sort_order, seats, combinable)
    SELECT v_org, p_location_id, COALESCE(btrim(p_table_prefix), '') || n::TEXT,
           v_zone.name, v_zone.id, COALESCE(p_table_sort_order, 0) + n - 1,
           p_table_seats, FALSE
    FROM generate_series(1, p_table_count) AS n;
  END IF;

  RETURN v_zone;
END $$;

/** Переименование синхронизирует текстовый снимок zone в столах (066). */
CREATE OR REPLACE FUNCTION rename_table_zone_web(
  p_location_id UUID,
  p_zone_id     UUID,
  p_name        TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org  UUID := auth_org_id();
  v_name TEXT := btrim(COALESCE(p_name, ''));
BEGIN
  PERFORM _floor_plan_web_member(p_location_id);
  IF length(v_name) = 0 THEN RAISE EXCEPTION 'zone_name_required'; END IF;

  IF EXISTS (
    SELECT 1 FROM table_zones
    WHERE location_id = p_location_id AND is_active
      AND id <> p_zone_id AND lower(name) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'zone_exists';
  END IF;

  UPDATE table_zones SET name = v_name
  WHERE id = p_zone_id AND org_id = v_org AND location_id = p_location_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'zone_not_found'; END IF;

  UPDATE tables SET zone = v_name
  WHERE zone_id = p_zone_id AND org_id = v_org AND location_id = p_location_id AND is_active;
END $$;

/** Мягкое удаление зоны: её столы остаются и переходят в «без зоны». */
CREATE OR REPLACE FUNCTION delete_table_zone_web(
  p_location_id UUID,
  p_zone_id     UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  PERFORM _floor_plan_web_member(p_location_id);

  UPDATE tables SET zone_id = NULL, zone = NULL
  WHERE zone_id = p_zone_id AND org_id = v_org AND location_id = p_location_id AND is_active;

  UPDATE table_zones SET is_active = FALSE
  WHERE id = p_zone_id AND org_id = v_org AND location_id = p_location_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'zone_not_found'; END IF;
END $$;

/** Порядок зон — позиция в массиве. Чужие id молча игнорируются (067). */
CREATE OR REPLACE FUNCTION reorder_table_zones_web(
  p_location_id UUID,
  p_zone_ids    UUID[]
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  PERFORM _floor_plan_web_member(p_location_id);
  IF p_zone_ids IS NULL OR array_length(p_zone_ids, 1) IS NULL THEN RETURN; END IF;

  UPDATE table_zones z
  SET sort_order = ord.pos - 1
  FROM unnest(p_zone_ids) WITH ORDINALITY AS ord(id, pos)
  WHERE z.id = ord.id AND z.org_id = v_org AND z.location_id = p_location_id AND z.is_active;
END $$;

-- ── Столы ────────────────────────────────────────────────────
/**
 * Завести или изменить стол. Идемпотентно по p_id: клиент создаёт UUID до
 * первой попытки и повторяет его после таймаута (инвариант 6).
 *
 * zone_id проверяется по этой же точке — стол не может уехать в зону
 * другого зала (FK tables_zone_scope_fk это тоже держит, но своя проверка
 * даёт понятный код вместо текста нарушения ограничения).
 */
CREATE OR REPLACE FUNCTION save_table_web(
  p_location_id UUID,
  p_id          UUID,
  p_label       TEXT,
  p_zone_id     UUID DEFAULT NULL,
  p_seats       INTEGER DEFAULT 2,
  p_combinable  BOOLEAN DEFAULT FALSE,
  p_sort_order  INTEGER DEFAULT 0
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
                        sort_order, seats, combinable)
    VALUES (p_id, v_org, p_location_id, v_label, v_zone_name, p_zone_id,
            COALESCE(p_sort_order, 0), p_seats, COALESCE(p_combinable, FALSE))
    RETURNING * INTO v_row;
  ELSE
    UPDATE tables
    SET label      = v_label,
        zone       = v_zone_name,
        zone_id    = p_zone_id,
        seats      = p_seats,
        combinable = COALESCE(p_combinable, FALSE),
        sort_order = COALESCE(p_sort_order, v_cur.sort_order),
        -- Правка стола возвращает его в работу: владелец открыл план
        -- именно затем, чтобы стол снова использовался.
        is_active  = TRUE
    WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END $$;

/**
 * Убрать стол с плана. Мягко (is_active = FALSE): ссылки заказов и
 * прошлых броней остаются целыми.
 *
 * Отказ, если стол занят СЕЙЧАС или обещан гостю: открытый счёт кассы
 * либо живая бронь, окно которой ещё не закончилось. Иначе владелец
 * одним тапом стирает стол, за которым сегодня ждут гостя, и бронь
 * повисает без места — на таймлайне её строка просто исчезает.
 */
CREATE OR REPLACE FUNCTION delete_table_web(
  p_location_id UUID,
  p_id          UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  PERFORM _floor_plan_web_member(p_location_id);

  IF NOT EXISTS (
    SELECT 1 FROM tables
    WHERE id = p_id AND org_id = v_org AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'table_not_found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM orders
    WHERE table_id = p_id AND org_id = v_org AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'table_in_use';
  END IF;

  IF EXISTS (
    SELECT 1 FROM reservation_tables
    WHERE table_id = p_id AND org_id = v_org AND is_live AND upper(occupancy) > NOW()
  ) THEN
    RAISE EXCEPTION 'table_booked';
  END IF;

  UPDATE tables SET is_active = FALSE, status = 'free'
  WHERE id = p_id AND org_id = v_org AND location_id = p_location_id;
END $$;

/**
 * Снять стол с обслуживания, не убирая с плана (ремонт, зарезервирован
 * под событие). Зеркало кассовой `set_table_status` (016).
 */
CREATE OR REPLACE FUNCTION set_table_status_web(
  p_location_id UUID,
  p_id          UUID,
  p_status      TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  PERFORM _floor_plan_web_member(p_location_id);

  IF p_status NOT IN ('free', 'reserved', 'disabled') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  UPDATE tables SET status = p_status
  WHERE id = p_id AND org_id = v_org AND location_id = p_location_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'table_not_found'; END IF;
END $$;

-- ── Права ────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION create_table_zone_web(UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION rename_table_zone_web(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION delete_table_zone_web(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION reorder_table_zones_web(UUID, UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION save_table_web(UUID, UUID, TEXT, UUID, INTEGER, BOOLEAN, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION delete_table_web(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION set_table_status_web(UUID, UUID, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION create_table_zone_web(UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION rename_table_zone_web(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_table_zone_web(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION reorder_table_zones_web(UUID, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION save_table_web(UUID, UUID, TEXT, UUID, INTEGER, BOOLEAN, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_table_web(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION set_table_status_web(UUID, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION create_table_zone_web(UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, INTEGER) IS
  'Зона зала и набор столов из веб-кабинета (123). Идемпотентно по p_zone_id.';
COMMENT ON FUNCTION save_table_web(UUID, UUID, TEXT, UUID, INTEGER, BOOLEAN, INTEGER) IS
  'Стол точки из веб-кабинета (123): создание или правка, идемпотентно по p_id.';
COMMENT ON FUNCTION delete_table_web(UUID, UUID) IS
  'Убрать стол с плана из веб-кабинета (123). Отказ, если открытый счёт (table_in_use) или живая бронь впереди (table_booked).';

-- ── Проверка после применения ────────────────────────────────
-- Под ролью веб-владельца (JWT с app_metadata.org_id):
--   SELECT create_table_zone_web('<loc>', gen_random_uuid(), 'Терраса', 0, 4, 'T', 0);
--   SELECT save_table_web('<loc>', gen_random_uuid(), 'T5', '<zone>', 4, TRUE, 4);
--   SELECT delete_table_web('<loc>', '<table>');   -- table_booked, если бронь впереди
-- Откат: функции 123 удаляются DROP FUNCTION ... ; кассовый путь 066/067
-- независим, данные (tables, table_zones) миграция не меняет.
