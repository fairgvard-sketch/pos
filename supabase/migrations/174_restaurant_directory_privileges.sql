-- 174: keep directory publishing operator-controlled.
--
-- Some environments carry broad authenticated table defaults. The catalogue
-- profile is readable by its organization through RLS, but publishing and
-- editorial fields must remain service/operator-only until a dedicated RPC
-- with role checks is introduced.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON restaurant_directory_profiles
  FROM authenticated;

GRANT SELECT ON restaurant_directory_profiles TO authenticated;
