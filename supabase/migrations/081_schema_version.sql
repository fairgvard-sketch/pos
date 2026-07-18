-- 081: версия схемы БД для фронтенда.
--
-- Фронт держит MIN_SCHEMA_VERSION (src/lib/schemaVersion.ts) и на старте
-- сверяется с БД: отстающая база даёт явный экран «Требуется обновление базы
-- данных» вместо тихо пустого каталога (запросы к несуществующим таблицам).
--
-- Версия читается из журнала миграций CLI (supabase_migrations.schema_migrations),
-- который заполняют и `db reset`, и `db push --linked` — отдельного счётчика,
-- который можно забыть обновить, нет. SECURITY DEFINER: у authenticated нет
-- доступа к схеме supabase_migrations.

CREATE OR REPLACE FUNCTION get_schema_version()
RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(MAX(version::integer), 0)
  FROM supabase_migrations.schema_migrations
  WHERE version ~ '^\d+$'
$$;

REVOKE EXECUTE ON FUNCTION get_schema_version FROM anon, public;
GRANT EXECUTE ON FUNCTION get_schema_version() TO authenticated;
