-- ============================================================
-- 062 RESERVATION MAX PARTY — лимит гостей на бронь (настройка владельца).
--
-- Дополняет публичную бронь (053/059): владелец задаёт максимум гостей
-- в одной брони (locations.settings.reservations.max_party, целое 1..50).
-- Не задано / вне диапазона → дефолт 20 (прежнее поведение). Гостевая
-- страница ограничивает селект этим числом; сервер — последняя проверка,
-- код 'invalid_party' при превышении.
--
-- Пересоздаём submit_reservation с той же 7-арг сигнатурой (CREATE OR
-- REPLACE) — тело копия 059 + чтение лимита из настроек. Применять
-- ПОСЛЕ 059/060.
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
  v_loc       locations%ROWTYPE;
  v_existing  reservations%ROWTYPE;
  v_name      TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone     TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note      TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_open      TEXT;
  v_close     TEXT;
  v_local     TIME;
  v_max_party INTEGER;
  v_id        UUID;
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

  -- Лимит гостей (061): настройка владельца, дефолт 20, потолок 50
  v_max_party := COALESCE(
    NULLIF((v_loc.settings -> 'reservations' ->> 'max_party'), '')::INTEGER, 20);
  IF v_max_party < 1 OR v_max_party > 50 THEN
    v_max_party := 20;
  END IF;
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > v_max_party THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;

  IF p_reserved_at IS NULL
     OR p_reserved_at < NOW() + INTERVAL '30 minutes'
     OR p_reserved_at > NOW() + INTERVAL '30 days' THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;

  -- Часы приёма (059): обе границы заданы → время визита в локальной
  -- зоне точки должно попадать в [open, close]. Иначе 'outside_hours'.
  v_open  := NULLIF(v_loc.settings -> 'reservations' ->> 'open', '');
  v_close := NULLIF(v_loc.settings -> 'reservations' ->> 'close', '');
  IF v_open IS NOT NULL AND v_close IS NOT NULL THEN
    v_local := (p_reserved_at AT TIME ZONE v_loc.timezone)::time;
    IF v_local < v_open::time OR v_local > v_close::time THEN
      RAISE EXCEPTION 'outside_hours';
    END IF;
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
