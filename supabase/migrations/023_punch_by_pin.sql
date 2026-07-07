-- ============================================================
-- 023 PUNCH BY PIN — отметка в табеле по личному PIN сотрудника.
--
-- Табель работает как терминал отметки: сотрудник вводит свой PIN,
-- сервер сам сверяет bcrypt-хеш, определяет сотрудника и переключает
-- статус (clock-in ⇄ clock-out). PIN не покидает БД, staff_id клиенту
-- знать не нужно — отметить чужой день нельзя (требуется именно личный PIN).
--
-- Заменяет прежний clock_in/clock_out по p_staff_id с клиента (те
-- остаются для внутреннего использования, но UI теперь ходит сюда).
-- ============================================================
CREATE OR REPLACE FUNCTION punch_by_pin(p_pin TEXT)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_loc   UUID := auth_location_id();
  v_staff staff%ROWTYPE;
  v_open  time_entries%ROWTYPE;
  v_id    UUID;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Идентификация по PIN (та же логика, что verify_staff_pin)
  SELECT * INTO v_staff
  FROM staff s
  WHERE s.org_id = v_org
    AND s.is_active
    AND (s.location_id IS NULL OR s.location_id = v_loc)
    AND s.pin_hash = crypt(p_pin, s.pin_hash);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wrong pin';
  END IF;

  -- Есть открытый день → закрываем (clock-out)
  SELECT * INTO v_open FROM time_entries
  WHERE staff_id = v_staff.id AND clock_out IS NULL
  ORDER BY clock_in DESC LIMIT 1;

  IF FOUND THEN
    UPDATE time_entries SET clock_out = NOW()
    WHERE id = v_open.id
    RETURNING * INTO v_open;
    RETURN json_build_object(
      'action',     'out',
      'staff_name', v_staff.name,
      'clock_in',   v_open.clock_in,
      'clock_out',  v_open.clock_out,
      'seconds',    EXTRACT(EPOCH FROM (v_open.clock_out - v_open.clock_in))::INTEGER
    );
  END IF;

  -- Иначе открываем новый день (clock-in)
  INSERT INTO time_entries (org_id, location_id, staff_id)
  VALUES (v_org, v_loc, v_staff.id)
  RETURNING id INTO v_id;

  RETURN json_build_object(
    'action',     'in',
    'staff_name', v_staff.name,
    'entry_id',   v_id
  );
END $$;

REVOKE EXECUTE ON FUNCTION punch_by_pin FROM anon, public;
