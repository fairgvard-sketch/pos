-- ============================================================
-- 072 RESERVATION ZONES — бронь по зонам зала (066) на публичной
-- странице.
--
-- Гость выбирает зону («בפנים» / «בחוץ»), если у точки их две и
-- больше. Зона — ПОЖЕЛАНИЕ гостя: в обычном режиме касса видит его
-- бейджем и решает сама; в instant-режиме подбор стола (_pick_tables)
-- ограничивается выбранной зоной, и доступность слотов считается
-- по ней же. Без выбора (NULL) поведение прежнее — вся точка.
--
--   1. reservations.zone_id — FK на table_zones в скоупе точки.
--      Зоны не удаляются физически (delete_table_zone — soft),
--      поэтому имя зоны для показа резолвится по id без снапшота.
--   2. _pick_tables / reservation_availability / submit_reservation
--      получают p_zone_id (DEFAULT NULL). CREATE OR REPLACE не может
--      добавить параметр (создаст перегрузку и неоднозначность RPC),
--      поэтому старые сигнатуры дропаются и создаются заново.
--   3. get_reservation_status отдаёт zone_name — гость видит
--      выбранную зону в статусе брони.
--   4. Попутный фикс бага 063: цикл слотов `WHILE v_t <= v_close`
--      по TIME зацикливался навсегда при close >= 23:45 (дефолт!) —
--      '23:45'::time + 15 мин заворачивается в '00:00', условие
--      снова истинно. Итерация переведена на минуты от полуночи.
-- ============================================================

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS zone_id UUID;

-- Составной FK: зона обязана принадлежать той же org и точке, что и
-- бронь (MATCH SIMPLE: NULL zone_id = без предпочтения, не проверяется).
ALTER TABLE reservations
  ADD CONSTRAINT reservations_zone_fk
  FOREIGN KEY (zone_id, org_id, location_id)
  REFERENCES table_zones(id, org_id, location_id);

-- ── _pick_tables v2: подбор в пределах зоны ──────────────────
DROP FUNCTION IF EXISTS _pick_tables(UUID, INTEGER, TIMESTAMPTZ, INTEGER, INTEGER, BOOLEAN, UUID);

CREATE FUNCTION _pick_tables(
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

  -- 2) Жадно набираем combinable-столы, пока не наберём вместимость
  FOR v_id, v_seats IN
    SELECT t.id, t.seats
    FROM tables t
    WHERE t.location_id = p_location_id AND t.is_active AND t.combinable
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

-- ── reservation_availability v2: сетка слотов в пределах зоны ─
DROP FUNCTION IF EXISTS reservation_availability(UUID, DATE, INTEGER);

CREATE FUNCTION reservation_availability(
  p_location_id UUID,
  p_date        DATE,
  p_party       INTEGER,
  p_zone_id     UUID DEFAULT NULL
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
  v_m        INTEGER;
  v_to       INTEGER;
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
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  v_open    := COALESCE(NULLIF(v_rsv ->> 'open', '')::TIME, v_open);
  v_close   := COALESCE(NULLIF(v_rsv ->> 'close', '')::TIME, v_close);
  v_step    := GREATEST(5, COALESCE((v_rsv ->> 'slot_min')::INTEGER, v_step));
  v_dur      := COALESCE((v_rsv ->> 'duration_min')::INTEGER, v_dur);
  v_buffer   := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, v_buffer);
  v_combine  := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);

  -- Итерация по минутам от полуночи, НЕ по TIME: TIME заворачивается через
  -- полночь ('23:45' + 15 мин = '00:00'), и `WHILE v_t <= v_close` при
  -- close >= 23:45 не завершался никогда (баг 063).
  v_m  := EXTRACT(HOUR FROM v_open)::int * 60 + EXTRACT(MINUTE FROM v_open)::int;
  v_to := EXTRACT(HOUR FROM v_close)::int * 60 + EXTRACT(MINUTE FROM v_close)::int;
  WHILE v_m <= v_to LOOP
    v_t := make_time(v_m / 60, v_m % 60, 0);
    -- Локальное время слота → момент в UTC для сравнения с бронями
    v_at := (p_date + v_t) AT TIME ZONE v_tz;
    IF v_at >= v_min_at THEN
      v_free := array_length(
        _pick_tables(p_location_id, p_party, v_at, v_dur, v_buffer, v_combine, NULL, p_zone_id), 1
      ) IS NOT NULL;
      v_slots := v_slots || jsonb_build_object(
        'time', to_char(v_t, 'HH24:MI'),
        'free', v_free
      );
    END IF;
    v_m := v_m + v_step;
  END LOOP;

  RETURN json_build_object(
    'date', p_date,
    'slot_min', v_step,
    'slots', v_slots
  );
END $$;

-- ── submit_reservation v3: зона гостя ────────────────────────
DROP FUNCTION IF EXISTS submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT);

CREATE FUNCTION submit_reservation(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_reserved_at TIMESTAMPTZ,
  p_note        TEXT DEFAULT NULL,
  p_zone_id     UUID DEFAULT NULL
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
  -- Зона (072): пожелание гостя; обязана быть живой зоной этой точки
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
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
    -- Подбор стола(ов) под окно визита — в выбранной зоне, если задана
    v_tables := _pick_tables(p_location_id, p_party_size, p_reserved_at, v_dur,
                             v_buffer, v_combine, NULL, p_zone_id);
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
      auto, status, decided_at, deposit_amount, deposit_status, zone_id)
    VALUES (
      v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
      p_party_size, p_reserved_at, v_note, v_dur, v_table, COALESCE(v_hold, '{}'),
      v_instant, v_status, CASE WHEN v_instant THEN NOW() END, v_dep_amt, v_dep_st,
      p_zone_id)
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

-- ── get_reservation_status: + zone_name для гостя ────────────
CREATE OR REPLACE FUNCTION get_reservation_status(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r reservations%ROWTYPE;
  v_table_label TEXT;
  v_zone_name   TEXT;
BEGIN
  SELECT * INTO v_r FROM reservations WHERE client_uuid = p_client_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.table_id IS NOT NULL THEN
    SELECT label INTO v_table_label FROM tables WHERE id = v_r.table_id;
  END IF;
  IF v_r.zone_id IS NOT NULL THEN
    SELECT name INTO v_zone_name FROM table_zones WHERE id = v_r.zone_id;
  END IF;
  RETURN json_build_object(
    'status',        v_r.status,          -- new | confirmed | rejected | cancelled
    'reject_reason', v_r.reject_reason,
    'reserved_at',   v_r.reserved_at,
    'party_size',    v_r.party_size,
    'customer_name', v_r.customer_name,
    'table_label',   v_table_label,
    'zone_name',     v_zone_name,
    'created_at',    v_r.created_at
  );
END $$;

-- ── Гранты: пересозданные функции теряют старые, а на новых стеках
-- (hardened defaults, 070) EXECUTE не выдаётся никому автоматически.
-- На legacy production наоборот — выдаётся PUBLIC, поэтому REVOKE явный.
REVOKE ALL ON FUNCTION _pick_tables(UUID, INTEGER, TIMESTAMPTZ, INTEGER, INTEGER, BOOLEAN, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _pick_tables(UUID, INTEGER, TIMESTAMPTZ, INTEGER, INTEGER, BOOLEAN, UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION reservation_availability(UUID, DATE, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reservation_availability(UUID, DATE, INTEGER, UUID) TO service_role;

REVOKE ALL ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID) TO service_role;

REVOKE ALL ON FUNCTION get_reservation_status(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_reservation_status(UUID) TO service_role;
