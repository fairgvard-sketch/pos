-- Atomic point update to avoid race conditions
CREATE OR REPLACE FUNCTION update_guest_points(
  p_guest_id UUID,
  p_earned   INTEGER,
  p_spent    INTEGER
)
RETURNS VOID AS $$
BEGIN
  UPDATE guests
  SET
    points = GREATEST(0, points + p_earned - p_spent),
    visits = visits + 1
  WHERE id = p_guest_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
