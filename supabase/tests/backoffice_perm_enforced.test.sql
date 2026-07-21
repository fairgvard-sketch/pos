-- pgTAP: веб-контур проверяет права (096).
--
-- Находка аудита: require_backoffice_or_staff (091) принимала p_perm, но в
-- ветке веб-ролей его не читала — членство в бэкофисе давало любое право,
-- включая помеченные manager-only в настройках точки. Настройки perms были
-- правилами только кассы, и один человек имел разный объём прав в
-- зависимости от того, зашёл он через POS или через браузер.
--
-- Тест фиксирует три инварианта:
--   * accountant НЕ получает manager-уровень (был бы полный доступ);
--   * manager получает — но именно как кассовый manager;
--   * owner остаётся неограниченным (иначе запрёт сам себя, см. 096).

BEGIN;
SELECT plan(6);

-- ── Фикстура: организация, точка, три веб-роли ──────────────
INSERT INTO orgs (id, name)
VALUES ('90000000-0000-4000-8000-000000000001', 'pgTAP org W');

INSERT INTO locations (id, org_id, name)
VALUES ('91000000-0000-4000-8000-000000000001',
        '90000000-0000-4000-8000-000000000001', 'Loc W');

-- staff-строки, с которыми связаны веб-члены (через них берётся точка)
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('92000000-0000-4000-8000-00000000000e',
   '90000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001', 'pgTAP web owner', 'owner', 'unused'),
  ('92000000-0000-4000-8000-00000000000b',
   '90000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001', 'pgTAP web manager', 'manager', 'unused'),
  ('92000000-0000-4000-8000-00000000000c',
   '90000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000001', 'pgTAP web accountant', 'barista', 'unused');

INSERT INTO auth.users (id) VALUES
  ('93000000-0000-4000-8000-000000000001'),
  ('93000000-0000-4000-8000-000000000002'),
  ('93000000-0000-4000-8000-000000000003');

INSERT INTO organization_members (org_id, auth_user_id, role, is_active, staff_id) VALUES
  ('90000000-0000-4000-8000-000000000001',
   '93000000-0000-4000-8000-000000000001', 'owner', TRUE,
   '92000000-0000-4000-8000-00000000000e'),
  ('90000000-0000-4000-8000-000000000001',
   '93000000-0000-4000-8000-000000000002', 'manager', TRUE,
   '92000000-0000-4000-8000-00000000000b'),
  ('90000000-0000-4000-8000-000000000001',
   '93000000-0000-4000-8000-000000000003', 'accountant', TRUE,
   '92000000-0000-4000-8000-00000000000c');

-- ── 1. accountant не должен получать manager-уровень ────────
SET LOCAL request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000003","app_metadata":{"org_id":"90000000-0000-4000-8000-000000000001"}}';
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT require_backoffice_or_staff(NULL, 'manage') $$,
  'forbidden: manage',
  'accountant НЕ получает manage через веб-контур (находка аудита)'
);

SELECT throws_ok(
  $$ SELECT require_backoffice_or_staff(NULL, 'refund') $$,
  'forbidden: refund',
  'accountant НЕ получает refund (manager-уровень по умолчанию)'
);

-- 'all'-уровень accountant проходит: роль читающая, но не бесправная
SELECT lives_ok(
  $$ SELECT require_backoffice_or_staff(NULL, 'discount') $$,
  'accountant проходит all-уровень (discount)'
);

RESET ROLE;

-- ── 2. manager проходит менеджерские права ──────────────────
SET LOCAL request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000002","app_metadata":{"org_id":"90000000-0000-4000-8000-000000000001"}}';
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT require_backoffice_or_staff(NULL, 'manage') $$,
  'веб-manager проходит manage'
);

RESET ROLE;

-- ── 3. owner не ограничен настройками точки ─────────────────
-- Даже если владелец выкрутит уровень в настройках, он обязан пройти:
-- иначе запирает сам себя без пути восстановления (см. шапку 096).
UPDATE locations
SET settings = jsonb_set(COALESCE(settings, '{}'::JSONB),
                         ARRAY['perms', 'manage'], '"manager"'::JSONB)
WHERE id = '91000000-0000-4000-8000-000000000001';

SET LOCAL request.jwt.claims = '{"sub":"93000000-0000-4000-8000-000000000001","app_metadata":{"org_id":"90000000-0000-4000-8000-000000000001"}}';
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT require_backoffice_or_staff(NULL, 'manage') $$,
  'owner не ограничен настройками, которые сам правит'
);

-- Автор операции = связанная staff-строка (модель 091 не сломана)
SELECT is(
  require_backoffice_or_staff(NULL, 'manage'),
  '92000000-0000-4000-8000-00000000000e',
  'гейт по-прежнему возвращает staff_id автора'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
