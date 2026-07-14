-- 070: явные гранты для devices и device-RPC.
--
-- Новые стеки Supabase (локальный CLI, CI и любые СВЕЖЕсозданные проекты)
-- поставляются с ужесточёнными default privileges: объекты, созданные ролью
-- postgres в public, больше НЕ получают автоматических DML/EXECUTE грантов
-- для anon/authenticated (таблицы: только TRUNCATE/REFERENCES/TRIGGER/
-- MAINTAIN; функции: EXECUTE ни у кого из app-ролей). Действующий production
-- (qgmnxrgtlpyqglwqmsej) создан на старых дефолтах (полный DML + EXECUTE),
-- поэтому там всё работало, а pgTAP на чистом стеке падал: authenticated не
-- мог ни читать devices, ни вызвать register_device.
--
-- Здесь — минимальный явный слой под фактический контракт устройства
-- (RLS-политики devices_select/insert_own/update_own/delete_own из 065
-- ограничивают строки; грант открывает сами глаголы). В legacy production
-- эти GRANT — no-op.
--
-- ВНИМАНИЕ (систематическая проблема): остальные таблицы/функции проекта
-- по-прежнему полагаются на legacy-дефолты production. Перед разворачиванием
-- кассы на НОВОМ Supabase-проекте нужен полный аудит и migration с явными
-- грантами по всей поверхности приложения. См. docs/database.md.

GRANT SELECT, INSERT, UPDATE, DELETE ON devices TO authenticated;

GRANT EXECUTE ON FUNCTION register_device(UUID, TEXT, JSONB, TEXT, TEXT, JSONB)
  TO authenticated;
GRANT EXECUTE ON FUNCTION update_device_settings(UUID, JSONB)
  TO authenticated;
