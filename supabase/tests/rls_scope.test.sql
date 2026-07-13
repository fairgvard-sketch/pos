-- pgTAP: RLS-скоуп устройств (065) + существование новых RPC.
-- Запуск: supabase test db (локальный стек, см. supabase/tests/README.md).
--
-- Полный cross-org тест требует подмены JWT-клеймов (auth_org_id() читает
-- app_metadata), что делается через set_config('request.jwt.claims', …).
-- Здесь проверяем структурные инварианты, которые ловят регресс миграций
-- 064/065 без поднятия auth-контекста.

BEGIN;
SELECT plan(9);

-- 065: новые колонки devices
SELECT has_column('devices', 'device_uuid');
SELECT has_column('devices', 'auth_user_id');
SELECT has_column('devices', 'settings');
SELECT has_column('devices', 'app_version');

-- 065: RLS включён, старая org-wide политика заменена на self-owned
SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'devices'),
  true,
  'RLS включён на devices'
);
SELECT isnt(
  (SELECT count(*) FROM pg_policies WHERE tablename = 'devices' AND policyname = 'devices_update_own'),
  0::bigint,
  'политика devices_update_own существует (правка только своей строки)'
);

-- 064/065: новые RPC заведены
SELECT has_function('patch_location_settings');
SELECT has_function('save_menu_item');
SELECT has_function('register_device');

SELECT * FROM finish();
ROLLBACK;
