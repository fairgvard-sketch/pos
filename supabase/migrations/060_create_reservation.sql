-- ============================================================
-- 060 CREATE RESERVATION — ручная бронь на кассе (телефонный звонок).
--
-- Дополняет публичную бронь (053): кассир/хостес заводит бронь сам,
-- когда клиент позвонил. Прямой INSERT в reservations сотруднику
-- закрыт (RLS 053: INSERT только через service_role RPC), поэтому —
-- отдельная SECURITY DEFINER функция.
--
--   * Статус сразу 'confirmed' (бронь вводит сотрудник — подтверждать
--     нечего), decided_by/decided_at = кто и когда завёл.
--   * client_uuid генерируется (колонка NOT NULL UNIQUE); гостю он не
--     нужен — статус ручной брони на сайте не поллят.
--   * Стол опционален (как и у accept_reservation): можно назначить
--     сразу или позже через set_reservation_table.
--   * Часы приёма (059) для ручной брони НЕ enforced — у сотрудника
--     есть право завести бронь на любое время (частное мероприятие и т.п.).
--   * Телефон опционален (walk-in без номера): NULL → пустая строка.
-- ============================================================
CREATE OR REPLACE FUNCTION create_reservation(
  p_location_id UUID,
  p_staff_id    UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_reserved_at TIMESTAMPTZ,
  p_note        TEXT DEFAULT NULL,
  p_table_id    UUID DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_name  TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note  TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_id    UUID;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  -- Точка принадлежит организации
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = p_location_id AND org_id = v_org) THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > 20 THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_reserved_at IS NULL THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;

  -- Стол (если указан) — наш, этой точки, активный
  IF p_table_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tables
    WHERE id = p_table_id AND org_id = v_org
      AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid table';
  END IF;

  INSERT INTO reservations (org_id, location_id, client_uuid, customer_name, customer_phone,
                            party_size, reserved_at, note, table_id,
                            status, decided_by, decided_at)
  VALUES (v_org, p_location_id, gen_random_uuid(), v_name, v_phone,
          p_party_size, p_reserved_at, v_note, p_table_id,
          'confirmed', p_staff_id, NOW())
  RETURNING id INTO v_id;

  RETURN json_build_object('reservation_id', v_id);
END $$;

REVOKE EXECUTE ON FUNCTION create_reservation FROM anon, public;
