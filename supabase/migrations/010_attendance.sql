-- Staff clock-in/clock-out events
CREATE TABLE staff_clock_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id   UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('clock_in', 'clock_out')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fetching per-day events quickly
CREATE INDEX idx_clock_events_staff_date ON staff_clock_events (staff_id, created_at DESC);

-- Opening cash declaration on shift
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS opening_cash NUMERIC(10,2) NOT NULL DEFAULT 0;

-- RLS: same pattern as the rest of the app — authenticated via session variable
ALTER TABLE staff_clock_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_clock_events_all" ON staff_clock_events
  USING (current_staff_role() IN ('manager', 'waiter', 'kitchen'))
  WITH CHECK (current_staff_role() IN ('manager', 'waiter', 'kitchen'));
