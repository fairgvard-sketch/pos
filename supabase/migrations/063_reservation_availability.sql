-- ============================================================
-- 063 RESERVATION AVAILABILITY — движок вместимости + мгновенная
-- бронь (Ontopo-стиль). Платформенная фича: всё за флагами в
-- settings.reservations, каждое кафе включает нужное.
--
-- Что добавляет поверх 053/057/059/060/062:
--   1. tables.seats        — вместимость стола (сколько гостей).
--      tables.combinable   — можно ли складывать с соседними (2+2=4).
--   2. reservations.duration_min — длительность визита (для окна занятости).
--      reservations.auto          — бронь пришла мгновенной (без хостес).
--      reservations.hold_table_ids — доп. столы объединённой брони (кроме
--                                     основного table_id). Массив UUID.
--      deposit_amount/deposit_status — ПЛЕЙСХОЛДЕР депозита (агороты),
--                                     без реальной оплаты (подключим с Cardcom).
--   3. EXCLUDE-констрейнт reservations_no_overlap — race-free запрет двух
--      «живых» броней (new/confirmed) на один стол в пересекающемся окне.
--   4. reservation_availability(loc, day, party) — сетка слотов дня со
--      статусом free/full: свободные столы (seats>=party) минус занятые
--      бронью, пересекающей слот. Учитывает часы приёма и буфер.
--   5. submit_reservation v2 — instant-режим: если settings.reservations
--      .instant=true, атомарно подбирает свободный стол(ы) и ставит
--      confirmed сразу; нет места → 'full_slot'. Иначе — прежняя заявка 'new'.
--   6. guest_history(phone) — CRM гостя для кассы: визиты, no-show, заметки.
--
-- Настройки (settings.reservations), все опциональны, дефолты консервативны:
--   enabled            bool   — тумблер приёма (053, дефолт off)
--   instant            bool   — мгновенное подтверждение (дефолт off = заявка)
--   combine            bool   — разрешить объединение столов (дефолт off)
--   duration_min       int    — длительность визита по умолчанию (дефолт 90)
--   buffer_min         int    — буфер уборки между бронями (дефолт 0)
--   deposit_required   bool   — требовать депозит (плейсхолдер, дефолт off)
--   deposit_amount     int    — сумма депозита в агоротах (плейсхолдер)
--   deposit_from_party int    — депозит от N гостей (дефолт: со всех, если required)
--   open/close/slot_min/max_party — часы приёма/лимит (059/062)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── 1. Вместимость столов ────────────────────────────────────
ALTER TABLE tables ADD COLUMN IF NOT EXISTS seats INTEGER NOT NULL DEFAULT 2
  CHECK (seats BETWEEN 1 AND 100);
ALTER TABLE tables ADD COLUMN IF NOT EXISTS combinable BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 2. Поля брони ────────────────────────────────────────────
-- Снимаем старый потолок party_size (053: BETWEEN 1 AND 20) — платформа
-- обслуживает и банкетные залы. Верхняя граница на бронь задаётся
-- настройкой max_party; здесь оставляем разумный технический потолок.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_party_size_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_party_size_check
  CHECK (party_size BETWEEN 1 AND 200);

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS duration_min INTEGER NOT NULL DEFAULT 90
  CHECK (duration_min BETWEEN 15 AND 1440);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS hold_table_ids UUID[] NOT NULL DEFAULT '{}';
-- Депозит — ПЛЕЙСХОЛДЕР (без оплаты; подключим с Cardcom Low Profile).
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_amount INTEGER NOT NULL DEFAULT 0
  CHECK (deposit_amount >= 0);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_status TEXT NOT NULL DEFAULT 'none'
  CHECK (deposit_status IN ('none', 'required', 'paid', 'refunded', 'forfeited'));

-- Окно занятости брони как tstzrange (для EXCLUDE и пересечений). GiST
-- индексирует range напрямую. GENERATED-колонка тут невозможна:
-- make_interval(mins => duration_min) не IMMUTABLE (Postgres 42P17), поэтому
-- держим обычную колонку и синхронизируем триггером на INSERT/UPDATE.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS occupancy TSTZRANGE;

CREATE OR REPLACE FUNCTION _sync_reservation_occupancy()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.occupancy := tstzrange(
    NEW.reserved_at,
    NEW.reserved_at + make_interval(mins => COALESCE(NEW.duration_min, 90)),
    '[)');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reservation_occupancy ON reservations;
CREATE TRIGGER trg_reservation_occupancy
  BEFORE INSERT OR UPDATE OF reserved_at, duration_min ON reservations
  FOR EACH ROW EXECUTE FUNCTION _sync_reservation_occupancy();

-- Заполнить для уже существующих строк (одноразово)
UPDATE reservations
SET occupancy = tstzrange(
      reserved_at,
      reserved_at + make_interval(mins => COALESCE(duration_min, 90)),
      '[)')
WHERE occupancy IS NULL;

-- ── 3. Анти-овербукинг: один «живой» слот на стол в пересекающемся окне ──
-- Только для броней с назначенным столом и статусом new/confirmed.
-- rejected/cancelled столов не держат. Race-free на уровне БД.
--
-- ВАЖНО: модель 053 допускала мягкие конфликты (кассир мог назначить стол
-- вопреки подсказке ±2ч). Значит в проде МОГУТ уже быть пересекающиеся
-- живые брони на одном столе — тогда ADD CONSTRAINT упадёт. Поэтому сперва
-- «разводим» существующие пересечения: у более СТАРОЙ из пары брони снимаем
-- стол (table_id := NULL), новая сохраняет назначение. Идемпотентно.
DO $$
DECLARE
  v_fixed INTEGER := 0;
  v_pair  RECORD;
BEGIN
  LOOP
    SELECT a.id AS keep_id, b.id AS drop_id
    INTO v_pair
    FROM reservations a
    JOIN reservations b
      ON a.table_id = b.table_id
     AND a.status IN ('new', 'confirmed')
     AND b.status IN ('new', 'confirmed')
     AND a.table_id IS NOT NULL
     AND a.id <> b.id
     AND tstzrange(a.reserved_at, a.reserved_at + make_interval(mins => COALESCE(a.duration_min, 90)), '[)')
      && tstzrange(b.reserved_at, b.reserved_at + make_interval(mins => COALESCE(b.duration_min, 90)), '[)')
     -- оставляем более позднюю (a), снимаем стол у более ранней (b)
     AND a.created_at >= b.created_at
    LIMIT 1;

    EXIT WHEN NOT FOUND;
    UPDATE reservations SET table_id = NULL WHERE id = v_pair.drop_id;
    v_fixed := v_fixed + 1;
  END LOOP;
  IF v_fixed > 0 THEN
    RAISE NOTICE '063: разведено % пересекающихся броней (стол снят у более ранней)', v_fixed;
  END IF;
END $$;

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_no_overlap;
ALTER TABLE reservations ADD CONSTRAINT reservations_no_overlap
  EXCLUDE USING gist (
    table_id WITH =,
    occupancy WITH &&
  ) WHERE (table_id IS NOT NULL AND status IN ('new', 'confirmed'));

CREATE INDEX IF NOT EXISTS idx_reservations_occupancy
  ON reservations USING gist (location_id, occupancy)
  WHERE status IN ('new', 'confirmed');

-- ============================================================
-- Хелпер: свободен ли стол в окне [p_at, p_at+dur+buffer) — нет
-- пересекающейся живой брони. Буфер расширяет окно занятости с обеих
-- сторон (уборка/подготовка). p_exclude — id брони, которую игнорируем
-- (при переносе/повторной проверке самой себя).
-- ============================================================
CREATE OR REPLACE FUNCTION _table_free(
  p_table_id UUID,
  p_at       TIMESTAMPTZ,
  p_dur_min  INTEGER,
  p_buffer   INTEGER DEFAULT 0,
  p_exclude  UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.table_id = p_table_id
      AND r.status IN ('new', 'confirmed')
      AND (p_exclude IS NULL OR r.id <> p_exclude)
      AND r.occupancy && tstzrange(
            p_at - make_interval(mins => p_buffer),
            p_at + make_interval(mins => p_dur_min + p_buffer),
            '[)')
  );
$$;

-- ============================================================
-- Подбор стола под бронь. Возвращает массив table_id:
--   * один стол с seats>=party (наименьший подходящий) — обычный случай;
--   * если p_combine и одиночного нет — жадно набирает combinable-столы
--     (по возрастанию мест) до суммарной вместимости >= party;
--   * пустой массив = мест нет.
-- Учитывает буфер и исключение самой брони (перенос).
-- ============================================================
CREATE OR REPLACE FUNCTION _pick_tables(
  p_location_id UUID,
  p_party       INTEGER,
  p_at          TIMESTAMPTZ,
  p_dur_min     INTEGER,
  p_buffer      INTEGER DEFAULT 0,
  p_combine     BOOLEAN DEFAULT FALSE,
  p_exclude     UUID DEFAULT NULL
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
    AND _table_free(t.id, p_at, p_dur_min, p_buffer, p_exclude)
  ORDER BY t.seats ASC, t.sort_order ASC
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN ARRAY[v_id];
  END IF;

  IF NOT p_combine THEN
    RETURN '{}';
  END IF;

  -- 2) Жадно набираем combinable-столы, пока не наберём вместимость
  FOR v_id, v_seats IN
    SELECT t.id, t.seats
    FROM tables t
    WHERE t.location_id = p_location_id AND t.is_active AND t.combinable
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

-- ============================================================
-- RPC: reservation_availability — сетка слотов дня для гостя.
-- Для каждого слота [open..close] шага slot_min возвращает, есть ли
-- свободный стол(ы) под party_size. День — в локальной зоне точки.
-- Только через Edge Function (service_role).
--
-- Возврат: { date, slot_min, slots: [ {time:'HH:MM', free:bool} ] }
-- ============================================================
CREATE OR REPLACE FUNCTION reservation_availability(
  p_location_id UUID,
  p_date        DATE,
  p_party       INTEGER
) RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_tz       TEXT;
  v_open     TIME := '07:00';
  v_close    TIME := '23:45';
  v_step     INTEGER := 15;
  v_dur      INTEGER := 90;
  v_buffer   INTEGER := 0;
  v_combine  BOOLEAN := FALSE;
  v_min_at   TIMESTAMPTZ := NOW() + INTERVAL '30 minutes';
  v_slots    JSONB := '[]'::jsonb;
  v_t        TIME;
  v_at       TIMESTAMPTZ;
  v_free     BOOLEAN;
BEGIN
  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;
  v_tz  := v_loc.timezone;
  v_rsv := v_loc.settings -> 'reservations';

  IF NOT COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;
  IF p_party IS NULL OR p_party < 1 OR p_party > 200 THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;

  v_open    := COALESCE(NULLIF(v_rsv ->> 'open', '')::TIME, v_open);
  v_close   := COALESCE(NULLIF(v_rsv ->> 'close', '')::TIME, v_close);
  v_step    := GREATEST(5, COALESCE((v_rsv ->> 'slot_min')::INTEGER, v_step));
  v_dur      := COALESCE((v_rsv ->> 'duration_min')::INTEGER, v_dur);
  v_buffer   := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, v_buffer);
  v_combine  := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);

  v_t := v_open;
  WHILE v_t <= v_close LOOP
    -- Локальное время слота → момент в UTC для сравнения с бронями
    v_at := (p_date + v_t) AT TIME ZONE v_tz;
    IF v_at >= v_min_at THEN
      v_free := array_length(
        _pick_tables(p_location_id, p_party, v_at, v_dur, v_buffer, v_combine, NULL), 1
      ) IS NOT NULL;
      v_slots := v_slots || jsonb_build_object(
        'time', to_char(v_t, 'HH24:MI'),
        'free', v_free
      );
    END IF;
    v_t := v_t + make_interval(mins => v_step);
  END LOOP;

  RETURN json_build_object(
    'date', p_date,
    'slot_min', v_step,
    'slots', v_slots
  );
END $$;

REVOKE ALL ON FUNCTION reservation_availability FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reservation_availability TO service_role;

-- ============================================================
-- submit_reservation v2 — с instant-режимом.
-- instant=true: подбираем стол(ы), ставим confirmed+table_id атомарно;
--   нет места → 'full_slot'. hold_table_ids хранит доп. столы объединения.
-- instant=false: прежнее поведение — заявка 'new' без стола.
-- Депозит (плейсхолдер): если deposit_required и party>=deposit_from_party,
--   deposit_status='required', deposit_amount из настроек (оплата — позже).
-- ============================================================
CREATE OR REPLACE FUNCTION submit_reservation(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_reserved_at TIMESTAMPTZ,
  p_note        TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_existing reservations%ROWTYPE;
  v_name     TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone    TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note     TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_open     TEXT;
  v_close    TEXT;
  v_local    TIME;
  v_max      INTEGER;
  v_instant  BOOLEAN;
  v_combine  BOOLEAN;
  v_dur      INTEGER;
  v_buffer   INTEGER;
  v_tables   UUID[];
  v_table    UUID := NULL;
  v_hold     UUID[] := '{}';
  v_status   TEXT := 'new';
  v_dep_amt  INTEGER := 0;
  v_dep_st   TEXT := 'none';
  v_id       UUID;
BEGIN
  -- Идемпотентность
  SELECT * INTO v_existing FROM reservations WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('reservation_id', v_existing.id, 'duplicate', TRUE,
                             'status', v_existing.status);
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;
  v_rsv := v_loc.settings -> 'reservations';

  IF NOT COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;
  v_max := GREATEST(1, LEAST(200, COALESCE((v_rsv ->> 'max_party')::INTEGER, 20)));
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > v_max THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_reserved_at IS NULL
     OR p_reserved_at < NOW() + INTERVAL '30 minutes'
     OR p_reserved_at > NOW() + INTERVAL '30 days' THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;

  -- Часы приёма (059)
  v_open  := NULLIF(v_rsv ->> 'open', '');
  v_close := NULLIF(v_rsv ->> 'close', '');
  IF v_open IS NOT NULL AND v_close IS NOT NULL THEN
    v_local := (p_reserved_at AT TIME ZONE v_loc.timezone)::time;
    IF v_local < v_open::time OR v_local > v_close::time THEN
      RAISE EXCEPTION 'outside_hours';
    END IF;
  END IF;

  -- Анти-спам
  IF (SELECT COUNT(*) FROM reservations
      WHERE customer_phone = v_phone AND created_at > NOW() - INTERVAL '15 minutes') >= 3 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT COUNT(*) FROM reservations
      WHERE location_id = p_location_id AND status = 'new') >= 30 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  v_instant := COALESCE((v_rsv ->> 'instant')::BOOLEAN, FALSE);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_dur     := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);

  -- Депозит-плейсхолдер (без оплаты)
  IF COALESCE((v_rsv ->> 'deposit_required')::BOOLEAN, FALSE)
     AND p_party_size >= COALESCE((v_rsv ->> 'deposit_from_party')::INTEGER, 1) THEN
    v_dep_amt := GREATEST(0, COALESCE((v_rsv ->> 'deposit_amount')::INTEGER, 0));
    IF v_dep_amt > 0 THEN
      v_dep_st := 'required';
    END IF;
  END IF;

  IF v_instant THEN
    -- Подбор стола(ов) под окно визита
    v_tables := _pick_tables(p_location_id, p_party_size, p_reserved_at, v_dur,
                             v_buffer, v_combine, NULL);
    IF array_length(v_tables, 1) IS NULL THEN
      RAISE EXCEPTION 'full_slot';
    END IF;
    v_table  := v_tables[1];
    v_hold   := v_tables[2:array_length(v_tables, 1)];  -- пусто для одиночного
    v_status := 'confirmed';
  END IF;

  -- INSERT. EXCLUDE-констрейнт ловит гонку (два инстант-гостя на один стол):
  -- при конфликте — отдаём full_slot, а не 500.
  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, note, duration_min, table_id, hold_table_ids,
      auto, status, decided_at, deposit_amount, deposit_status)
    VALUES (
      v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
      p_party_size, p_reserved_at, v_note, v_dur, v_table, COALESCE(v_hold, '{}'),
      v_instant, v_status, CASE WHEN v_instant THEN NOW() END, v_dep_amt, v_dep_st)
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'full_slot';
  END;

  RETURN json_build_object(
    'reservation_id', v_id,
    'duplicate', FALSE,
    'status', v_status,
    'deposit_status', v_dep_st,
    'deposit_amount', v_dep_amt
  );
END $$;

REVOKE ALL ON FUNCTION submit_reservation FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_reservation TO service_role;

-- ============================================================
-- RPC: guest_history — CRM гостя по телефону (для кассы при подтверждении).
-- Агрегат прошлых броней: всего визитов, no-show (rejected/cancelled),
-- последний визит, накопленные заметки. Только authenticated своей org.
-- ============================================================
CREATE OR REPLACE FUNCTION guest_history(p_phone TEXT)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_phone TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_res   JSON;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF LENGTH(v_phone) < 6 THEN
    RETURN json_build_object('visits', 0, 'cancelled', 0, 'last_at', NULL, 'notes', '[]'::json);
  END IF;

  SELECT json_build_object(
    'visits',    COUNT(*) FILTER (WHERE status IN ('confirmed')),
    'cancelled', COUNT(*) FILTER (WHERE status IN ('rejected', 'cancelled')),
    'total',     COUNT(*),
    'last_at',   MAX(reserved_at) FILTER (WHERE status = 'confirmed'),
    'name',      (ARRAY_AGG(customer_name ORDER BY created_at DESC))[1],
    'notes',     COALESCE(json_agg(note ORDER BY created_at DESC)
                   FILTER (WHERE note IS NOT NULL AND TRIM(note) <> ''), '[]'::json)
  ) INTO v_res
  FROM reservations
  WHERE org_id = v_org AND customer_phone = v_phone;

  RETURN v_res;
END $$;

REVOKE EXECUTE ON FUNCTION guest_history FROM anon, public;

-- ============================================================
-- accept_reservation v2 — при подтверждении проверяем, что стол
-- свободен в окне брони (иначе EXCLUDE и так не даст, но отдаём
-- понятную ошибку 'table_busy'). Столо-подбор кассой остаётся ручным.
-- Тело — копия 053 + проверка занятости стола.
-- ============================================================
CREATE OR REPLACE FUNCTION accept_reservation(
  p_id       UUID,
  p_staff_id UUID,
  p_table_id UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_r   reservations%ROWTYPE;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  SELECT * INTO v_r FROM reservations
    WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found';
  END IF;
  IF v_r.status = 'confirmed' THEN
    RETURN json_build_object('reservation_id', v_r.id, 'duplicate', TRUE);
  END IF;
  IF v_r.status <> 'new' THEN
    RAISE EXCEPTION 'already decided';
  END IF;

  IF p_table_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM tables
      WHERE id = p_table_id AND org_id = v_org
        AND location_id = v_r.location_id AND is_active
    ) THEN
      RAISE EXCEPTION 'invalid table';
    END IF;
    -- Стол свободен в окне этой брони? (исключаем саму бронь)
    IF NOT _table_free(p_table_id, v_r.reserved_at, v_r.duration_min, 0, v_r.id) THEN
      RAISE EXCEPTION 'table_busy';
    END IF;
  END IF;

  BEGIN
    UPDATE reservations
    SET status = 'confirmed',
        table_id = COALESCE(p_table_id, table_id),
        decided_by = p_staff_id,
        decided_at = NOW()
    WHERE id = p_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  RETURN json_build_object('reservation_id', p_id, 'duplicate', FALSE);
END $$;

REVOKE EXECUTE ON FUNCTION accept_reservation FROM anon, public;

REVOKE EXECUTE ON FUNCTION _table_free, _pick_tables FROM anon, public;
