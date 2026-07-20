-- pgTAP: веб-идентичности бэкофиса (088).
--
-- Проверяется то, на что полагается ANGLE back office: доступ определяется
-- членством в organization_members, org берётся из JWT (а не из браузера),
-- и чужая организация не видна ни через таблицу, ни через RPC.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(15);

SELECT has_table('organization_members');
SELECT has_column('organization_members', 'auth_user_id');
SELECT has_column('organization_members', 'role');
SELECT has_column('organization_members', 'is_active');

SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'organization_members'),
  true,
  'RLS включён на organization_members'
);

SELECT has_function('get_backoffice_context');
SELECT ok(
  has_function_privilege('authenticated', 'get_backoffice_context()', 'EXECUTE'),
  'authenticated может вызвать get_backoffice_context'
);
SELECT ok(
  NOT has_function_privilege('anon', 'get_backoffice_context()', 'EXECUTE'),
  'anon не вызывает get_backoffice_context'
);
SELECT ok(
  NOT has_function_privilege('anon', 'auth_backoffice_role()', 'EXECUTE'),
  'anon не вызывает auth_backoffice_role'
);

-- Бэкофис — только веб-идентичности владельцев; PIN сотрудника здесь недопустим
SELECT hasnt_column('organization_members', 'pin_hash');

INSERT INTO orgs (id, name) VALUES
  ('40000000-0000-4000-8000-000000000001', 'Org A'),
  ('40000000-0000-4000-8000-000000000002', 'Org B');

INSERT INTO locations (id, org_id, name) VALUES
  ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Loc A'),
  ('41000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 'Loc B');

INSERT INTO auth.users (id) VALUES
  ('42000000-0000-4000-8000-000000000001'),  -- владелец Org A
  ('42000000-0000-4000-8000-000000000002'),  -- деактивированный член Org A
  ('42000000-0000-4000-8000-000000000003'),  -- владелец Org B
  ('42000000-0000-4000-8000-000000000004');  -- аккаунт без членства

INSERT INTO organization_members (org_id, auth_user_id, role, display_name, is_active) VALUES
  ('40000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', 'owner', 'Owner A', TRUE),
  ('40000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000002', 'manager', 'Ex manager A', FALSE),
  ('40000000-0000-4000-8000-000000000002', '42000000-0000-4000-8000-000000000003', 'owner', 'Owner B', TRUE);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"42000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"40000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT results_eq(
  $$ SELECT display_name FROM organization_members ORDER BY display_name $$,
  $$ VALUES ('Ex manager A'::text), ('Owner A'::text) $$,
  'владелец видит членства своей организации и не видит Org B'
);

SELECT is(
  (SELECT (get_backoffice_context() -> 'organization' ->> 'name')),
  'Org A',
  'контекст бэкофиса отдаёт организацию из JWT'
);

SELECT is(
  (SELECT (get_backoffice_context() -> 'counts' ->> 'locations')::int),
  1,
  'счётчики считают только точки своей организации'
);

-- Деактивированное членство не даёт доступа, даже если org_id в JWT верный
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"42000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"40000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$ SELECT get_backoffice_context() $$,
  'P0001', 'backoffice access denied',
  'деактивированное членство не открывает бэкофис'
);

-- Аккаунт без членства (например, устройство чужой организации) отсекается
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"42000000-0000-4000-8000-000000000004","role":"authenticated","app_metadata":{"org_id":"40000000-0000-4000-8000-000000000002"}}',
  true
);

SELECT throws_ok(
  $$ SELECT get_backoffice_context() $$,
  'P0001', 'backoffice access denied',
  'аккаунт без членства не открывает бэкофис'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
