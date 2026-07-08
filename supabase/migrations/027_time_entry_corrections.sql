-- ============================================================
-- 027 TIME ENTRY CORRECTIONS — правки табеля менеджером.
--
-- Сотрудник забыл отметиться (вход/выход) → менеджер добавляет
-- смену задним числом или исправляет время существующей.
--
-- Принципы:
--   * Записи по-прежнему не удаляются физически: «удаление» =
--     deleted_at (мягкое), правка помечается edited_by/edited_at —
--     видно, что вносилось вручную (аудит-инвариант, как 022).
--   * Роль менеджера enforced на клиенте (тот же компромисс, что
--     у create_staff), но RPC дополнительно сверяет, что p_actor_id —
--     активный manager/owner этой организации.
--   * Частичный уникальный индекс «одна открытая смена» теперь
--     игнорирует удалённые записи, иначе мягко удалённая открытая
--     смена навсегда блокировала бы clock_in сотрудника.
-- ============================================================

ALTER TABLE time_entries
  ADD COLUMN edited_by  UUID REFERENCES staff(id),
  ADD COLUMN edited_at  TIMESTAMPTZ,
  ADD COLUMN deleted_at TIMESTAMPTZ;

DROP INDEX idx_one_open_entry;
CREATE UNIQUE INDEX idx_one_open_entry ON time_entries (staff_id)
  WHERE clock_out IS NULL AND deleted_at IS NULL;

-- ── Проверка: p_actor_id — активный manager/owner этой org ──
CREATE OR REPLACE FUNCTION assert_timesheet_manager(p_actor_id UUID, p_org UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM staff
    WHERE id = p_actor_id AND org_id = p_org AND is_active
      AND role IN ('owner', 'manager')
  ) THEN
    RAISE EXCEPTION 'manager role required';
  END IF;
END $$;

-- ============================================================
-- RPC: save_time_entry — добавить смену задним числом (p_entry_id
-- IS NULL) или исправить время существующей. p_clock_out IS NULL =
-- смена остаётся открытой (уникальный индекс страхует от второй).
-- ============================================================
CREATE OR REPLACE FUNCTION save_time_entry(
  p_entry_id  UUID,
  p_staff_id  UUID,
  p_clock_in  TIMESTAMPTZ,
  p_clock_out TIMESTAMPTZ,
  p_actor_id  UUID,
  p_note      TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
  v_id  UUID;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM assert_timesheet_manager(p_actor_id, v_org);

  IF p_clock_in IS NULL OR p_clock_in > NOW() THEN
    RAISE EXCEPTION 'invalid clock_in';
  END IF;
  IF p_clock_out IS NOT NULL AND p_clock_out <= p_clock_in THEN
    RAISE EXCEPTION 'clock_out must be after clock_in';
  END IF;

  IF p_entry_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org) THEN
      RAISE EXCEPTION 'invalid staff';
    END IF;
    INSERT INTO time_entries (org_id, location_id, staff_id, clock_in, clock_out,
                              note, edited_by, edited_at)
    VALUES (v_org, v_loc, p_staff_id, p_clock_in, p_clock_out,
            NULLIF(TRIM(p_note), ''), p_actor_id, NOW())
    RETURNING id INTO v_id;
  ELSE
    UPDATE time_entries
    SET clock_in = p_clock_in, clock_out = p_clock_out,
        note = NULLIF(TRIM(p_note), ''), edited_by = p_actor_id, edited_at = NOW()
    WHERE id = p_entry_id AND org_id = v_org AND deleted_at IS NULL
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'entry not found';
    END IF;
  END IF;

  RETURN json_build_object('entry_id', v_id);
END $$;

-- ============================================================
-- RPC: delete_time_entry — мягкое удаление ошибочной записи
-- ============================================================
CREATE OR REPLACE FUNCTION delete_time_entry(p_entry_id UUID, p_actor_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  PERFORM assert_timesheet_manager(p_actor_id, v_org);

  UPDATE time_entries
  SET deleted_at = NOW(), edited_by = p_actor_id, edited_at = NOW()
  WHERE id = p_entry_id AND org_id = v_org AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry not found';
  END IF;
END $$;

-- ============================================================
-- Существующие RPC: игнорировать удалённые записи
-- ============================================================
CREATE OR REPLACE FUNCTION clock_in(p_staff_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
  v_loc UUID := auth_location_id();
  v_id  UUID;
BEGIN
  IF v_org IS NULL OR v_loc IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_staff_id AND org_id = v_org AND is_active) THEN
    RAISE EXCEPTION 'invalid staff';
  END IF;
  IF EXISTS (SELECT 1 FROM time_entries
             WHERE staff_id = p_staff_id AND clock_out IS NULL AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'workday already open';
  END IF;

  INSERT INTO time_entries (org_id, location_id, staff_id)
  VALUES (v_org, v_loc, p_staff_id)
  RETURNING id INTO v_id;

  RETURN json_build_object('entry_id', v_id);
END $$;

CREATE OR REPLACE FUNCTION clock_out(p_staff_id UUID, p_note TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_entry time_entries%ROWTYPE;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_entry FROM time_entries
  WHERE staff_id = p_staff_id AND org_id = v_org
    AND clock_out IS NULL AND deleted_at IS NULL
  ORDER BY clock_in DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open workday';
  END IF;

  UPDATE time_entries
  SET clock_out = NOW(), note = NULLIF(TRIM(p_note), '')
  WHERE id = v_entry.id
  RETURNING * INTO v_entry;

  RETURN json_build_object(
    'entry_id',    v_entry.id,
    'clock_in',    v_entry.clock_in,
    'clock_out',   v_entry.clock_out,
    'seconds',     EXTRACT(EPOCH FROM (v_entry.clock_out - v_entry.clock_in))::INTEGER
  );
END $$;

CREATE OR REPLACE FUNCTION open_time_entry(p_staff_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_entry time_entries%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM time_entries
  WHERE staff_id = p_staff_id AND org_id = v_org
    AND clock_out IS NULL AND deleted_at IS NULL
  ORDER BY clock_in DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN row_to_json(v_entry);
END $$;

-- Отчёт: без удалённых, + note/edited_at для UI (пометка «исправлено»)
CREATE OR REPLACE FUNCTION time_entries_report(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org UUID := auth_org_id();
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN json_build_object(
    'entries', COALESCE((
      SELECT json_agg(row_to_json(e) ORDER BY e.clock_in DESC)
      FROM (
        SELECT te.id, te.staff_id, s.name AS staff_name, s.role AS staff_role,
               te.clock_in, te.clock_out, te.note, te.edited_at,
               CASE WHEN te.clock_out IS NULL THEN NULL
                    ELSE EXTRACT(EPOCH FROM (te.clock_out - te.clock_in))::INTEGER END AS seconds
        FROM time_entries te
        JOIN staff s ON s.id = te.staff_id
        WHERE te.org_id = v_org AND te.clock_in >= p_from AND te.clock_in < p_to
          AND te.deleted_at IS NULL
      ) e
    ), '[]'::json),
    'totals', COALESCE((
      SELECT json_agg(row_to_json(t) ORDER BY t.name)
      FROM (
        SELECT s.id AS staff_id, s.name,
               COALESCE(SUM(
                 EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in))
               ), 0)::INTEGER AS seconds,
               bool_or(te.clock_out IS NULL) AS on_shift
        FROM time_entries te
        JOIN staff s ON s.id = te.staff_id
        WHERE te.org_id = v_org AND te.clock_in >= p_from AND te.clock_in < p_to
          AND te.deleted_at IS NULL
        GROUP BY s.id, s.name
      ) t
    ), '[]'::json)
  );
END $$;

REVOKE EXECUTE ON FUNCTION
  save_time_entry, delete_time_entry, assert_timesheet_manager
FROM anon, public;
