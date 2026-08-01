-- pgTAP: чеклист запуска, предпросмотр и тестовая бронь (126).
--
-- Проверяется то, ради чего это сделано: чеклист считает по ДАННЫМ, а не
-- по галочкам владельца; секрет предпросмотра нельзя подобрать; тестовая
-- бронь настоящая, но из отчёта исключена.

BEGIN;
SELECT plan(15);

INSERT INTO orgs (id, name) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'pgTAP launch A');
INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('f1000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', 'Launch loc', 'Asia/Jerusalem');
INSERT INTO organization_products (org_id, product) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'reservations');
INSERT INTO auth.users (id) VALUES ('f4000000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('f5000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001',
   'owner', TRUE);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"f0000000-0000-4000-8000-000000000001"}}',
  true
);

CREATE FUNCTION pg_temp.step(p_key TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$
  SELECT (s ->> 'done')::BOOLEAN
  FROM json_array_elements(
    reserve_launch_checklist_web('f1000000-0000-4000-8000-000000000001') -> 'steps') s
  WHERE s ->> 'key' = p_key
$$;

-- ── Пустая точка ─────────────────────────────────────────────
SELECT ok(NOT pg_temp.step('tables'), 'пустой зал — шаг не выполнен');
SELECT ok(NOT pg_temp.step('schedule'), 'расписание не задано');
SELECT ok(NOT pg_temp.step('test_booking'), 'тестовой брони ещё не было');
SELECT is(
  (reserve_launch_checklist_web('f1000000-0000-4000-8000-000000000001') ->> 'ready')::BOOLEAN,
  FALSE, 'точка не готова к публикации');

-- Тестовая бронь без столов невозможна — и это ошибка по делу.
SELECT throws_ok(
  $$SELECT create_test_reservation_web('f1000000-0000-4000-8000-000000000001')$$,
  'no_tables',
  'без столов тестовую бронь не поставить');

-- ── Настраиваем точку ────────────────────────────────────────
RESET ROLE;
INSERT INTO tables (id, org_id, location_id, label, seats, sort_order) VALUES
  ('f2000000-0000-4000-8000-000000000001',
   'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', '1', 4, 0);

UPDATE locations SET
  receipt_business_name = 'Пекарня',
  receipt_phone = '036000000',
  settings = jsonb_build_object('reservations', jsonb_build_object(
    'enabled', FALSE,
    'policy', 'Отмена не позже чем за два часа',
    'schedule', jsonb_build_object(
      'weekly', (SELECT jsonb_object_agg(i::TEXT, '[["10:00","22:00"]]'::jsonb)
                 FROM generate_series(0, 6) i),
      'exceptions', '{}'::jsonb)))
WHERE id = 'f1000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"f0000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT ok(pg_temp.step('tables'), 'стол заведён — шаг закрыт');
SELECT ok(pg_temp.step('schedule'), 'явное недельное расписание засчитано');
SELECT ok(pg_temp.step('policy'), 'правила отмены написаны');
SELECT ok(pg_temp.step('branding'), 'имя и телефон — этого достаточно гостю');
SELECT ok(NOT pg_temp.step('link'), 'короткий адрес ещё не занят');

-- ── Предпросмотр ─────────────────────────────────────────────
CREATE FUNCTION pg_temp.token() RETURNS TEXT LANGUAGE sql AS $$
  SELECT reserve_preview_token_web('f1000000-0000-4000-8000-000000000001')
$$;

SELECT is(pg_temp.token(), pg_temp.token(),
  'повторный запрос отдаёт тот же секрет, а не плодит новые');

RESET ROLE;  -- проверка секрета доступна только серверу
SELECT ok(
  reserve_preview_valid('f1000000-0000-4000-8000-000000000001',
    (SELECT settings -> 'reservations' ->> 'preview_token'
     FROM locations WHERE id = 'f1000000-0000-4000-8000-000000000001')),
  'верный секрет открывает предпросмотр');
SELECT ok(
  NOT reserve_preview_valid('f1000000-0000-4000-8000-000000000001', 'short'),
  'короткая строка секретом не считается, даже если совпала бы');

-- ── Тестовая бронь ───────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"f0000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT lives_ok(
  $$SELECT create_test_reservation_web('f1000000-0000-4000-8000-000000000001',
      (CURRENT_DATE + TIME '19:00') AT TIME ZONE 'Asia/Jerusalem')$$,
  'тестовая бронь ставится при выключенном приёме — в этом её смысл');

-- Настоящая (занимает стол и видна хостес), но в отчёт не попадает.
SELECT is(
  (reserve_analytics_web(NULL, CURRENT_DATE, CURRENT_DATE) -> 'visits' ->> 'total')::INT,
  0,
  'тестовая бронь не портит отчёт');

SELECT * FROM finish();
ROLLBACK;
