-- pgTAP: очередь уведомлений скоупится по организации (147).
--
-- Главное, что здесь доказывается:
--   * постановку в очередь нельзя вызвать снаружи под authenticated —
--     это и была дыра: org_id приходил параметром и не проверялся;
--   * даже при вернувшемся гранте чужой org_id отбивается телом функции;
--   * dedupe_key одной организации не гасит событие другой;
--   * внутренний путь (триггер подтверждённой брони) не сломан — иначе
--     «починка» просто отключила бы уведомления.

BEGIN;
SELECT plan(7);

-- ── Фикстура: две организации с точкой в каждой ──────────────
INSERT INTO orgs (id, name) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'pgTAP notify A'),
  ('c0000000-0000-4000-8000-000000000002', 'pgTAP notify B');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'Notify A', 'Asia/Jerusalem'),
  ('c1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002',
   'Notify B', 'Asia/Jerusalem');

-- ── 1. Грант снят: наружу очередь не пополняют ───────────────
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'enqueue_notification(uuid,uuid,text,text,jsonb,text,text)',
    'EXECUTE'),
  'enqueue_notification недоступна роли authenticated'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'enqueue_notification(uuid,uuid,text,text,jsonb,text,text)',
    'EXECUTE'),
  'service_role ставить в очередь по-прежнему может'
);

-- ── 2. Тело отбивает чужую организацию само ──────────────────
-- Проверяем вторую линию обороны: даже если грант когда-нибудь вернут,
-- org_id из параметра не победит org_id из токена.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"c3000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"c0000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$ SELECT enqueue_notification(
       'c0000000-0000-4000-8000-000000000002',
       'c1000000-0000-4000-8000-000000000002',
       'reservation_confirmed', '0500000000', '{}'::jsonb, 'attack:1') $$,
  'org mismatch',
  'токен org A не ставит уведомление в очередь org B'
);

SELECT lives_ok(
  $$ SELECT enqueue_notification(
       'c0000000-0000-4000-8000-000000000001',
       'c1000000-0000-4000-8000-000000000001',
       'reservation_confirmed', '0500000000', '{}'::jsonb, 'own:1') $$,
  'в свою организацию событие ставится'
);

-- ── 3. Дедупликация не пересекает границу организаций ────────
-- Тот же ключ под доверенным серверным контекстом (org_id в токене нет,
-- как у service_role в Edge Function) — вторая строка, а не подавление.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

SELECT lives_ok(
  $$ SELECT enqueue_notification(
       'c0000000-0000-4000-8000-000000000002',
       'c1000000-0000-4000-8000-000000000002',
       'reservation_confirmed', '0500000001', '{}'::jsonb, 'own:1') $$,
  'тот же dedupe_key в другой организации не отбивается'
);

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM notification_outbox WHERE dedupe_key = 'own:1'),
  2,
  'один ключ живёт в обеих организациях независимо'
);

-- ── 4. Внутренний путь цел: триггер брони всё ещё пишет ──────
-- Гостевая бронь идёт под service_role: org_id подставляет доверенный
-- сервер, и мягкая по NULL сверка обязана её пропустить.
INSERT INTO reservations (
  id, org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status)
VALUES (
  'c2000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  gen_random_uuid(), 'Гость', '0501234567',
  2, NOW() + INTERVAL '2 hours', 'confirmed');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM notification_outbox
   WHERE org_id = 'c0000000-0000-4000-8000-000000000001'
     AND kind = 'reservation_confirmed'
     AND dedupe_key LIKE 'rsv_confirmed:c2000000%'),
  1,
  'подтверждённая бронь по-прежнему попадает в очередь (триггер не сломан)'
);

SELECT * FROM finish();
ROLLBACK;
