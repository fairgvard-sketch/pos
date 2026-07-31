-- ============================================================
-- 118 RESERVATION SELF-SERVICE — постоянная ссылка на бронь, перенос
-- и отмена по правилам отсечки.
--
-- МОТИВ. Доступ гостя к собственной брони держался на `client_uuid` в
-- localStorage того браузера, где бронь оформляли: сменил телефон,
-- почистил данные, открыл ссылку в другом приложении — и брони для
-- гостя больше нет. Восстановить её продукт не умел. Перенести время
-- было нельзя вовсе: только отменить и оформить заново, потеряв стол.
-- Каждый такой случай превращался в звонок в заведение.
--
-- ЧТО ДОБАВЛЯЕТСЯ
--   1. reservations.public_token — СЕРВЕРНЫЙ секрет ссылки. Отдельно от
--      client_uuid сознательно: client_uuid генерирует браузер и он же
--      ключ идемпотентности POST. Пускать клиентское значение в
--      долгоживущий URL значит доверить стойкость ссылки чужому ГПСЧ.
--      Токен выдаёт БД, gen_random_uuid поверх pgcrypto.
--   2. reservation_public_view(key) — карточка брони для гостя: статус,
--      время, зона, стол, контакты точки и — главное — СЕРВЕРНЫЙ ответ
--      на «можно ли ещё отменить/перенести». Клиент это только
--      показывает; решение остаётся здесь.
--   3. cancel_reservation v2 — та же сигнатура, но с правилом отсечки.
--   4. reschedule_reservation(key, at, zone) — перенос с полной
--      перепроверкой: расписание 117, окно записи, занятость столов.
--
-- ПРАВИЛА ОТСЕЧКИ (settings.reservations, обе опциональны):
--   cancel_cutoff_min     — за сколько минут до визита закрывается отмена
--   reschedule_cutoff_min — то же для переноса
-- Дефолт 0 = как раньше, до самого времени визита. Отсечка НЕ действует
-- на заявку, которую заведение ещё не подтвердило (status='new'): держать
-- гостя нерешённой заявкой и одновременно запрещать её отменить — нельзя.
--
-- ПЕРЕНОС И РЕЖИМ ПОДТВЕРЖДЕНИЯ
--   * instant-режим: сервер подбирает стол на новое время (исключая саму
--     бронь) и оставляет бронь подтверждённой. Нет мест → 'full_slot',
--     СТАРОЕ время при этом сохраняется — гость не теряет бронь, пытаясь
--     её подвинуть.
--   * обычный режим: подтверждённая бронь после переноса возвращается в
--     'new' и теряет стол. Заведение подтверждало конкретное время, и
--     молча считать согласие на другое нельзя.
--   * бронь, посаженная в POS-заказ (order_id), не переносится и не
--     отменяется из веба — гость уже за столом ('pos_mode', как в 102).
--
-- Число переносов ограничено (RESCHEDULE_LIMIT = 3): иначе одна бронь
-- бесконечно ходит по сетке, вытесняя чужие.
--
-- ⚠️ ТРЕБУЕТ 117 (reservation_bookable_at, reservation_schedule).
-- ============================================================

-- ── 1. Секрет ссылки ─────────────────────────────────────────
-- DEFAULT заполняет и уже существующие строки, поэтому у всех броней
-- ссылка появляется сразу, без отдельного бэкфилла.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS public_token UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS reservations_public_token_key
  ON reservations(public_token);

COMMENT ON COLUMN reservations.public_token IS
  'Серверный секрет постоянной ссылки гостя на бронь (118). Не путать с client_uuid — тот генерирует браузер и он же ключ идемпотентности POST.';

-- Аудит переноса: время до переноса и счётчик. Строку брони не
-- размножаем — это не финансовая запись, но след изменения нужен.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS previous_reserved_at TIMESTAMPTZ;
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ;
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0;

-- ── 2. Хелперы отсечки ───────────────────────────────────────
/**
 * Разрешено ли действие гостя над бронью и почему нет.
 * Возвращает NULL, если можно; иначе стабильный код причины.
 *
 * Порядок проверок = порядок, в котором их поймёт гость: сначала
 * «бронь уже не активна», потом «за неё взялось заведение», потом время.
 */
CREATE OR REPLACE FUNCTION reservation_guest_block(
  p_reservation reservations,
  p_settings    JSONB,
  p_action      TEXT   -- 'cancel' | 'reschedule'
) RETURNS TEXT
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_cutoff INTEGER;
  v_key    TEXT;
BEGIN
  IF p_reservation.status NOT IN ('new', 'confirmed') THEN
    RETURN 'not_active';
  END IF;
  -- Гость уже посажен за стол на кассе — дальше решает заведение.
  IF p_reservation.order_id IS NOT NULL THEN
    RETURN 'pos_mode';
  END IF;

  IF p_action = 'reschedule' THEN
    IF p_reservation.reschedule_count >= 3 THEN
      RETURN 'reschedule_limit';
    END IF;
    v_key := 'reschedule_cutoff_min';
  ELSE
    v_key := 'cancel_cutoff_min';
  END IF;

  -- Нерешённую заявку гость вправе снять всегда: заведение ещё не
  -- приняло обязательства, а держать гостя в подвешенном состоянии,
  -- запрещая отмену, было бы недобросовестно.
  IF p_reservation.status = 'new' THEN
    RETURN NULL;
  END IF;

  v_cutoff := CASE
    WHEN p_settings -> 'reservations' ->> v_key ~ '^\d{1,5}$'
      THEN (p_settings -> 'reservations' ->> v_key)::INTEGER
    ELSE 0
  END;

  IF NOW() > p_reservation.reserved_at - make_interval(mins => v_cutoff) THEN
    RETURN 'too_late';
  END IF;

  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION reservation_guest_block(reservations, JSONB, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservation_guest_block(reservations, JSONB, TEXT)
  TO authenticated, service_role;

-- ── 3. Карточка брони для гостя ──────────────────────────────
/**
 * Всё, что нужно постоянной странице брони, одним запросом.
 * p_key — public_token ИЛИ client_uuid: оба секрета знает только гость,
 * а старые ссылки/localStorage продолжают работать.
 *
 * can_cancel/can_reschedule считает СЕРВЕР. Клиент их только рисует:
 * иначе правила отсечки жили бы в двух местах и разошлись бы — ровно
 * та ошибка, которую 117 разбирал с часами.
 */
CREATE OR REPLACE FUNCTION reservation_public_view(p_key UUID)
RETURNS JSON
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r     reservations%ROWTYPE;
  v_loc   locations%ROWTYPE;
  v_rsv   JSONB;
  v_table TEXT;
  v_zone  TEXT;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE public_token = p_key OR client_uuid = p_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT org_has_capability(v_r.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = v_r.location_id;
  v_rsv := v_loc.settings -> 'reservations';

  IF v_r.table_id IS NOT NULL THEN
    SELECT label INTO v_table FROM tables WHERE id = v_r.table_id;
  END IF;
  IF v_r.zone_id IS NOT NULL THEN
    SELECT name INTO v_zone FROM table_zones WHERE id = v_r.zone_id;
  END IF;

  RETURN json_build_object(
    'status',         v_r.status,
    'reject_reason',  v_r.reject_reason,
    'reserved_at',    v_r.reserved_at,
    'party_size',     v_r.party_size,
    'customer_name',  v_r.customer_name,
    'note',           v_r.note,
    'table_label',    v_table,
    'zone_name',      v_zone,
    'zone_id',        v_r.zone_id,
    'created_at',     v_r.created_at,
    'duration_min',   v_r.duration_min,
    -- Постоянная ссылка: гость может сохранить её или открыть на другом
    -- устройстве. Отдаём всегда, в том числе старым клиентам по client_uuid.
    'public_token',   v_r.public_token,
    'rescheduled',    v_r.reschedule_count > 0,
    'can_cancel',     reservation_guest_block(v_r, v_loc.settings, 'cancel') IS NULL,
    'cancel_block',   reservation_guest_block(v_r, v_loc.settings, 'cancel'),
    'can_reschedule', reservation_guest_block(v_r, v_loc.settings, 'reschedule') IS NULL,
    'reschedule_block', reservation_guest_block(v_r, v_loc.settings, 'reschedule'),
    -- Контакты и адрес: страница брони должна отвечать «как доехать» без
    -- возврата на главный экран заведения.
    'location', json_build_object(
      'id',       v_loc.id,
      'name',     COALESCE(NULLIF(v_rsv ->> 'display_name', ''),
                           NULLIF(v_loc.settings ->> 'display_name', ''),
                           NULLIF(v_loc.receipt_business_name, ''),
                           v_loc.name),
      'address',  COALESCE(NULLIF(v_rsv ->> 'address', ''), v_loc.receipt_address),
      'phone',    v_loc.receipt_phone,
      'lat',      NULLIF(v_rsv ->> 'lat', '')::DOUBLE PRECISION,
      'lng',      NULLIF(v_rsv ->> 'lng', '')::DOUBLE PRECISION,
      'timezone', COALESCE(NULLIF(v_loc.timezone, ''), 'Asia/Jerusalem'),
      'policy',   NULLIF(v_rsv ->> 'policy', '')
    )
  );
END $$;

REVOKE ALL ON FUNCTION reservation_public_view(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reservation_public_view(UUID) TO service_role;

COMMENT ON FUNCTION reservation_public_view(UUID) IS
  'Карточка брони для гостевой страницы по public_token или client_uuid: статус, детали визита, контакты точки и серверный вердикт can_cancel/can_reschedule.';

-- ── 4. Отмена с правилом отсечки ─────────────────────────────
-- Сигнатура прежняя (Edge Function не меняет контракт), но параметр
-- принимает и токен, и client_uuid, а поздняя отмена теперь отклоняется.
CREATE OR REPLACE FUNCTION cancel_reservation(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r     reservations%ROWTYPE;
  v_loc   locations%ROWTYPE;
  v_block TEXT;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE public_token = p_client_uuid OR client_uuid = p_client_uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT org_has_capability(v_r.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  -- Идемпотентность: повторная отмена — не ошибка, а тот же результат.
  IF v_r.status = 'cancelled' THEN
    RETURN json_build_object('status', 'cancelled');
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = v_r.location_id;
  v_block := reservation_guest_block(v_r, v_loc.settings, 'cancel');
  IF v_block IS NOT NULL THEN
    -- 'not_active' оставляем мягким: бронь уже отклонена/завершена,
    -- отменять нечего, и ошибка гостю ничего не объясняет.
    IF v_block = 'not_active' THEN
      RETURN json_build_object('status', v_r.status);
    END IF;
    RAISE EXCEPTION '%', v_block;
  END IF;

  UPDATE reservations
  SET status = 'cancelled', cancelled_at = NOW()
  WHERE id = v_r.id;
  RETURN json_build_object('status', 'cancelled');
END $$;

REVOKE ALL ON FUNCTION cancel_reservation(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cancel_reservation(UUID) TO service_role;

-- ── 5. Перенос ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reschedule_reservation(
  p_key     UUID,
  p_at      TIMESTAMPTZ,
  p_zone_id UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r       reservations%ROWTYPE;
  v_loc     locations%ROWTYPE;
  v_rsv     JSONB;
  v_sch     JSONB;
  v_block   TEXT;
  v_instant BOOLEAN;
  v_combine BOOLEAN;
  v_buffer  INTEGER;
  v_tables  UUID[];
  v_table   UUID := NULL;
  v_hold    UUID[] := '{}';
  v_status  TEXT;
  v_zone    UUID;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE public_token = p_key OR client_uuid = p_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT org_has_capability(v_r.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = v_r.location_id;
  v_rsv := v_loc.settings -> 'reservations';

  IF NOT COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;

  v_block := reservation_guest_block(v_r, v_loc.settings, 'reschedule');
  IF v_block IS NOT NULL THEN
    RAISE EXCEPTION '%', v_block;
  END IF;

  -- Новое время проходит ТОТ ЖЕ путь, что и первичная заявка: окно
  -- записи, расписание 117, живая зона. Клиенту здесь не верят ни в чём.
  v_sch := reservation_schedule(v_loc.settings);
  IF p_at IS NULL
     OR p_at < NOW() + make_interval(mins => (v_sch ->> 'lead_min')::INTEGER)
     OR p_at > NOW() + make_interval(days => (v_sch ->> 'horizon_days')::INTEGER) THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;
  IF NOT reservation_bookable_at(v_loc.settings, v_loc.timezone, p_at) THEN
    RAISE EXCEPTION 'outside_hours';
  END IF;

  -- Зона: не передали — оставляем прежнее пожелание гостя.
  v_zone := COALESCE(p_zone_id, v_r.zone_id);
  IF v_zone IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = v_zone AND location_id = v_r.location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  v_instant := COALESCE((v_rsv ->> 'instant')::BOOLEAN, FALSE);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);

  IF v_instant AND v_r.status = 'confirmed' THEN
    -- Подбор на новое время, игнорируя саму бронь: иначе она мешала бы
    -- себе же занять соседний слот того же стола.
    v_tables := _pick_tables(v_r.location_id, v_r.party_size, p_at,
                             v_r.duration_min, v_buffer, v_combine, v_r.id, v_zone);
    IF array_length(v_tables, 1) IS NULL THEN
      -- Старое время не тронуто: неудачная попытка переноса не должна
      -- стоить гостю уже имеющейся брони.
      RAISE EXCEPTION 'full_slot';
    END IF;
    v_table  := v_tables[1];
    v_hold   := v_tables[2:array_length(v_tables, 1)];
    v_status := 'confirmed';
  ELSE
    -- Обычный режим: заведение подтверждало КОНКРЕТНОЕ время. Новое
    -- время оно должно подтвердить заново, поэтому стол снимаем.
    v_status := 'new';
  END IF;

  BEGIN
    UPDATE reservations
    SET reserved_at          = p_at,
        zone_id              = v_zone,
        table_id             = v_table,
        hold_table_ids       = COALESCE(v_hold, '{}'),
        status               = v_status,
        decided_at           = CASE WHEN v_status = 'confirmed' THEN NOW() END,
        decided_by           = CASE WHEN v_status = 'confirmed' THEN decided_by END,
        previous_reserved_at = v_r.reserved_at,
        rescheduled_at       = NOW(),
        reschedule_count     = v_r.reschedule_count + 1
    WHERE id = v_r.id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'full_slot';
  END;

  RETURN json_build_object(
    'status',       v_status,
    'reserved_at',  p_at,
    'public_token', v_r.public_token
  );
END $$;

REVOKE ALL ON FUNCTION reschedule_reservation(UUID, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reschedule_reservation(UUID, TIMESTAMPTZ, UUID) TO service_role;

COMMENT ON FUNCTION reschedule_reservation(UUID, TIMESTAMPTZ, UUID) IS
  'Перенос брони гостем: правило отсечки, расписание 117, окно записи и повторный подбор стола. Неудача не трогает уже существующее время.';

-- ── 6. submit_reservation: отдаём токен сразу ────────────────
-- Тело 117 дословно; в ответ добавлен public_token, чтобы гость получал
-- постоянную ссылку в момент оформления, а не отдельным запросом.
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
      auto, status, decided_at, deposit_amount, deposit_status, zone_id)
    VALUES (
      v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
      p_party_size, p_reserved_at, v_note, v_dur, v_table, COALESCE(v_hold, '{}'),
      v_instant, v_status, CASE WHEN v_instant THEN NOW() END, v_dep_amt, v_dep_st,
      p_zone_id)
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

REVOKE ALL ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID) TO service_role;

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only, данные не удаляются. Функциональный откат:
--   * отключить самообслуживание, не трогая схему, нельзя тумблером —
--     его сознательно нет: отмена работала и до 118. Чтобы запретить
--     поздние отмены/переносы, задать отсечки:
--       cancel_cutoff_min / reschedule_cutoff_min в settings.reservations;
--   * вернуть прежнее поведение отмены (без отсечки) = выставить обе в 0
--     (это и есть дефолт).
--
-- ПРОВЕРОЧНЫЕ ЗАПРОСЫ:
--   -- у всех броней есть постоянная ссылка (ожидается 0)
--   SELECT COUNT(*) FROM reservations WHERE public_token IS NULL;
--   -- карточка брони гостя
--   SELECT reservation_public_view('<public_token>');
--   -- перенос на завтра 19:00 по времени точки
--   SELECT reschedule_reservation('<public_token>',
--     (CURRENT_DATE + 1 + TIME '19:00') AT TIME ZONE 'Asia/Jerusalem');
-- ============================================================
