-- pgTAP: PIN-throttle и скоуп сессии по точке (095).
--
-- Закрывает две находки аудита:
--   1) verify_staff_pin не считала неудачные попытки — перебор 10 000
--      вариантов был вопросом минут;
--   2) require_staff_perm не сверяла location_id — токен точки А работал
--      на точке Б той же организации, где уровни прав могут быть строже.
--
-- Тест фиксирует оба инварианта, чтобы следующее переопределение функций
-- (как 055 молча откатила строгий режим 045) не сняло их так же незаметно.

BEGIN;
SELECT plan(11);

-- ── Фикстура: организация, ДВЕ точки, сотрудники, сессии ────
INSERT INTO orgs (id, name)
VALUES ('80000000-0000-4000-8000-000000000001', 'pgTAP org T');

INSERT INTO locations (id, org_id, name) VALUES
  ('81000000-0000-4000-8000-00000000000a',
   '80000000-0000-4000-8000-000000000001', 'Loc A'),
  ('81000000-0000-4000-8000-00000000000b',
   '80000000-0000-4000-8000-000000000001', 'Loc B');

-- Бариста точки A. PIN настоящий (bcrypt) — тест ходит через verify_staff_pin.
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('82000000-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-00000000000a',
   'pgTAP barista A', 'barista', extensions.crypt('1234', extensions.gen_salt('bf')));

-- Сессия, выданная на точке A
INSERT INTO staff_sessions (token, staff_id, org_id, location_id) VALUES
  ('83000000-0000-4000-8000-000000000001',
   '82000000-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-00000000000a');

-- Legacy-сессия без точки (выдана до 095): должна продолжать работать
INSERT INTO staff_sessions (token, staff_id, org_id, location_id) VALUES
  ('83000000-0000-4000-8000-00000000000f',
   '82000000-0000-4000-8000-000000000001',
   '80000000-0000-4000-8000-000000000001',
   NULL);

-- ── 1. Схема журнала попыток ────────────────────────────────
SELECT has_table('pin_attempts', 'pin_attempts существует (095)');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'pin_attempts'),
  'pin_attempts под RLS'
);

-- Токен-подобный сигнал безопасности не должен читаться клиентом
SELECT ok(
  NOT has_table_privilege('authenticated', 'pin_attempts', 'SELECT'),
  'pin_attempts недоступна authenticated на чтение'
);

-- ── 2. Скоуп сессии по точке (находка 2) ────────────────────
-- Контекст точки A: своя сессия проходит.
SET LOCAL request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000001","location_id":"81000000-0000-4000-8000-00000000000a"}}';
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT require_staff_perm('83000000-0000-4000-8000-000000000001', 'discount') $$,
  'сессия точки A действует на точке A'
);

SELECT lives_ok(
  $$ SELECT require_staff_perm('83000000-0000-4000-8000-00000000000f', 'discount') $$,
  'legacy-сессия без location_id не разлогинена (совместимость 095)'
);

RESET ROLE;

-- Контекст точки B: та же сессия — уже чужая.
SET LOCAL request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000001","location_id":"81000000-0000-4000-8000-00000000000b"}}';
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT require_staff_perm('83000000-0000-4000-8000-000000000001', 'discount') $$,
  'staff session invalid',
  'сессия точки A НЕ действует на точке B (находка 2)'
);

-- current_actor_role обязан скоупиться так же: иначе «только владелец
-- трогает владельца» (093) решалось бы по невалидному здесь токену.
SELECT is(
  current_actor_role('83000000-0000-4000-8000-000000000001'),
  NULL,
  'current_actor_role не выдаёт роль по сессии чужой точки'
);

RESET ROLE;

-- ── 3. PIN-throttle (находка 1) ─────────────────────────────
SET LOCAL request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000001","location_id":"81000000-0000-4000-8000-00000000000a"}}';
SET LOCAL ROLE authenticated;

-- Неверный PIN не пускает и оставляет след в журнале
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM (SELECT * FROM verify_staff_pin('9999')) q),
  0,
  'неверный PIN не выдаёт сессию'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM pin_attempts
   WHERE org_id = '80000000-0000-4000-8000-000000000001'),
  1,
  'неудачная попытка записана в pin_attempts'
);

-- Достигаем порога: 10 неудач в окне → блокировка ещё до сверки хеша,
-- поэтому далее не проходит даже ВЕРНЫЙ PIN.
INSERT INTO pin_attempts (org_id, auth_user_id, attempted_at)
SELECT '80000000-0000-4000-8000-000000000001',
       '84000000-0000-4000-8000-000000000001',
       NOW()
FROM generate_series(1, 9);

SET LOCAL request.jwt.claims = '{"sub":"84000000-0000-4000-8000-000000000001","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000001","location_id":"81000000-0000-4000-8000-00000000000a"}}';
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT * FROM verify_staff_pin('1234') $$,
  'pin_locked_out',
  'после 10 неудач заблокирован даже верный PIN (находка 1)'
);

-- Табель сверяет тот же хеш: без throttle перебор просто переехал бы сюда
SELECT throws_ok(
  $$ SELECT punch_by_pin('1234') $$,
  'pin_locked_out',
  'punch_by_pin (023) throttled тем же счётчиком, перебор не переезжает'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
