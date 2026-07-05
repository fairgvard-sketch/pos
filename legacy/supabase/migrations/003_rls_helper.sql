-- Helper RPC function called after PIN login to set session context for RLS.
-- This is called by the frontend via supabase.rpc('set_staff_context', {...})
-- Note: set_config with is_local=false persists for the connection, but Supabase
-- uses connection pooling, so this is fine for request-scoped usage.

CREATE OR REPLACE FUNCTION set_staff_context(p_staff_id UUID, p_staff_role TEXT)
RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.current_staff_id', p_staff_id::TEXT, FALSE);
  PERFORM set_config('app.current_staff_role', p_staff_role, FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to anonymous/authenticated roles
GRANT EXECUTE ON FUNCTION set_staff_context(UUID, TEXT) TO anon, authenticated;
