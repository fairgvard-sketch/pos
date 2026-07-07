-- ============================================================
-- 022 TIME ENTRIES — табель учёта рабочего времени сотрудников.
--
-- Принципы:
--   * Табель НЕЗАВИСИМ от кассовой смены (shifts). Это учёт часов
--     человека для зарплаты, а не денежный сеанс кассы.
--   * Один открытый рабочий день на сотрудника (partial unique index).
--   * Запись не удаляется. Завершение дня = UPDATE clock_out,
--     не DELETE (аудит-инвариант, как у shifts/payments).
--   * Модель авторизации: БД доверяет устройству (JWT), персональная
--     роль сотрудника enforced на клиенте — тот же компромисс, что
--     у create_staff. RPC принимают p_staff_id, скоуп по org/location.
-- ============================================================

CREATE TABLE time_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES locations(id),
  staff_id     UUID NOT NULL REFERENCES staff(id),
  clock_in     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clock_out    TIMESTAMPTZ,                       -- NULL = ещё на смене
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Один открытый рабочий день на сотрудника (страхует гонку clock_in)
CREATE UNIQUE INDEX idx_one_open_entry ON time_entries (staff_id) WHERE clock_out IS NULL;
CREATE INDEX idx_time_entries_org   ON time_entries(org_id);
CREATE INDEX idx_time_entries_staff ON time_entries(staff_id);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY time_entries_select ON time_entries FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

-- Запись — только через RPC
REVOKE INSERT, UPDATE, DELETE ON time_entries FROM authenticated;

-- ============================================================
-- RPC: clock_in — начать рабочий день сотрудника
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
  IF EXISTS (SELECT 1 FROM time_entries WHERE staff_id = p_staff_id AND clock_out IS NULL) THEN
    RAISE EXCEPTION 'workday already open';
  END IF;

  INSERT INTO time_entries (org_id, location_id, staff_id)
  VALUES (v_org, v_loc, p_staff_id)
  RETURNING id INTO v_id;

  RETURN json_build_object('entry_id', v_id);
END $$;

-- ============================================================
-- RPC: clock_out — завершить рабочий день сотрудника
-- ============================================================
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
  WHERE staff_id = p_staff_id AND org_id = v_org AND clock_out IS NULL
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

-- ============================================================
-- RPC: open_time_entry — текущая открытая запись сотрудника (или NULL)
-- Для PIN-флоу: узнать статус сразу после verify_staff_pin.
-- ============================================================
CREATE OR REPLACE FUNCTION open_time_entry(p_staff_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_entry time_entries%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM time_entries
  WHERE staff_id = p_staff_id AND org_id = v_org AND clock_out IS NULL
  ORDER BY clock_in DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN row_to_json(v_entry);
END $$;

-- ============================================================
-- RPC: time_entries_report — записи за период + сумма часов на человека
-- Скоуп по org. Возвращает { entries: [...], totals: [{staff_id, name, seconds}] }
-- ============================================================
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
               te.clock_in, te.clock_out, te.note,
               CASE WHEN te.clock_out IS NULL THEN NULL
                    ELSE EXTRACT(EPOCH FROM (te.clock_out - te.clock_in))::INTEGER END AS seconds
        FROM time_entries te
        JOIN staff s ON s.id = te.staff_id
        WHERE te.org_id = v_org AND te.clock_in >= p_from AND te.clock_in < p_to
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
        GROUP BY s.id, s.name
      ) t
    ), '[]'::json)
  );
END $$;

REVOKE EXECUTE ON FUNCTION clock_in, clock_out, open_time_entry, time_entries_report FROM anon, public;
