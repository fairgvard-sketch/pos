-- pgTAP: переименование и архив устройства из кабинета (130).
--
-- Проверяется главное обещание архива: он НИЧЕГО не отключает. Строка
-- устройства остаётся, телеметрия остаётся, действие обратимо — иначе
-- «убрать с глаз» однажды означало бы «потерять кассу».

BEGIN;
SELECT plan(13);

INSERT INTO orgs (id, name) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'pgTAP fleet A'),
  ('a0000000-0000-4000-8000-000000000002', 'pgTAP fleet B');
INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('a1000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', 'Главная', 'Asia/Jerusalem'),
  ('a1000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000002', 'Чужая', 'Asia/Jerusalem');
INSERT INTO devices (id, org_id, location_id, name, last_seen_at) VALUES
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Касса', NOW() - INTERVAL '5 minutes'),
  ('a2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Касса', NOW() - INTERVAL '40 days'),
  ('a2000000-0000-4000-8000-0000000000ff', 'a0000000-0000-4000-8000-000000000002',
   'a1000000-0000-4000-8000-000000000002', 'Чужая касса', NOW());

INSERT INTO auth.users (id) VALUES ('a4000000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('a5000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001',
   'owner', TRUE);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"a0000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Переименование ──────────────────────────────────────────
SELECT lives_ok(
  $$SELECT rename_device_web('a2000000-0000-4000-8000-000000000001', 'Стойка 1')$$,
  'устройство переименовывается');
SELECT is(
  (SELECT name FROM devices WHERE id = 'a2000000-0000-4000-8000-000000000001'),
  'Стойка 1', 'имя обновлено');
SELECT throws_ok(
  $$SELECT rename_device_web('a2000000-0000-4000-8000-000000000001', '   ')$$,
  'name_required',
  'пустое имя не принимается — строка без названия бесполезнее «Кассы»');
SELECT throws_ok(
  $$SELECT rename_device_web('a2000000-0000-4000-8000-0000000000ff', 'Взлом')$$,
  'not_found',
  'чужое устройство переименовать нельзя');
-- Под RLS чужая строка невидима — смотрим вне роли, иначе сравнивали бы
-- с NULL и «проверка» проходила бы при любой ошибке функции.
RESET ROLE;
SELECT is(
  (SELECT name FROM devices WHERE id = 'a2000000-0000-4000-8000-0000000000ff'),
  'Чужая касса', 'имя чужого устройства не тронуто');
SET LOCAL ROLE authenticated;

-- ── Архив ───────────────────────────────────────────────────
SELECT lives_ok(
  $$SELECT set_device_archived_web('a2000000-0000-4000-8000-000000000002', TRUE)$$,
  'устройство уходит в архив');
SELECT isnt(
  (SELECT archived_at FROM devices WHERE id = 'a2000000-0000-4000-8000-000000000002'),
  NULL, 'метка архива проставлена');

-- Архив ничего не отключает: запись, точка и телеметрия на месте
SELECT is(
  (SELECT count(*)::INTEGER FROM devices WHERE org_id = 'a0000000-0000-4000-8000-000000000001'),
  2, 'запись устройства не удалена');
SELECT isnt(
  (SELECT last_seen_at FROM devices WHERE id = 'a2000000-0000-4000-8000-000000000002'),
  NULL, 'телеметрия сохранена');

SELECT lives_ok(
  $$SELECT set_device_archived_web('a2000000-0000-4000-8000-000000000002', FALSE)$$,
  'устройство возвращается из архива');
SELECT is(
  (SELECT archived_at FROM devices WHERE id = 'a2000000-0000-4000-8000-000000000002'),
  NULL, 'возврат обратим — метка снята');

-- ── Парк отдаёт метку архива ────────────────────────────────
SELECT lives_ok(
  $$SELECT set_device_archived_web('a2000000-0000-4000-8000-000000000002', TRUE)$$,
  'архивируем снова для проверки выдачи');
SELECT is(
  (SELECT count(*)::INTEGER FROM jsonb_array_elements(get_backoffice_fleet())  e
   WHERE (e ->> 'archived_at') IS NOT NULL),
  1, 'парк отдаёт архивные с меткой — кабинет прячет их сам, а не теряет');

SELECT * FROM finish();
ROLLBACK;
