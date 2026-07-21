-- pgTAP: управление командой из веб-кабинета владельца (093).
--
-- Проверяем три группы инвариантов:
--  1) веб-владелец управляет сотрудниками без PIN (единый гейт 091);
--  2) точка обязательна и должна принадлежать его организации;
--  3) роль owner защищена в БД: менеджер не создаёт владельцев, не повышает
--     до владельца и не трогает чужую owner-строку (раньше — только клиент).
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(12);

-- ── Фикстура: две организации, у org A — веб-владелец и веб-менеджер ──
INSERT INTO orgs (id, name) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'pgTAP org S1'),
  ('a0000000-0000-4000-8000-000000000002', 'pgTAP org S2');

INSERT INTO locations (id, org_id, name) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Loc S1'),
  ('a1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'Loc S2');

-- Действующий владелец-сотрудник org A (цель для проверок защиты роли)
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash, is_active) VALUES
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Владелец', 'owner', 'x', TRUE),
  ('a2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Бариста', 'barista', 'x', TRUE);

INSERT INTO auth.users (id) VALUES
  ('a3000000-0000-4000-8000-000000000001'),  -- веб-владелец org A
  ('a3000000-0000-4000-8000-000000000002'),  -- веб-менеджер org A
  ('a3000000-0000-4000-8000-000000000003');  -- веб-владелец org B

INSERT INTO organization_members (org_id, auth_user_id, role, is_active, staff_id) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'owner',   TRUE,
   'a2000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'manager', TRUE, NULL),
  ('a0000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000003', 'owner',   TRUE, NULL);

SET LOCAL ROLE authenticated;

-- ============================================================
-- Веб-владелец org A
-- ============================================================
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a3000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"a0000000-0000-4000-8000-000000000001"}}',
  true
);

-- 1. Создание сотрудника без PIN-сессии
CREATE TEMP TABLE new_staff AS
SELECT create_staff('Новый бариста', 'barista', '1234',
                    'a1000000-0000-4000-8000-000000000001') AS id;

SELECT is(
  (SELECT name FROM staff WHERE id = (SELECT id FROM new_staff)),
  'Новый бариста',
  'владелец заводит сотрудника из веба без PIN'
);
SELECT is(
  (SELECT location_id FROM staff WHERE id = (SELECT id FROM new_staff)),
  'a1000000-0000-4000-8000-000000000001'::UUID,
  'сотрудник привязан к переданной точке'
);
-- pin_hash недоступен роли authenticated (колоночные гранты 001) — это сам по
-- себе инвариант: проверяем и отказ в чтении, и содержимое из-под postgres.
SELECT throws_ok(
  $$ SELECT pin_hash FROM staff WHERE org_id = 'a0000000-0000-4000-8000-000000000001' $$,
  '42501',
  NULL,
  'pin_hash не читается из-под authenticated'
);

-- 2. Правка карточки и смена PIN
SELECT update_staff((SELECT id FROM new_staff),
                    '{"name":"Бариста Дана","role":"manager"}'::jsonb);
SELECT is(
  (SELECT role FROM staff WHERE id = (SELECT id FROM new_staff)),
  'manager',
  'владелец меняет роль сотрудника'
);

RESET ROLE;
CREATE TEMP TABLE old_hash AS
SELECT pin_hash AS h FROM staff WHERE id = (SELECT id FROM new_staff);
SET LOCAL ROLE authenticated;

SELECT set_staff_pin((SELECT id FROM new_staff), '567890');

RESET ROLE;
SELECT isnt(
  (SELECT pin_hash FROM staff WHERE id = (SELECT id FROM new_staff)),
  (SELECT h FROM old_hash),
  'владелец перевыпускает PIN из веба'
);
-- Новый PIN действительно проверяется хешем, а не совпадением строк
SELECT ok(
  (SELECT pin_hash = crypt('567890', pin_hash) FROM staff WHERE id = (SELECT id FROM new_staff)),
  'новый PIN сохранён корректным bcrypt-хешем'
);
SET LOCAL ROLE authenticated;

-- 3. Точка обязательна и проверяется на принадлежность организации
SELECT throws_ok(
  $$ SELECT create_staff('Без точки', 'barista', '1111', NULL) $$,
  'location required',
  'веб-владелец обязан указать точку'
);
SELECT throws_ok(
  $$ SELECT create_staff('Чужая точка', 'barista', '1111',
                         'a1000000-0000-4000-8000-000000000002') $$,
  'location not in organization',
  'точка чужой организации отклоняется'
);

-- 4. Невалидный PIN отклоняется
SELECT throws_ok(
  $$ SELECT create_staff('Короткий PIN', 'barista', '12',
                         'a1000000-0000-4000-8000-000000000001') $$,
  'PIN must be 4-8 digits',
  'PIN короче четырёх цифр отклоняется'
);

-- ============================================================
-- Веб-менеджер org A: роль owner защищена на уровне БД
-- ============================================================
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a3000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"a0000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$ SELECT create_staff('Самозванец', 'owner', '4321',
                         'a1000000-0000-4000-8000-000000000001') $$,
  'only owner can assign owner role',
  'менеджер не может завести владельца'
);
SELECT throws_ok(
  $$ SELECT update_staff('a2000000-0000-4000-8000-000000000002',
                         '{"role":"owner"}'::jsonb) $$,
  'only owner can modify owner',
  'менеджер не может повысить сотрудника до владельца'
);
SELECT throws_ok(
  $$ SELECT set_staff_pin('a2000000-0000-4000-8000-000000000001', '9999') $$,
  'only owner can modify owner',
  'менеджер не может перевыпустить PIN владельца'
);

SELECT * FROM finish();
ROLLBACK;
