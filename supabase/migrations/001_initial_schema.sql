-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- STAFF
-- ============================================================
CREATE TABLE staff (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('waiter', 'manager', 'kitchen')),
  pin_code   TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLES (restaurant tables)
-- ============================================================
CREATE TABLE tables (
  id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  number   INTEGER NOT NULL UNIQUE,
  capacity INTEGER NOT NULL DEFAULT 4,
  status   TEXT NOT NULL DEFAULT 'free'
             CHECK (status IN ('free', 'occupied', 'reserved', 'waiting_bill')),
  zone     TEXT
);

-- ============================================================
-- MENU CATEGORIES
-- ============================================================
CREATE TABLE menu_categories (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============================================================
-- MENU ITEMS
-- ============================================================
CREATE TABLE menu_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id   UUID NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  price         NUMERIC(10,2) NOT NULL,
  description   TEXT,
  image_url     TEXT,
  is_available  BOOLEAN NOT NULL DEFAULT TRUE,
  prep_time_min INTEGER NOT NULL DEFAULT 15
);

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE orders (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_id   UUID NOT NULL REFERENCES tables(id),
  waiter_id  UUID NOT NULL REFERENCES staff(id),
  status     TEXT NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'cooking', 'ready', 'paid')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  total      NUMERIC(10,2) NOT NULL DEFAULT 0
);

-- ============================================================
-- ORDER ITEMS
-- ============================================================
CREATE TABLE order_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id),
  qty          INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  price        NUMERIC(10,2) NOT NULL,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'cooking', 'ready', 'served'))
);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE payments (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id   UUID NOT NULL REFERENCES orders(id),
  method     TEXT NOT NULL CHECK (method IN ('cash', 'card', 'split')),
  amount     NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SHIFTS
-- ============================================================
CREATE TABLE shifts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id      UUID NOT NULL REFERENCES staff(id),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  total_revenue NUMERIC(10,2) NOT NULL DEFAULT 0
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_orders_table_id   ON orders(table_id);
CREATE INDEX idx_orders_waiter_id  ON orders(waiter_id);
CREATE INDEX idx_orders_status     ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_menu_items_cat    ON menu_items(category_id);
CREATE INDEX idx_payments_order    ON payments(order_id);

-- ============================================================
-- REALTIME (enable for key tables)
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE tables;
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE order_items;

-- ============================================================
-- FUNCTION: auto-update order total
-- ============================================================
CREATE OR REPLACE FUNCTION update_order_total()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE orders
  SET total = (
    SELECT COALESCE(SUM(price * qty), 0)
    FROM order_items
    WHERE order_id = COALESCE(NEW.order_id, OLD.order_id)
  )
  WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_total
AFTER INSERT OR UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION update_order_total();

-- ============================================================
-- FUNCTION: update table status based on orders
-- ============================================================
CREATE OR REPLACE FUNCTION update_table_status()
RETURNS TRIGGER AS $$
DECLARE
  v_table_id UUID;
BEGIN
  v_table_id := COALESCE(NEW.table_id, OLD.table_id);

  UPDATE tables SET status =
    CASE
      WHEN EXISTS (
        SELECT 1 FROM orders
        WHERE table_id = v_table_id AND status IN ('new', 'cooking', 'ready')
      ) THEN 'occupied'
      ELSE 'free'
    END
  WHERE id = v_table_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_table_status
AFTER INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION update_table_status();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- We use a custom approach: store staff_id in a session variable
-- set via SELECT set_config('app.current_staff_id', ?, false)
-- and staff role in 'app.current_staff_role'

ALTER TABLE staff        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables       ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts       ENABLE ROW LEVEL SECURITY;

-- Helper function to get current staff role
CREATE OR REPLACE FUNCTION current_staff_role()
RETURNS TEXT AS $$
  SELECT COALESCE(current_setting('app.current_staff_role', TRUE), '')
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_staff_id()
RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_staff_id', TRUE), '')::UUID
$$ LANGUAGE sql STABLE;

-- Staff: anyone can read (for PIN login), only manager can write
CREATE POLICY "staff_read_all"   ON staff FOR SELECT USING (TRUE);
CREATE POLICY "staff_write_mgr"  ON staff FOR ALL
  USING (current_staff_role() = 'manager');

-- Tables: all authenticated staff can read; managers can write
CREATE POLICY "tables_read_all"  ON tables FOR SELECT USING (TRUE);
CREATE POLICY "tables_write"     ON tables FOR ALL
  USING (current_staff_role() IN ('manager', 'waiter', 'kitchen'));

-- Menu: all can read; managers can write
CREATE POLICY "menu_cat_read"    ON menu_categories FOR SELECT USING (TRUE);
CREATE POLICY "menu_cat_write"   ON menu_categories FOR ALL
  USING (current_staff_role() = 'manager');
CREATE POLICY "menu_item_read"   ON menu_items FOR SELECT USING (TRUE);
CREATE POLICY "menu_item_write"  ON menu_items FOR ALL
  USING (current_staff_role() = 'manager');

-- Orders: waiters see only their own; managers and kitchen see all
CREATE POLICY "orders_select"    ON orders FOR SELECT
  USING (
    current_staff_role() IN ('manager', 'kitchen')
    OR waiter_id = current_staff_id()
  );
CREATE POLICY "orders_insert"    ON orders FOR INSERT
  WITH CHECK (waiter_id = current_staff_id() OR current_staff_role() = 'manager');
CREATE POLICY "orders_update"    ON orders FOR UPDATE
  USING (
    current_staff_role() IN ('manager', 'kitchen')
    OR waiter_id = current_staff_id()
  );

-- Order items: same logic as orders (via join)
CREATE POLICY "order_items_select" ON order_items FOR SELECT
  USING (
    current_staff_role() IN ('manager', 'kitchen')
    OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = order_items.order_id
        AND (o.waiter_id = current_staff_id() OR current_staff_role() = 'manager')
    )
  );
CREATE POLICY "order_items_write" ON order_items FOR ALL
  USING (
    current_staff_role() IN ('manager', 'kitchen')
    OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = order_items.order_id AND o.waiter_id = current_staff_id()
    )
  );

-- Payments: waiters see payments for their orders; managers see all
CREATE POLICY "payments_select" ON payments FOR SELECT
  USING (
    current_staff_role() = 'manager'
    OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = payments.order_id AND o.waiter_id = current_staff_id()
    )
  );
CREATE POLICY "payments_insert" ON payments FOR INSERT
  WITH CHECK (
    current_staff_role() = 'manager'
    OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = payments.order_id AND o.waiter_id = current_staff_id()
    )
  );

-- Shifts: managers can see all; staff see their own
CREATE POLICY "shifts_select" ON shifts FOR SELECT
  USING (
    current_staff_role() = 'manager' OR staff_id = current_staff_id()
  );
CREATE POLICY "shifts_write" ON shifts FOR ALL
  USING (current_staff_role() = 'manager');
