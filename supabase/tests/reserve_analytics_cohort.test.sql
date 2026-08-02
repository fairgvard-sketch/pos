-- pgTAP: точная когорта воронки из миграции 134.

BEGIN;
SELECT plan(15);

INSERT INTO orgs (id, name) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'pgTAP cohort A'),
  ('f0000000-0000-4000-8000-000000000002', 'pgTAP cohort B');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('f1000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', 'Cohort A', 'Asia/Jerusalem'),
  ('f1000000-0000-4000-8000-000000000002',
   'f0000000-0000-4000-8000-000000000002', 'Cohort B', 'Asia/Jerusalem');

INSERT INTO organization_products (org_id, product) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'reservations'),
  ('f0000000-0000-4000-8000-000000000002', 'reservations');

INSERT INTO auth.users (id) VALUES
  ('f2000000-0000-4000-8000-000000000001');
INSERT INTO organization_members
  (id, org_id, auth_user_id, role, is_active)
VALUES
  ('f3000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001',
   'f2000000-0000-4000-8000-000000000001', 'owner', TRUE);

-- Семь независимых сессий, каждая впервые наблюдается на своём шаге.
-- Точная когорта должна стать 7/6/3/2/1, а не клиентские 1/1/1/1/1.
INSERT INTO reservation_funnel_events
  (org_id, location_id, session_id, step, source, wanted_date, party_size, at)
VALUES
  ('f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f4000000-0000-4000-8000-000000000001', 'page_view', 'direct', NULL, NULL, NOW()),
  ('f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f4000000-0000-4000-8000-000000000002', 'availability', 'direct', CURRENT_DATE, 2, NOW()),
  -- Повтор availability той же сессии для другой даты не раздувает когорту.
  ('f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f4000000-0000-4000-8000-000000000002', 'availability', 'direct', CURRENT_DATE + 1, 2, NOW()),
  ('f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f4000000-0000-4000-8000-000000000003', 'slot_selected', 'direct', CURRENT_DATE, 2, NOW()),
  ('f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f4000000-0000-4000-8000-000000000004', 'form_started', 'direct', NULL, NULL, NOW()),
  ('f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f4000000-0000-4000-8000-000000000005', 'submitted', 'direct', CURRENT_DATE, 2, NOW()),
  ('f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f4000000-0000-4000-8000-000000000006', 'no_slots', 'direct', CURRENT_DATE, 6, NOW()),
  ('f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f4000000-0000-4000-8000-000000000007', 'waitlisted', 'direct', CURRENT_DATE, 4, NOW()),
  -- За периодом — не входит.
  ('f0000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001',
   'f4000000-0000-4000-8000-000000000008', 'submitted', 'direct', CURRENT_DATE - 2, 2,
   NOW() - INTERVAL '2 days'),
  -- Чужая организация — не входит даже в общий вызов NULL.
  ('f0000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002',
   'f4000000-0000-4000-8000-000000000009', 'submitted', 'direct', CURRENT_DATE, 2, NOW());

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f2000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"f0000000-0000-4000-8000-000000000001"}}',
  true
);

CREATE FUNCTION pg_temp.cohort_report() RETURNS JSON LANGUAGE sql STABLE AS $$
  SELECT reserve_analytics_web(
    NULL,
    (NOW() AT TIME ZONE 'Asia/Jerusalem')::date,
    (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
  )
$$;

SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'calculation_version')::INT, 2,
  'ответ помечен точной серверной версией');
SELECT is(pg_temp.cohort_report() -> 'funnel' ->> 'cohort',
  'observed_session_max_step', 'контракт когорты назван явно');
SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'page_view')::INT, 7,
  'вершина включает все семь наблюдавшихся сессий');
SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'availability')::INT, 6,
  'availability включает поздние шаги и не считает повтор дважды');
SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'slot_selected')::INT, 3,
  'slot_selected включает slot/form/submitted');
SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'form_started')::INT, 2,
  'form_started включает form/submitted');
SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'submitted')::INT, 1,
  'submitted считает одну сессию');
SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'dead_ends')::INT, 1,
  'no_slots остаётся отдельной ветвью');
SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'waitlisted')::INT, 1,
  'waitlisted остаётся отдельной ветвью');
SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'conversion')::NUMERIC, 14.3,
  'конверсия использует общую когорту');
SELECT is((pg_temp.cohort_report() -> 'funnel' ->> 'form_conversion')::NUMERIC, 50.0,
  'конверсия формы использует вложенные этапы');
SELECT ok(
  (pg_temp.cohort_report() -> 'funnel' ->> 'page_view')::INT >=
  (pg_temp.cohort_report() -> 'funnel' ->> 'availability')::INT AND
  (pg_temp.cohort_report() -> 'funnel' ->> 'availability')::INT >=
  (pg_temp.cohort_report() -> 'funnel' ->> 'slot_selected')::INT AND
  (pg_temp.cohort_report() -> 'funnel' ->> 'slot_selected')::INT >=
  (pg_temp.cohort_report() -> 'funnel' ->> 'form_started')::INT AND
  (pg_temp.cohort_report() -> 'funnel' ->> 'form_started')::INT >=
  (pg_temp.cohort_report() -> 'funnel' ->> 'submitted')::INT,
  'основные шаги монотонны');

SELECT is(
  (reserve_analytics_web(
    ARRAY['f1000000-0000-4000-8000-000000000002']::UUID[],
    (NOW() AT TIME ZONE 'Asia/Jerusalem')::date,
    (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
  ) -> 'funnel' ->> 'page_view')::INT,
  0, 'явно запрошенная чужая точка остаётся пустой');

SELECT ok(
  has_function_privilege(
    'authenticated', 'reserve_analytics_web(uuid[],date,date)', 'EXECUTE'),
  'новая RPC доступна веб-владельцу');
SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'reserve_analytics_web_v1_133(uuid[],date,date)', 'EXECUTE'),
  'внутренняя старая реализация закрыта от клиента');

SELECT * FROM finish();
ROLLBACK;
