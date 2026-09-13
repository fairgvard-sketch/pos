-- Restore the intended table boundary from 106/144 independently of the
-- environment's default privileges. GRANT SELECT does not revoke a default
-- GRANT ALL. Keep writes behind the existing SECURITY DEFINER RPCs and RLS.
-- No rows, policies, RPC signatures or database-wide defaults are changed.
REVOKE ALL ON TABLE public.drawer_opens, public.location_slugs
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.drawer_opens, public.location_slugs
  TO authenticated;
GRANT ALL ON TABLE public.drawer_opens, public.location_slugs
  TO service_role;
