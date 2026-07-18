-- pgTAP: версия схемы для фронтенда (081).

BEGIN;
SELECT plan(4);

SELECT has_function('get_schema_version');

SELECT ok(
  has_function_privilege('authenticated', 'get_schema_version()', 'EXECUTE'),
  'authenticated может вызвать get_schema_version'
);
SELECT ok(
  NOT has_function_privilege('anon', 'get_schema_version()', 'EXECUTE'),
  'anon не вызывает get_schema_version'
);

-- Журнал миграций CLI заполнен reset'ом — версия не меньше этой миграции
SELECT cmp_ok(get_schema_version(), '>=', 81, 'версия схемы не меньше 081');

SELECT * FROM finish();
ROLLBACK;
