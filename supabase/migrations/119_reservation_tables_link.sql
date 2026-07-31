-- ============================================================
-- 119 RESERVATION ↔ TABLES — явная связь брони со столами,
-- посадка гостя и хостес-действия над бронью.
--
-- МОТИВ. Бронь хранила основной стол в `table_id`, а остальные столы
-- объединения — в массиве `hold_table_ids`. Занятость же считалась ТОЛЬКО
-- по `table_id`: и EXCLUDE-констрейнт, и (до 117) `_table_free`. 117
-- закрыла дыру в подборе, расширив предикат на массив, но гонку двух
-- ОДНОВРЕМЕННЫХ объединённых броней закрыть было нечем: gist-исключение
-- по массиву не строится.
--
-- Здесь появляется нормальная связь «одна строка на стол брони». На ней:
--   * EXCLUDE работает для ВСЕХ столов брони, включая объединённые —
--     гонка закрыта на уровне БД, а не соглашения;
--   * таймлайн хостес (Phase 3) получает прямой источник «кто где сидит»
--     вместо разбора массива на клиенте;
--   * `_table_free` читает один индексируемый предикат.
--
-- Связь ведёт ТРИГГЕР, а не переписанные RPC: сохранять её вручную в
-- шести местах (submit/accept/set_table/reschedule/create/seat) значило бы
-- гарантированно однажды забыть. Триггер синхронизирует строки из
-- (table_id, hold_table_ids, occupancy, status) при любой записи в бронь,
-- поэтому старые тела функций продолжают работать как есть, а нарушение
-- EXCLUDE прилетает им привычным `exclusion_violation` — существующие
-- обработчики превращают его в 'full_slot' / 'table_busy'.
--
-- ПОСАДКА. Добавляется `arrived_at` — момент, когда гость сел. Отдельного
-- статуса СОЗНАТЕЛЬНО нет: POS уже отмечает посадку наличием `order_id`
-- (057), и второй способ выражать то же состояние разошёлся бы с первым.
-- Флаг работает в обоих контурах: касса ставит его при `seat_reservation`,
-- веб/хостес — через `mark_reservation_arrived`. Занятость стола посадка
-- не меняет: визит и так занимает стол в `confirmed`.
--
-- ⚠️ ТРЕБУЕТ 117 (_table_free v2), 118 (self-service).
-- ============================================================

-- ── 1. Связь брони со столами ────────────────────────────────
CREATE TABLE IF NOT EXISTS reservation_tables (
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  table_id       UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Копия окна занятости брони: EXCLUDE строится по этой таблице, а
  -- range в родителе меняется триггером 063.
  occupancy      TSTZRANGE NOT NULL,
  -- Живая бронь занимает стол. Денормализация статуса нужна частичному
  -- индексу: gist по подзапросу в родителя не построить.
  is_live        BOOLEAN NOT NULL,
  -- Основной стол брони (тот, что в reservations.table_id) — им
  -- адресуется посадка в POS-заказ; остальные добавлены объединением.
  is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (reservation_id, table_id)
);

COMMENT ON TABLE reservation_tables IS
  'Столы брони: одна строка на стол, включая добавленные объединением (119). Ведётся триггером из reservations; на ней держится анти-овербукинг.';

-- EXCLUDE навешивается НИЖЕ, после бэкфилла: в проде могли остаться
-- пересечения по объединённым столам (до 117 их никто не проверял), и
-- констрейнт на пустой таблице просто не дал бы данные загрузить.

CREATE INDEX IF NOT EXISTS idx_reservation_tables_live
  ON reservation_tables USING gist (table_id, occupancy) WHERE is_live;
CREATE INDEX IF NOT EXISTS idx_reservation_tables_loc
  ON reservation_tables (location_id, is_live);

ALTER TABLE reservation_tables ENABLE ROW LEVEL SECURITY;

-- Чтение — своя организация (таймлайн хостес). Запись только через
-- триггер под SECURITY DEFINER: клиенту связь не редактируется.
CREATE POLICY reservation_tables_select ON reservation_tables
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

REVOKE ALL ON reservation_tables FROM anon;
REVOKE INSERT, UPDATE, DELETE ON reservation_tables FROM authenticated;
GRANT SELECT ON reservation_tables TO authenticated, service_role;

-- ── 2. Бэкфилл существующих броней ───────────────────────────
-- Набор строится из (table_id + hold_table_ids) одним запросом. Триггер
-- и EXCLUDE появляются ПОСЛЕ: пока их нет, загрузка не может упасть на
-- пересечении, и конфликты разбираются отдельным шагом осознанно.
INSERT INTO reservation_tables (
  reservation_id, table_id, org_id, location_id, occupancy, is_live, is_primary)
SELECT
  r.id, t.table_id, r.org_id, r.location_id,
  COALESCE(r.occupancy, tstzrange(
    r.reserved_at,
    r.reserved_at + make_interval(mins => COALESCE(r.duration_min, 90)), '[)')),
  r.status IN ('new', 'confirmed'),
  t.table_id = r.table_id
FROM reservations r
CROSS JOIN LATERAL (
  SELECT DISTINCT x AS table_id
  FROM unnest(ARRAY[r.table_id] || COALESCE(r.hold_table_ids, '{}')) AS x
  WHERE x IS NOT NULL
) t
ON CONFLICT DO NOTHING;

-- Разводим пересечения, оставшиеся с тех пор, когда занятость считалась
-- только по основному столу. Приём тот же, что в 063: стол снимается у
-- более РАННЕЙ брони, более поздняя сохраняет назначение, каждый случай
-- попадает в NOTICE.
DO $$
DECLARE
  v_pair     RECORD;
  v_conflict INTEGER := 0;
BEGIN
  LOOP
    SELECT a.reservation_id AS drop_res, a.table_id AS drop_table,
           ra.customer_name, ra.reserved_at
    INTO v_pair
    FROM reservation_tables a
    JOIN reservation_tables b
      ON b.table_id = a.table_id
     AND b.reservation_id <> a.reservation_id
     AND b.occupancy && a.occupancy
     AND b.is_live
    JOIN reservations ra ON ra.id = a.reservation_id
    JOIN reservations rb ON rb.id = b.reservation_id
    WHERE a.is_live AND ra.created_at <= rb.created_at
    LIMIT 1;

    EXIT WHEN NOT FOUND;

    DELETE FROM reservation_tables
    WHERE reservation_id = v_pair.drop_res AND table_id = v_pair.drop_table;

    UPDATE reservations
    SET table_id = CASE WHEN table_id = v_pair.drop_table THEN NULL ELSE table_id END,
        hold_table_ids = array_remove(hold_table_ids, v_pair.drop_table)
    WHERE id = v_pair.drop_res;

    v_conflict := v_conflict + 1;
    RAISE NOTICE '119: пересечение столов — у брони % (% на %) снят стол %; ПРОВЕРИТЬ вручную',
      v_pair.drop_res, v_pair.customer_name, v_pair.reserved_at, v_pair.drop_table;
  END LOOP;

  RAISE NOTICE '119: связь брони со столами заполнена — % строк, % конфликтов разведено.',
    (SELECT COUNT(*) FROM reservation_tables), v_conflict;
END $$;

-- ── 3. Анти-овербукинг и синхронизация ───────────────────────
-- Гонка закрыта здесь: столы одной брони и столы РАЗНЫХ броней
-- проверяются одинаково, включая добавленные объединением.
ALTER TABLE reservation_tables DROP CONSTRAINT IF EXISTS reservation_tables_no_overlap;
ALTER TABLE reservation_tables ADD CONSTRAINT reservation_tables_no_overlap
  EXCLUDE USING gist (table_id WITH =, occupancy WITH &&) WHERE (is_live);

/**
 * Перестраивает строки столов брони при любой записи. Живыми считаются
 * те же статусы, что и раньше (new/confirmed) — терминальные освобождают
 * стол. DELETE→INSERT покрывает разом снятие стола, смену набора при
 * объединении и переход в терминальный статус.
 */
CREATE OR REPLACE FUNCTION _sync_reservation_tables()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_live  BOOLEAN := NEW.status IN ('new', 'confirmed');
  v_table UUID;
BEGIN
  DELETE FROM reservation_tables WHERE reservation_id = NEW.id;

  IF NEW.table_id IS NOT NULL THEN
    INSERT INTO reservation_tables (
      reservation_id, table_id, org_id, location_id, occupancy, is_live, is_primary)
    VALUES (NEW.id, NEW.table_id, NEW.org_id, NEW.location_id,
            NEW.occupancy, v_live, TRUE);
  END IF;

  FOREACH v_table IN ARRAY COALESCE(NEW.hold_table_ids, '{}') LOOP
    -- Основной стол мог продублироваться в массиве — связь идемпотентна.
    IF v_table IS NOT NULL AND v_table IS DISTINCT FROM NEW.table_id THEN
      INSERT INTO reservation_tables (
        reservation_id, table_id, org_id, location_id, occupancy, is_live, is_primary)
      VALUES (NEW.id, v_table, NEW.org_id, NEW.location_id,
              NEW.occupancy, v_live, FALSE)
      ON CONFLICT (reservation_id, table_id) DO NOTHING;
    END IF;
  END LOOP;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_reservation_tables ON reservations;
CREATE TRIGGER trg_reservation_tables
  AFTER INSERT OR UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION _sync_reservation_tables();

-- ── 4. _table_free v3: один индексируемый предикат ───────────
CREATE OR REPLACE FUNCTION _table_free(
  p_table_id UUID,
  p_at       TIMESTAMPTZ,
  p_dur_min  INTEGER,
  p_buffer   INTEGER DEFAULT 0,
  p_exclude  UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM reservation_tables rt
    WHERE rt.table_id = p_table_id
      AND rt.is_live
      AND (p_exclude IS NULL OR rt.reservation_id <> p_exclude)
      AND rt.occupancy && tstzrange(
            p_at - make_interval(mins => p_buffer),
            p_at + make_interval(mins => p_dur_min + p_buffer),
            '[)')
  );
$$;

COMMENT ON FUNCTION _table_free(UUID, TIMESTAMPTZ, INTEGER, INTEGER, UUID) IS
  'Свободен ли стол в окне визита с буфером. С 119 читает reservation_tables — объединённые столы учитываются наравне с основным.';

-- ── 5. Посадка гостя ─────────────────────────────────────────
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;

COMMENT ON COLUMN reservations.arrived_at IS
  'Момент посадки гостя (119). Отдельного статуса нет: POS отмечает посадку ещё и наличием order_id (057), второй способ выражать то же состояние разошёлся бы с первым.';

/**
 * Отметить, что гость сел. Для точки без POS это и есть «посадка»:
 * заказ не открывается, стол остаётся занят до completed/no_show.
 * Идемпотентно — повторное нажатие не сдвигает время.
 */
CREATE OR REPLACE FUNCTION mark_reservation_arrived(
  p_id       UUID,
  p_staff_id UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_r   reservations%ROWTYPE;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  SELECT * INTO v_r FROM reservations WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found';
  END IF;
  IF v_r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'not_confirmed';
  END IF;

  IF v_r.arrived_at IS NULL THEN
    UPDATE reservations
    SET arrived_at = NOW(),
        decided_by = COALESCE(p_staff_id, decided_by)
    WHERE id = p_id;
  END IF;

  RETURN json_build_object('reservation_id', p_id, 'arrived', TRUE);
END $$;

REVOKE ALL ON FUNCTION mark_reservation_arrived(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_reservation_arrived(UUID, UUID) TO authenticated, service_role;

-- seat_reservation (057) проставляет тот же флаг: посадка на кассе и
-- посадка в вебе — одно состояние, а не два похожих.
CREATE OR REPLACE FUNCTION seat_reservation(p_id UUID, p_staff_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_r        reservations%ROWTYPE;
  v_o        orders%ROWTYPE;
  v_order_id UUID;
  v_res      JSON;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_r FROM reservations WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found';
  END IF;
  IF v_r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'reservation not confirmed';
  END IF;
  IF v_r.table_id IS NULL THEN
    RAISE EXCEPTION 'table not assigned';
  END IF;

  -- Уже посажена: возвращаем тот же счёт (идемпотентность 057).
  IF v_r.order_id IS NOT NULL THEN
    SELECT * INTO v_o FROM orders WHERE id = v_r.order_id;
    IF FOUND AND v_o.status = 'open' THEN
      RETURN json_build_object(
        'order_id', v_o.id, 'daily_number', v_o.daily_number,
        'total', v_o.total, 'existing', TRUE);
    END IF;
  END IF;

  v_res := open_or_get_table_order(v_r.table_id, p_staff_id);
  v_order_id := (v_res ->> 'order_id')::UUID;

  UPDATE reservations
  SET order_id   = v_order_id,
      arrived_at = COALESCE(arrived_at, NOW())
  WHERE id = p_id;

  RETURN json_build_object(
    'order_id',     v_order_id,
    'daily_number', (v_res ->> 'daily_number')::INTEGER,
    'total',        COALESCE((v_res ->> 'total')::INTEGER, 0),
    'existing',     COALESCE((v_res ->> 'existing')::BOOLEAN, FALSE));
END $$;

REVOKE EXECUTE ON FUNCTION seat_reservation(UUID, UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION seat_reservation(UUID, UUID) TO authenticated, service_role;

-- ── 6. Столы брони: назначить / объединить / разъединить ─────
/**
 * Набор столов брони одним вызовом. Пустой массив снимает столы.
 * Первый стол становится основным (в него сажает POS), остальные —
 * объединение. Проверяется принадлежность точке и занятость; конфликт
 * отдаётся дружелюбным 'table_busy', а не сырым нарушением констрейнта
 * (жалоба из «Известных ограничений» 063).
 *
 * Вместимость НЕ проверяется: хостес видит зал и вправе посадить шестерых
 * за стол на четверых, сдвинув стулья. Продукт не спорит с человеком,
 * который смотрит на зал.
 */
CREATE OR REPLACE FUNCTION set_reservation_tables(
  p_id        UUID,
  p_staff_id  UUID,
  p_table_ids UUID[]
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_r     reservations%ROWTYPE;
  v_ids   UUID[] := COALESCE(p_table_ids, '{}');
  v_table UUID;
  v_buf   INTEGER;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_r FROM reservations WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found';
  END IF;
  IF v_r.status NOT IN ('new', 'confirmed') THEN
    RAISE EXCEPTION 'not_active';
  END IF;
  -- Посаженную бронь не перекидываем: за столом уже открыт счёт.
  IF v_r.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_mode';
  END IF;

  SELECT COALESCE((settings -> 'reservations' ->> 'buffer_min')::INTEGER, 0)
  INTO v_buf FROM locations WHERE id = v_r.location_id;

  FOREACH v_table IN ARRAY v_ids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM tables
      WHERE id = v_table AND org_id = v_org
        AND location_id = v_r.location_id AND is_active
    ) THEN
      RAISE EXCEPTION 'invalid table';
    END IF;
    IF NOT _table_free(v_table, v_r.reserved_at, v_r.duration_min, v_buf, v_r.id) THEN
      RAISE EXCEPTION 'table_busy';
    END IF;
  END LOOP;

  BEGIN
    UPDATE reservations
    SET table_id       = CASE WHEN array_length(v_ids, 1) IS NULL THEN NULL ELSE v_ids[1] END,
        hold_table_ids = CASE
                           WHEN array_length(v_ids, 1) IS NULL OR array_length(v_ids, 1) < 2
                             THEN '{}'::UUID[]
                           ELSE v_ids[2:array_length(v_ids, 1)]
                         END
    WHERE id = p_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  RETURN json_build_object('reservation_id', p_id, 'tables', v_ids);
END $$;

REVOKE ALL ON FUNCTION set_reservation_tables(UUID, UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_reservation_tables(UUID, UUID, UUID[]) TO authenticated, service_role;

-- ── 7. Правка брони хостес ───────────────────────────────────
/**
 * Изменение времени, размера компании, зоны и заметки со стола хостес.
 * NULL в параметре = «не менять».
 *
 * Часы работы здесь НЕ проверяются — сознательно, как и в create_reservation
 * (060): сотрудник вправе принять гостя на нерабочее время (частное
 * мероприятие, доброжелательность к постоянному). А вот занятость столов
 * проверяется: пересадить бронь на занятый стол нельзя даже вручную,
 * иначе таймлайн начнёт показывать невозможное.
 */
CREATE OR REPLACE FUNCTION update_reservation(
  p_id          UUID,
  p_staff_id    UUID,
  p_reserved_at TIMESTAMPTZ DEFAULT NULL,
  p_party_size  INTEGER     DEFAULT NULL,
  p_note        TEXT        DEFAULT NULL,
  p_zone_id     UUID        DEFAULT NULL,
  p_duration    INTEGER     DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_r     reservations%ROWTYPE;
  v_at    TIMESTAMPTZ;
  v_dur   INTEGER;
  v_buf   INTEGER;
  v_table UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_r FROM reservations WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found';
  END IF;
  IF v_r.status NOT IN ('new', 'confirmed') THEN
    RAISE EXCEPTION 'not_active';
  END IF;

  v_at  := COALESCE(p_reserved_at, v_r.reserved_at);
  v_dur := COALESCE(p_duration, v_r.duration_min);
  IF v_dur < 15 OR v_dur > 1440 THEN
    RAISE EXCEPTION 'invalid_duration';
  END IF;
  IF p_party_size IS NOT NULL AND (p_party_size < 1 OR p_party_size > 200) THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = v_r.location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  SELECT COALESCE((settings -> 'reservations' ->> 'buffer_min')::INTEGER, 0)
  INTO v_buf FROM locations WHERE id = v_r.location_id;

  -- Сдвиг времени/длительности должен уместиться на уже назначенных столах.
  IF v_at <> v_r.reserved_at OR v_dur <> v_r.duration_min THEN
    FOREACH v_table IN ARRAY (
      ARRAY(SELECT x FROM unnest(ARRAY[v_r.table_id] || COALESCE(v_r.hold_table_ids, '{}')) AS x
            WHERE x IS NOT NULL)
    ) LOOP
      IF NOT _table_free(v_table, v_at, v_dur, v_buf, v_r.id) THEN
        RAISE EXCEPTION 'table_busy';
      END IF;
    END LOOP;
  END IF;

  BEGIN
    UPDATE reservations
    SET reserved_at  = v_at,
        duration_min = v_dur,
        party_size   = COALESCE(p_party_size, party_size),
        note         = COALESCE(NULLIF(LEFT(TRIM(p_note), 200), ''), note),
        zone_id      = COALESCE(p_zone_id, zone_id)
    WHERE id = p_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  RETURN json_build_object('reservation_id', p_id, 'reserved_at', v_at);
END $$;

REVOKE ALL ON FUNCTION update_reservation(UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT, UUID, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_reservation(UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT, UUID, INTEGER)
  TO authenticated, service_role;

-- ── 8. create_reservation v2: догоняет 063/117 ───────────────
-- Тело 060 + три исправления, найденные аудитом Phase 0:
--   * потолок гостей был жёстко 20, хотя таблица допускает 200, а лимит
--     точки задаётся настройкой max_party — банкет завести было нельзя;
--   * занятость стола не проверялась, и ручная бронь на занятый стол
--     падала сырым нарушением констрейнта вместо понятного 'table_busy';
--   * зону (072) с кассы задать было нельзя.
-- Старая 8-арг сигнатура (060) дропается, а не переопределяется: добавить
-- параметр через CREATE OR REPLACE нельзя (получилась бы перегрузка и
-- неоднозначность вызова), а убрать дефолты у существующей — тем более
-- (42P13). Приём тот же, что в 072. Выложенный клиент кассы шлёт параметры
-- ИМЕНАМИ, поэтому вызов с восемью аргументами разрешится в новую функцию:
-- p_zone_id и p_duration подставятся дефолтами.
DROP FUNCTION IF EXISTS create_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID);

CREATE FUNCTION create_reservation(
  p_location_id UUID,
  p_staff_id    UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_reserved_at TIMESTAMPTZ,
  p_note        TEXT DEFAULT NULL,
  p_table_id    UUID DEFAULT NULL,
  p_zone_id     UUID DEFAULT NULL,
  p_duration    INTEGER DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_loc   locations%ROWTYPE;
  v_name  TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note  TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_dur   INTEGER;
  v_buf   INTEGER;
  v_id    UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  SELECT * INTO v_loc FROM locations WHERE id = p_location_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  -- Потолок — технический предел таблицы: ручную бронь ограничивать
  -- гостевой настройкой max_party незачем, банкет заводит именно хостес.
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > 200 THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_reserved_at IS NULL THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;

  v_dur := COALESCE(p_duration,
                    (v_loc.settings -> 'reservations' ->> 'duration_min')::INTEGER, 90);
  IF v_dur < 15 OR v_dur > 1440 THEN
    RAISE EXCEPTION 'invalid_duration';
  END IF;
  v_buf := COALESCE((v_loc.settings -> 'reservations' ->> 'buffer_min')::INTEGER, 0);

  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  IF p_table_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM tables
      WHERE id = p_table_id AND org_id = v_org
        AND location_id = p_location_id AND is_active
    ) THEN
      RAISE EXCEPTION 'invalid table';
    END IF;
    IF NOT _table_free(p_table_id, p_reserved_at, v_dur, v_buf, NULL) THEN
      RAISE EXCEPTION 'table_busy';
    END IF;
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, note, table_id, zone_id, duration_min,
      status, decided_by, decided_at)
    VALUES (v_org, p_location_id, gen_random_uuid(), v_name, v_phone,
            p_party_size, p_reserved_at, v_note, p_table_id, p_zone_id, v_dur,
            'confirmed', p_staff_id, NOW())
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  RETURN json_build_object('reservation_id', v_id);
END $$;

REVOKE ALL ON FUNCTION create_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, UUID, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, UUID, INTEGER)
  TO authenticated, service_role;

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only, данные не удаляются. `reservation_tables` производна от
-- `reservations` и полностью перестраивается триггером, поэтому её можно
-- пересобрать в любой момент:
--
--   UPDATE reservations SET id = id;   -- прогоняет триггер по всем строкам
--
-- Функциональный откат анти-овербукинга объединённых столов:
--   ALTER TABLE reservation_tables DROP CONSTRAINT reservation_tables_no_overlap;
-- (родительский reservations_no_overlap по table_id остаётся в силе.)
--
-- ПРОВЕРОЧНЫЕ ЗАПРОСЫ:
--   -- связь совпадает с массивами брони (ожидается 0)
--   SELECT COUNT(*) FROM reservations r
--   WHERE (SELECT COUNT(DISTINCT x) FROM unnest(
--            ARRAY[r.table_id] || COALESCE(r.hold_table_ids, '{}')) AS x WHERE x IS NOT NULL)
--       <> (SELECT COUNT(*) FROM reservation_tables rt WHERE rt.reservation_id = r.id);
--
--   -- живые пересечения по столам (ожидается 0)
--   SELECT a.reservation_id, b.reservation_id, a.table_id
--   FROM reservation_tables a JOIN reservation_tables b
--     ON a.table_id = b.table_id AND a.reservation_id < b.reservation_id
--    AND a.occupancy && b.occupancy
--   WHERE a.is_live AND b.is_live;
-- ============================================================
