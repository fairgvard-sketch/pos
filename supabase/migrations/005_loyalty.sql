-- ============================================================
-- LOYALTY: гости и история визитов
-- ============================================================

CREATE TABLE guests (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,
  points     INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  visits     INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE guest_visits (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  guest_id    UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  earned      INTEGER NOT NULL DEFAULT 0,
  spent       INTEGER NOT NULL DEFAULT 0,
  total_paid  NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_guest_visits_guest ON guest_visits(guest_id);
CREATE INDEX idx_guests_phone ON guests(phone);

-- RLS
ALTER TABLE guests       ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "guests_read"  ON guests FOR SELECT USING (TRUE);
CREATE POLICY "guests_write" ON guests FOR ALL
  USING (current_staff_role() IN ('manager', 'waiter'));

CREATE POLICY "guest_visits_read"  ON guest_visits FOR SELECT USING (TRUE);
CREATE POLICY "guest_visits_write" ON guest_visits FOR ALL
  USING (current_staff_role() IN ('manager', 'waiter'));

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE guests;
