-- ============================================================
-- 136 RESERVATION ORIGIN — каким путём заведён визит.
--
-- МОТИВ. Владельцу нужно видеть, откуда берутся брони: гость сам с
-- сайта, звонок, принятый хостес в кабинете, посадка на кассе или
-- согласие из листа ожидания. Это три-четыре разных потока, и по их
-- соотношению принимаются решения про смены и рекламу.
--
-- ПОЧЕМУ НЕ `source`. Колонка `reservations.source` уже занята другим
-- смыслом: это КАНАЛ ПРИВОДА гостя (124) — qr, table, site, instagram,
-- google… Его проставляет воронка по метке в ссылке. Класть туда же
-- «pos» или «public» значит смешать «откуда гость узнал» с «кто нажал
-- кнопку»: отчёт по каналам получил бы фантомный канал, а отчёт по
-- путям — дыры в тех бронях, где гость пришёл по рекламной ссылке.
--
-- Ровно эта ошибка уже случилась в 127: ручная бронь кабинета пишет
-- source='backoffice', и в отчёте каналов рядом с instagram и qr стоит
-- «backoffice». Здесь это исправлено — кабинет заполняет путь, а канал
-- оставляет пустым, потому что канала у телефонного звонка нет.
--
-- ЧТО ЗДЕСЬ. Новая колонка `created_via` и пять функций, которые её
-- заполняют. Сигнатуры НЕ меняются: значение постоянно для каждого
-- пути, поэтому параметр не нужен, а выложенные клиенты (касса на T2,
-- гостевая страница, кабинет) продолжают работать без обновления.
--
--   submit_reservation            (118) → 'public'     гость сам
--   create_reservation            (119) → 'pos'        касса, по PIN
--   accept_waitlist_offer         (122) → 'waitlist'   принятое предложение
--   create_test_reservation_web   (126) → 'backoffice' проверка перед запуском
--   create_reservation_web        (127) → 'backoffice' хостес в кабинете
--
-- Тела скопированы дословно из перечисленных миграций — изменён ТОЛЬКО
-- список колонок INSERT. Так требует forward-only: старые миграции не
-- редактируются, а частично изменить тело функции PostgreSQL не умеет.
--
-- ИСТОРИЧЕСКИЕ ДАННЫЕ НЕ ПЕРЕПИСЫВАЮТСЯ. У броней до этой миграции
-- `created_via` остаётся NULL, и это честно: путь никто не записывал, а
-- догадка задним числом («есть decided_by — значит касса») превратила
-- бы пробел в выдуманный факт, на который потом сошлётся отчёт.
-- Исключение не делается и для старых 'backoffice' в `source`: чинить
-- их означало бы переписывать историю двух разных отчётов сразу.
--
-- ⚠️ ТРЕБУЕТ 118, 119, 122, 124 (source/utm), 126, 127.
-- ============================================================

-- ── Колонка пути ─────────────────────────────────────────────
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS created_via TEXT;

-- Перечень закрыт: опечатка в будущем пути («website» вместо 'public')
-- не сломает запрос, но тихо заведёт пятый поток в отчётах. NULL
-- разрешён — это брони до 136.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_created_via_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_created_via_check
  CHECK (created_via IS NULL
         OR created_via IN ('public', 'pos', 'backoffice', 'waitlist'));

-- Отчёт по путям смотрит «точка + период», как и отчёт по каналам
CREATE INDEX IF NOT EXISTS idx_reservations_created_via
  ON reservations(location_id, created_via, reserved_at) WHERE created_via IS NOT NULL;

COMMENT ON COLUMN reservations.created_via IS
  'Каким путём заведён визит (136): public — гость сам, pos — касса, backoffice — кабинет, waitlist — принятое предложение. NULL — до 136. НЕ путать с source: там канал привода гостя (124).';

-- ── 1. Гостевая страница (118) ───────────────────────────────

CREATE OR REPLACE FUNCTION submit_reservation(
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
  v_sch      JSONB;
  v_existing reservations%ROWTYPE;
  v_name     TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone    TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note     TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
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
  v_token    UUID;
BEGIN
  -- Идемпотентность
  SELECT * INTO v_existing FROM reservations WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('reservation_id', v_existing.id, 'duplicate', TRUE,
                             'status', v_existing.status,
                             'public_token', v_existing.public_token);
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  IF NOT org_has_capability(v_loc.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
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

  v_sch := reservation_schedule(v_loc.settings);
  IF p_reserved_at IS NULL
     OR p_reserved_at < NOW() + make_interval(mins => (v_sch ->> 'lead_min')::INTEGER)
     OR p_reserved_at > NOW() + make_interval(days => (v_sch ->> 'horizon_days')::INTEGER) THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  IF NOT reservation_bookable_at(v_loc.settings, v_loc.timezone, p_reserved_at) THEN
    RAISE EXCEPTION 'outside_hours';
  END IF;

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

  IF COALESCE((v_rsv ->> 'deposit_required')::BOOLEAN, FALSE)
     AND p_party_size >= COALESCE((v_rsv ->> 'deposit_from_party')::INTEGER, 1) THEN
    v_dep_amt := GREATEST(0, COALESCE((v_rsv ->> 'deposit_amount')::INTEGER, 0));
    IF v_dep_amt > 0 THEN
      v_dep_st := 'required';
    END IF;
  END IF;

  IF v_instant THEN
    v_tables := _pick_tables(p_location_id, p_party_size, p_reserved_at, v_dur,
                             v_buffer, v_combine, NULL, p_zone_id);
    IF array_length(v_tables, 1) IS NULL THEN
      RAISE EXCEPTION 'full_slot';
    END IF;
    v_table  := v_tables[1];
    v_hold   := v_tables[2:array_length(v_tables, 1)];
    v_status := 'confirmed';
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, note, duration_min, table_id, hold_table_ids,
      auto, status, decided_at, deposit_amount, deposit_status, zone_id, created_via)
    VALUES (
      v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
      p_party_size, p_reserved_at, v_note, v_dur, v_table, COALESCE(v_hold, '{}'),
      v_instant, v_status, CASE WHEN v_instant THEN NOW() END, v_dep_amt, v_dep_st,
      p_zone_id, 'public')
    RETURNING id, public_token INTO v_id, v_token;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'full_slot';
  END;

  RETURN json_build_object(
    'reservation_id', v_id,
    'duplicate', FALSE,
    'status', v_status,
    'public_token', v_token,
    'deposit_status', v_dep_st,
    'deposit_amount', v_dep_amt
  );
END $$;

-- ── 2. Касса: ручная бронь по PIN (119) ──────────────────────

CREATE OR REPLACE FUNCTION create_reservation(
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
      status, decided_by, decided_at, created_via)
    VALUES (v_org, p_location_id, gen_random_uuid(), v_name, v_phone,
            p_party_size, p_reserved_at, v_note, p_table_id, p_zone_id, v_dur,
            'confirmed', p_staff_id, NOW(), 'pos')
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  RETURN json_build_object('reservation_id', v_id);
END $$;

-- ── 3. Гость принял предложение из листа ожидания (122) ──────

CREATE OR REPLACE FUNCTION accept_waitlist_offer(p_token UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_w      waitlist_entries%ROWTYPE;
  v_loc    locations%ROWTYPE;
  v_rsv    JSONB;
  v_dur    INTEGER;
  v_buf    INTEGER;
  v_comb   BOOLEAN;
  v_inst   BOOLEAN;
  v_zone   UUID;
  v_tables UUID[];
  v_table  UUID := NULL;
  v_hold   UUID[] := '{}';
  v_status TEXT := 'new';
  v_id     UUID;
  v_token  UUID;
BEGIN
  SELECT * INTO v_w FROM waitlist_entries WHERE offer_token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT org_has_capability(v_w.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  IF v_w.status <> 'offered' OR v_w.offer_expires < NOW() THEN
    RAISE EXCEPTION 'offer_expired';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = v_w.location_id;
  v_rsv  := v_loc.settings -> 'reservations';
  v_dur  := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buf  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);
  v_comb := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_inst := COALESCE((v_rsv ->> 'instant')::BOOLEAN, FALSE);
  v_zone := CASE WHEN cardinality(v_w.zone_ids) = 1 THEN v_w.zone_ids[1] END;

  -- Время всё ещё в часах работы?
  IF NOT reservation_bookable_at(v_loc.settings, v_loc.timezone, v_w.offer_at) THEN
    RAISE EXCEPTION 'outside_hours';
  END IF;

  IF v_inst THEN
    v_tables := _pick_tables(v_w.location_id, v_w.party_size, v_w.offer_at,
                             v_dur, v_buf, v_comb, NULL, v_zone);
    IF array_length(v_tables, 1) IS NULL THEN
      -- Слот увели, пока гость думал. Запись возвращается в очередь:
      -- человек не виноват и место в ней не теряет.
      UPDATE waitlist_entries
      SET status = 'waiting', offer_token = NULL, offer_at = NULL, offer_expires = NULL
      WHERE id = v_w.id;
      RAISE EXCEPTION 'full_slot';
    END IF;
    v_table  := v_tables[1];
    v_hold   := v_tables[2:array_length(v_tables, 1)];
    v_status := 'confirmed';
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, note, duration_min, table_id, hold_table_ids,
      auto, status, decided_at, zone_id, created_via)
    VALUES (
      v_w.org_id, v_w.location_id, gen_random_uuid(), v_w.customer_name,
      v_w.customer_phone, v_w.party_size, v_w.offer_at, v_w.note, v_dur,
      v_table, COALESCE(v_hold, '{}'), v_inst, v_status,
      CASE WHEN v_inst THEN NOW() END, v_zone, 'waitlist')
    RETURNING id, public_token INTO v_id, v_token;
  EXCEPTION WHEN exclusion_violation THEN
    UPDATE waitlist_entries
    SET status = 'waiting', offer_token = NULL, offer_at = NULL, offer_expires = NULL
    WHERE id = v_w.id;
    RAISE EXCEPTION 'full_slot';
  END;

  UPDATE waitlist_entries
  SET status = 'converted', reservation_id = v_id, offer_token = NULL
  WHERE id = v_w.id;

  RETURN json_build_object(
    'reservation_id', v_id, 'public_token', v_token, 'status', v_status);
END $$;

-- ── 4. Тестовая бронь перед запуском (126) ───────────────────

CREATE OR REPLACE FUNCTION create_test_reservation_web(
  p_location_id UUID,
  p_at          TIMESTAMPTZ DEFAULT NULL,
  p_party_size  INTEGER DEFAULT 2
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_rsv    JSONB;
  v_at     TIMESTAMPTZ := COALESCE(p_at, date_trunc('hour', NOW()) + INTERVAL '2 hours');
  v_party  INTEGER := GREATEST(1, LEAST(COALESCE(p_party_size, 2), 20));
  v_dur    INTEGER;
  v_buffer INTEGER;
  v_combine BOOLEAN;
  v_tables UUID[];
  v_id     UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tables
    WHERE location_id = p_location_id AND org_id = v_org AND is_active
  ) THEN
    RAISE EXCEPTION 'no_tables';
  END IF;

  SELECT COALESCE(settings -> 'reservations', '{}'::jsonb) INTO v_rsv
  FROM locations WHERE id = p_location_id AND org_id = v_org;

  v_dur     := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);

  v_tables := _pick_tables(p_location_id, v_party, v_at, v_dur, v_buffer,
                           v_combine, NULL, NULL);
  IF array_length(v_tables, 1) IS NULL THEN
    RAISE EXCEPTION 'full_slot';
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, duration_min, table_id, hold_table_ids,
      status, auto, decided_at, decided_by_member, is_test, note, created_via)
    VALUES (
      v_org, p_location_id, gen_random_uuid(), 'Тестовая бронь', '0500000000',
      v_party, v_at, v_dur, v_tables[1],
      COALESCE(v_tables[2:array_length(v_tables, 1)], '{}'::UUID[]),
      'confirmed', TRUE, NOW(), v_member, TRUE,
      'Проверка перед запуском — отмените её, когда посмотрите таймлайн.', 'backoffice')
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'full_slot';
  END;

  RETURN json_build_object('reservation_id', v_id, 'reserved_at', v_at,
                           'table_id', v_tables[1]);
END $$;

-- ── 5. Хостес в кабинете (127) ───────────────────────────────
-- Здесь же исправлено засорение канала привода: раньше эта функция
-- писала source='backoffice', и «backoffice» вставал в отчёте рядом с
-- instagram и qr. Телефонный звонок каналом привода не является —
-- канал остаётся пустым, а путь называет `created_via`.

CREATE OR REPLACE FUNCTION create_reservation_web(
  p_location_id UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_at          TIMESTAMPTZ DEFAULT NULL,
  p_note        TEXT DEFAULT NULL,
  p_table_ids   UUID[] DEFAULT NULL,
  p_walk_in     BOOLEAN DEFAULT FALSE
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member  UUID := _reservation_web_member(p_location_id);
  v_org     UUID := auth_org_id();
  v_rsv     JSONB;
  v_at      TIMESTAMPTZ;
  v_party   INTEGER := GREATEST(1, LEAST(COALESCE(p_party_size, 2), 50));
  v_name    TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_phone   TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note    TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_dur     INTEGER;
  v_buffer  INTEGER;
  v_combine BOOLEAN;
  v_tables  UUID[] := COALESCE(p_table_ids, '{}');
  v_table   UUID;
  v_id      UUID;
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'name_required';
  END IF;

  SELECT COALESCE(settings -> 'reservations', '{}'::jsonb) INTO v_rsv
  FROM locations WHERE id = p_location_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  v_dur     := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_at      := CASE WHEN p_walk_in THEN NOW() ELSE COALESCE(p_at, NOW()) END;

  IF array_length(v_tables, 1) IS NULL THEN
    -- Стола не назвали — подбираем сам. Пусто = сажать некуда.
    v_tables := _pick_tables(p_location_id, v_party, v_at, v_dur, v_buffer,
                             v_combine, NULL, NULL);
    IF array_length(v_tables, 1) IS NULL THEN
      RAISE EXCEPTION 'full_slot';
    END IF;
  ELSE
    FOREACH v_table IN ARRAY v_tables LOOP
      IF NOT EXISTS (
        SELECT 1 FROM tables
        WHERE id = v_table AND org_id = v_org
          AND location_id = p_location_id AND is_active
      ) THEN
        RAISE EXCEPTION 'invalid table';
      END IF;
      IF NOT _table_free(v_table, v_at, v_dur, v_buffer, NULL) THEN
        RAISE EXCEPTION 'table_busy';
      END IF;
    END LOOP;
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, duration_min, table_id, hold_table_ids,
      status, auto, decided_at, decided_by_member, note, arrived_at, created_via)
    VALUES (
      v_org, p_location_id, gen_random_uuid(), v_name,
      COALESCE(NULLIF(v_phone, ''), ''),
      v_party, v_at, v_dur, v_tables[1],
      COALESCE(v_tables[2:array_length(v_tables, 1)], '{}'::UUID[]),
      'confirmed', FALSE, NOW(), v_member, v_note,
      CASE WHEN p_walk_in THEN NOW() ELSE NULL END, 'backoffice')
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  RETURN json_build_object(
    'reservation_id', v_id, 'reserved_at', v_at,
    'table_id', v_tables[1], 'duration_min', v_dur);
END $$;

-- ── Права ────────────────────────────────────────────────────
-- CREATE OR REPLACE сохраняет привилегии существующей функции, но
-- повторяем их дословно: миграция должна быть самодостаточной, а не
-- зависеть от того, что до неё кто-то что-то выдал. Пропущенный REVOKE
-- здесь означал бы EXECUTE для PUBLIC на функции, создающей брони.
REVOKE ALL ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID)
  TO service_role;

REVOKE ALL ON FUNCTION create_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, UUID, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, UUID, INTEGER)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION accept_waitlist_offer(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accept_waitlist_offer(UUID) TO service_role;

REVOKE ALL ON FUNCTION create_test_reservation_web(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_test_reservation_web(UUID, TIMESTAMPTZ, INTEGER) TO authenticated;

REVOKE ALL ON FUNCTION create_reservation_web(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID[], BOOLEAN)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_reservation_web(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID[], BOOLEAN)
  TO authenticated;

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only. Данные не трогаются: миграция меняет только то, что
-- пишется ВПЕРЁД. Понадобится вернуть прежнее поведение — новая
-- миграция переопределяет те же функции без `created_via`; снимать
-- ограничение при этом не нужно, оно допускает NULL.
--
-- Проверка на целевой базе:
--   SELECT COALESCE(created_via, 'not recorded') AS via, COUNT(*)
--   FROM reservations GROUP BY 1 ORDER BY 2 DESC;
-- ============================================================
