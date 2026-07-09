-- ============================================================
-- 036 LOCATION SETTINGS — мелкие настройки точки одной jsonb-колонкой.
--
-- Настройки v2 (реорганизация в стиле Square) добавляет ~10 мелких
-- опций точки: права по ролям, опции чека, настройки смены. Вместо
-- колонки на каждую опцию — один jsonb `settings`; дефолты живут на
-- клиенте (src/lib/perms.ts, locationSettings()), отсутствие ключа =
-- значение по умолчанию. Крупные доменные настройки (vat_rate,
-- service_mode, loyalty_*, receipt_*) остаются колонками.
--
-- Форма (все ключи опциональны):
--   perms:   { discount, price_edit, refund, void_order, close_shift }
--            значения 'all' | 'manager' (manager = manager+owner;
--            enforcement на клиенте — модель авторизации доверяет
--            устройству, см. CLAUDE.md)
--   receipt: { print_modifiers: bool, copies: 1|2 }
--   shift:   { default_opening_float: int|null,   -- агороты
--              close_reminder: 'HH:MM'|null,
--              cash_warn_threshold: int|null }    -- агороты
--
-- RLS не меняется: locations_all уже даёт UPDATE в своей org.
-- ============================================================

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN locations.settings IS
  'Мелкие настройки точки (права по ролям, опции чека, смена). Дефолты — на клиенте.';
