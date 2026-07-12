-- ============================================================
-- 053 RESERVATIONS — бронирование столов с сайта (v1).
--
-- Модель (по образцу онлайн-заказов 050/051):
--   * Анонимный гость НЕ трогает таблицы напрямую. Его бронь —
--     заявка в reservations; пишет туда только Edge Function
--     public-reserve через service_role → submit_reservation.
--   * Касса видит заявку (realtime) и решает: подтвердить
--     (опционально сразу назначив стол) / отклонить с причиной.
--     Гость поллит статус по своему client_uuid и может отменить.
--   * Открытая смена НЕ требуется ни для заявки, ни для решения:
--     бронь обычно на будущую дату. Вместо «часов приёма» —
--     окно времени (NOW()+30 мин … NOW()+30 дней).
--   * Тумблер: locations.settings->'reservations'->>'enabled'.
--     ОТСУТСТВИЕ ключа = ВЫКЛЮЧЕНО (в отличие от online_orders):
--     фича требует режима столов, точки не должны молча начать
--     получать заявки.
--   * Статусы только вперёд: new → confirmed | rejected | cancelled.
--     confirmed → rejected (касса отменяет по звонку гостя) и
--     confirmed → cancelled (гость сам). Прошедшие брони скрывает
--     клиент фильтром по reserved_at — статус expired не нужен.
--   * tables.status не трогаем: подсветка «скоро бронь» на плане
--     зала вычисляется клиентом из confirmed-броней.
-- ============================================================

CREATE TABLE reservations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id),
  client_uuid    UUID NOT NULL UNIQUE,            -- идемпотентность + секрет гостя
  customer_name  TEXT NOT NULL,
  customer_phone TEXT NOT NULL,                   -- только цифры
  party_size     INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 20),
  reserved_at    TIMESTAMPTZ NOT NULL,            -- дата и время визита
  note           TEXT,
  table_id       UUID REFERENCES tables(id),      -- NULL = стол не назначен
  status         TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'confirmed', 'rejected', 'cancelled')),
  reject_reason  TEXT,
  decided_by     UUID REFERENCES staff(id),
  decided_at     TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,                     -- отмена гостем (аудит)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reservations_loc_status ON reservations(location_id, status);
CREATE INDEX idx_reservations_loc_time   ON reservations(location_id, reserved_at);
CREATE INDEX idx_reservations_phone      ON reservations(customer_phone, created_at);

-- Realtime: касса подписана (звонок «новая бронь» / «гость отменил»)
ALTER PUBLICATION supabase_realtime ADD TABLE reservations;

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

-- Чтение — устройства своей организации; запись — только через RPC
CREATE POLICY reservations_select ON reservations FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

REVOKE INSERT, UPDATE, DELETE ON reservations FROM authenticated;
REVOKE ALL ON reservations FROM anon;

-- ============================================================
-- RPC: submit_reservation — заявка на бронь с сайта.
-- Вызывает ТОЛЬКО Edge Function под service_role.
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
  v_existing reservations%ROWTYPE;
  v_name     TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone    TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note     TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_id       UUID;
BEGIN
  -- Идемпотентность: повтор POST с тем же client_uuid → та же заявка
  SELECT * INTO v_existing FROM reservations WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('reservation_id', v_existing.id, 'duplicate', TRUE);
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  -- Тумблер: отсутствие ключа = ВЫКЛЮЧЕНО
  IF NOT COALESCE((v_loc.settings -> 'reservations' ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > 20 THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_reserved_at IS NULL
     OR p_reserved_at < NOW() + INTERVAL '30 minutes'
     OR p_reserved_at > NOW() + INTERVAL '30 days' THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;

  -- Анти-спам: ≤3 заявок с телефона за 15 минут; ≤30 необработанных на точку
  IF (SELECT COUNT(*) FROM reservations
      WHERE customer_phone = v_phone AND created_at > NOW() - INTERVAL '15 minutes') >= 3 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT COUNT(*) FROM reservations
      WHERE location_id = p_location_id AND status = 'new') >= 30 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  INSERT INTO reservations (org_id, location_id, client_uuid, customer_name, customer_phone,
                            party_size, reserved_at, note)
  VALUES (v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
          p_party_size, p_reserved_at, v_note)
  RETURNING id INTO v_id;

  RETURN json_build_object('reservation_id', v_id, 'duplicate', FALSE);
END $$;

REVOKE ALL ON FUNCTION submit_reservation FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_reservation TO service_role;

-- ============================================================
-- RPC: get_reservation_status — поллинг статуса гостем.
-- client_uuid знает только гость. Только через Edge Function.
-- ============================================================
CREATE OR REPLACE FUNCTION get_reservation_status(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r reservations%ROWTYPE;
  v_table_label TEXT;
BEGIN
  SELECT * INTO v_r FROM reservations WHERE client_uuid = p_client_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.table_id IS NOT NULL THEN
    SELECT label INTO v_table_label FROM tables WHERE id = v_r.table_id;
  END IF;
  RETURN json_build_object(
    'status',        v_r.status,          -- new | confirmed | rejected | cancelled
    'reject_reason', v_r.reject_reason,
    'reserved_at',   v_r.reserved_at,
    'party_size',    v_r.party_size,
    'customer_name', v_r.customer_name,
    'table_label',   v_table_label,
    'created_at',    v_r.created_at
  );
END $$;

REVOKE ALL ON FUNCTION get_reservation_status FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_reservation_status TO service_role;

-- ============================================================
-- RPC: cancel_reservation — гость отменяет свою бронь.
-- Идемпотентен: повторная отмена — no-op. Отклонённую бронь
-- не трогаем (решение кассы финально), просто возвращаем статус.
-- ============================================================
CREATE OR REPLACE FUNCTION cancel_reservation(p_client_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_r FROM reservations WHERE client_uuid = p_client_uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_r.status IN ('new', 'confirmed') THEN
    UPDATE reservations
    SET status = 'cancelled', cancelled_at = NOW()
    WHERE id = v_r.id;
    RETURN json_build_object('status', 'cancelled');
  END IF;

  RETURN json_build_object('status', v_r.status);
END $$;

REVOKE ALL ON FUNCTION cancel_reservation FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cancel_reservation TO service_role;

-- ============================================================
-- RPC: accept_reservation — касса подтверждает бронь,
-- опционально сразу назначая стол. Идемпотентен: повтор по
-- confirmed возвращает duplicate. Конфликты броней по времени
-- НЕ блокируем — кассир видит подсказку и решает сам.
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

  -- Row lock: double-tap / два кассира не решат заявку дважды
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

  IF p_table_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tables
    WHERE id = p_table_id AND org_id = v_org
      AND location_id = v_r.location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid table';
  END IF;

  UPDATE reservations
  SET status = 'confirmed',
      table_id = COALESCE(p_table_id, table_id),
      decided_by = p_staff_id,
      decided_at = NOW()
  WHERE id = p_id;

  RETURN json_build_object('reservation_id', p_id, 'duplicate', FALSE);
END $$;

REVOKE EXECUTE ON FUNCTION accept_reservation FROM anon, public;

-- ============================================================
-- RPC: reject_reservation — касса отклоняет заявку ИЛИ отменяет
-- уже подтверждённую бронь (гость позвонил / форс-мажор).
-- Гость увидит rejected + причину при поллинге.
-- ============================================================
CREATE OR REPLACE FUNCTION reject_reservation(
  p_id       UUID,
  p_staff_id UUID,
  p_reason   TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;

  UPDATE reservations
  SET status = 'rejected',
      reject_reason = NULLIF(TRIM(COALESCE(p_reason, '')), ''),
      decided_by = p_staff_id,
      decided_at = NOW()
  WHERE id = p_id AND org_id = v_org AND status IN ('new', 'confirmed');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found or already decided';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION reject_reservation FROM anon, public;

-- ============================================================
-- RPC: set_reservation_table — назначить/сменить/снять стол
-- у подтверждённой брони. NULL = снять стол.
-- ============================================================
CREATE OR REPLACE FUNCTION set_reservation_table(
  p_id       UUID,
  p_staff_id UUID,
  p_table_id UUID
) RETURNS VOID
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
  IF NOT FOUND OR v_r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'reservation not found or not confirmed';
  END IF;

  IF p_table_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tables
    WHERE id = p_table_id AND org_id = v_org
      AND location_id = v_r.location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid table';
  END IF;

  UPDATE reservations SET table_id = p_table_id WHERE id = p_id;
END $$;

REVOKE EXECUTE ON FUNCTION set_reservation_table FROM anon, public;
