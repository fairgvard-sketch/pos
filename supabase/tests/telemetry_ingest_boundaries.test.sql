-- pgTAP: серверные границы приёма телеметрии (170).
-- Матрица: принадлежность устройства, недоверенный JSON, лимиты, права
-- и побочные эффекты. Конкурентность здесь не проверяется — одна транзакция
-- её не воспроизводит, для неё есть scripts/test-telemetry-ingest-concurrency.mjs.

BEGIN;
SELECT plan(69);

-- ── Фикстура: две организации, две точки внутри org A, два Auth-пользователя
-- внутри одной точки, одна учётка с двумя device_uuid ──
INSERT INTO orgs (id, name) VALUES
  ('60000000-0000-4000-8000-000000000001', 'Org A'),
  ('60000000-0000-4000-8000-000000000002', 'Org B');
INSERT INTO locations (id, org_id, name) VALUES
  ('61000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'A1'),
  ('61000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', 'A2'),
  ('61000000-0000-4000-8000-00000000000b', '60000000-0000-4000-8000-000000000002', 'B1');
INSERT INTO auth.users (id) VALUES
  ('62000000-0000-4000-8000-000000000001'),
  ('62000000-0000-4000-8000-000000000002'),
  ('62000000-0000-4000-8000-000000000003'),
  ('62000000-0000-4000-8000-00000000000b'),
  ('62000000-0000-4000-8000-0000000000d1');
INSERT INTO auth.users (id, banned_until) VALUES
  ('62000000-0000-4000-8000-0000000000ba', NOW() + INTERVAL '1 day');
INSERT INTO devices (id, org_id, location_id, name, device_uuid, auth_user_id, settings, archived_at) VALUES
  ('64000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','own',      '63000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','{}',NULL),
  ('64000000-0000-4000-8000-000000000011','60000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','own 2nd',  '63000000-0000-4000-8000-000000000011','62000000-0000-4000-8000-000000000001','{}',NULL),
  ('64000000-0000-4000-8000-0000000000ac','60000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','archived', '63000000-0000-4000-8000-0000000000ac','62000000-0000-4000-8000-000000000001','{}',NOW()),
  ('64000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','other user','63000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000002','{}',NULL),
  ('64000000-0000-4000-8000-000000000003','60000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000002','other loc', '63000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000003','{}',NULL),
  ('64000000-0000-4000-8000-00000000000b','60000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-00000000000b','other org', '63000000-0000-4000-8000-00000000000b','62000000-0000-4000-8000-00000000000b','{}',NULL),
  ('64000000-0000-4000-8000-0000000000ba','60000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','banned',    '63000000-0000-4000-8000-0000000000ba','62000000-0000-4000-8000-0000000000ba','{}',NULL);
INSERT INTO organization_members (org_id, auth_user_id, role, is_active) VALUES
  ('60000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-0000000000d1','owner',true);

CREATE FUNCTION pg_temp.claims(p_user UUID, p_loc UUID) RETURNS VOID
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user, 'role', 'authenticated',
    'app_metadata', CASE WHEN p_loc IS NULL
      THEN jsonb_build_object('org_id','60000000-0000-4000-8000-000000000001')
      ELSE jsonb_build_object('org_id','60000000-0000-4000-8000-000000000001','location_id',p_loc) END
  )::text, true)::void;
$$;
-- Наблюдатель закрытой таблицы: сам вызов RPC идёт от роли authenticated.
CREATE FUNCTION pg_temp.rows_for(p_device UUID) RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)::INTEGER FROM public.client_errors WHERE device_uuid = p_device;
$$;
CREATE FUNCTION pg_temp.one(p_fp TEXT) RETURNS TEXT AS $$
  SELECT format('[{"fingerprint":"%s","source":"react","message":"m"}]', p_fp);
$$ LANGUAGE sql IMMUTABLE;

-- ── 1. Принадлежность ──
SET LOCAL ROLE authenticated;
SELECT pg_temp.claims('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001');

SELECT is(
  report_client_errors('63000000-0000-4000-8000-000000000001', pg_temp.one('own')::jsonb), 1,
  'своё зарегистрированное устройство принимается'
);
SELECT is(
  report_client_errors('63000000-0000-4000-8000-000000000011', pg_temp.one('own2')::jsonb), 1,
  'второй device_uuid той же учётки принимается (несколько устройств на аккаунт)'
);
SELECT is(
  report_client_errors('63000000-0000-4000-8000-0000000000ac', pg_temp.one('arch')::jsonb), 1,
  'архив остаётся косметическим признаком и не отсекает своё устройство'
);
SELECT throws_ok(
  $$SELECT report_client_errors('63000000-0000-4000-8000-000000000002', '[{"fingerprint":"x","source":"react","message":"m"}]'::jsonb)$$,
  'device_not_registered', 'устройство другого Auth-пользователя в своей точке отвергается'
);
SELECT throws_ok(
  $$SELECT report_client_errors('63000000-0000-4000-8000-000000000003', '[{"fingerprint":"x","source":"react","message":"m"}]'::jsonb)$$,
  'device_not_registered', 'устройство другой точки своей org отвергается'
);
SELECT throws_ok(
  $$SELECT report_client_errors('63000000-0000-4000-8000-00000000000b', '[{"fingerprint":"x","source":"react","message":"m"}]'::jsonb)$$,
  'device_not_registered', 'устройство другой организации отвергается'
);
SELECT throws_ok(
  $$SELECT report_client_errors('99999999-9999-4999-8999-999999999999', '[{"fingerprint":"x","source":"react","message":"m"}]'::jsonb)$$,
  'device_not_registered', 'неизвестный device_uuid отвергается (первый запуск до регистрации)'
);
RESET ROLE;
SELECT is(pg_temp.rows_for('63000000-0000-4000-8000-000000000002'), 0, 'ни одной записи от имени устройства другого сотрудника');
SELECT is(pg_temp.rows_for('63000000-0000-4000-8000-000000000003'), 0, 'ни одной записи от имени устройства другой точки');
SELECT is(pg_temp.rows_for('63000000-0000-4000-8000-00000000000b'), 0, 'ни одной записи от имени устройства другой организации');
SELECT is(pg_temp.rows_for('99999999-9999-4999-8999-999999999999'), 0, 'ни одной записи от имени неизвестного UUID');
SELECT is(
  (SELECT org_id FROM client_errors WHERE fingerprint = 'own'),
  '60000000-0000-4000-8000-000000000001'::uuid,
  'org берётся из JWT, а не из параметров'
);

-- Digital-аккаунт без location_id не превращается в POS-устройство.
SET LOCAL ROLE authenticated;
SELECT pg_temp.claims('62000000-0000-4000-8000-0000000000d1', NULL);
SELECT throws_ok(
  $$SELECT report_client_errors('63000000-0000-4000-8000-000000000001', '[{"fingerprint":"x","source":"react","message":"m"}]'::jsonb)$$,
  'device_not_registered', 'digital-аккаунт без location не пишет как POS-касса'
);
-- Заблокированный Auth-пользователь со старыми claims отсекается по 169.
SELECT pg_temp.claims('62000000-0000-4000-8000-0000000000ba','61000000-0000-4000-8000-000000000001');
SELECT throws_ok(
  $$SELECT report_client_errors('63000000-0000-4000-8000-0000000000ba', '[{"fingerprint":"x","source":"react","message":"m"}]'::jsonb)$$,
  'not authenticated', 'заблокированный Auth-пользователь отсекается (169)'
);
RESET ROLE;
SELECT is(pg_temp.rows_for('63000000-0000-4000-8000-0000000000ba'), 0, 'заблокированная учётка не оставила записей');

-- ── 2. Недоверенный JSON ──
SET LOCAL ROLE authenticated;
SELECT pg_temp.claims('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001');

-- Верхний уровень: понятный отказ, без записей.
SELECT throws_ok($$SELECT report_client_errors('63000000-0000-4000-8000-000000000001', NULL::jsonb)$$,
  'errors must be a json array', 'SQL NULL вместо массива — понятный отказ');
SELECT throws_ok($$SELECT report_client_errors('63000000-0000-4000-8000-000000000001', 'null'::jsonb)$$,
  'errors must be a json array', 'JSON null вместо массива — понятный отказ');
SELECT throws_ok($$SELECT report_client_errors('63000000-0000-4000-8000-000000000001', '{"fingerprint":"x"}'::jsonb)$$,
  'errors must be a json array', 'объект вместо массива — понятный отказ');
SELECT throws_ok($$SELECT report_client_errors('63000000-0000-4000-8000-000000000001', '"nope"'::jsonb)$$,
  'errors must be a json array', 'строка вместо массива — понятный отказ');
SELECT throws_ok($$SELECT report_client_errors(NULL, '[]'::jsonb)$$,
  'errors must be a json array', 'NULL device_uuid отвергается тем же верхнеуровневым исключением');

-- Битый элемент не откатывает валидные соседи (на 169 каждый из этих
-- пакетов падал целиком: 23502, 22P02 и 22003).
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"ok1","source":"react","message":"m"},{"fingerprint":"b","message":"m"}]'::jsonb),
  2, 'элемент без source принят с клампом в window, пакет цел');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"ok2","source":"react","message":"m"},{"fingerprint":"b2","source":null,"message":"m"}]'::jsonb),
  2, 'source: null не валит пакет');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"ok3","source":"react","message":"m"},{"fingerprint":"c1","source":"react","message":"m","count":"abc"}]'::jsonb),
  2, 'count строкой не валит пакет');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"ok4","source":"react","message":"m"},{"fingerprint":"c2","source":"react","message":"m","count":1.5}]'::jsonb),
  2, 'дробный count не валит пакет');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"ok5","source":"react","message":"m"},{"fingerprint":"c3","source":"react","message":"m","count":99999999999999}]'::jsonb),
  2, 'count за пределами INTEGER не валит пакет');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"ok6","source":"react","message":"m"},null,"str",42,[1,2]]'::jsonb),
  1, 'null/строка/число/массив внутри массива пропускаются, валидный сосед принят');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"","source":"react","message":"m"},{"fingerprint":"ok7","source":"react","message":"m"}]'::jsonb),
  1, 'пустой fingerprint пропускается');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"nsm","source":"react","message":{"guest":"pii"}},{"fingerprint":"ok8","source":"react","message":"m"}]'::jsonb),
  1, 'нестроковый message пропускается');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"nss","source":"react","message":"m","stack":{"a":1},"route":7}]'::jsonb),
  1, 'нестроковые stack/route не мешают приёму элемента');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"neg","source":"react","message":"m","count":-5}]'::jsonb),
  1, 'отрицательный count принимается');
RESET ROLE;

SELECT is((SELECT count(*)::int FROM client_errors WHERE fingerprint = ''), 0,
  'строка с пустым fingerprint не создана');
SELECT is((SELECT count(*)::int FROM client_errors WHERE fingerprint = 'nsm'), 0,
  'строка с нестроковым message не создана');
SELECT is((SELECT stack FROM client_errors WHERE fingerprint = 'nss'), NULL,
  'нестроковый stack обнуляется, а не сериализуется в текст');
SELECT is((SELECT route FROM client_errors WHERE fingerprint = 'nss'), NULL,
  'нестроковый route обнуляется');
SELECT is((SELECT source FROM client_errors WHERE fingerprint = 'b'), 'window',
  'элемент без source сохранён как window');
SELECT is((SELECT count FROM client_errors WHERE fingerprint = 'c1'), 1,
  'нечисловой count нормализуется в 1');
SELECT is((SELECT count FROM client_errors WHERE fingerprint = 'c2'), 1,
  'дробный count нормализуется вниз до целого');
SELECT is((SELECT count FROM client_errors WHERE fingerprint = 'c3'), 1000,
  'count за пределами INTEGER подрезается до 1000');
SELECT is((SELECT count FROM client_errors WHERE fingerprint = 'neg'), 1,
  'отрицательный count поднимается до 1');

-- ── 3. Лимиты ──
SET LOCAL ROLE authenticated;
SELECT pg_temp.claims('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000011',
  (SELECT jsonb_agg(jsonb_build_object('fingerprint','many'||i,'source','react','message','m'))
   FROM generate_series(1,25) i)),
  20, 'не больше 20 элементов за вызов');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000011',
  '[{"fingerprint":"cap","source":"react","message":"m","count":5000}]'::jsonb),
  1, 'count выше 1000 принимается с подрезкой');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000011',
  ('[{"fingerprint":"long","source":"react","message":"' || repeat('m', 900) || '"}]')::jsonb),
  1, 'длинный message принимается с обрезкой');
RESET ROLE;
SELECT is((SELECT count FROM client_errors WHERE fingerprint = 'cap'), 1000, 'count подрезан до 1000');
SELECT is((SELECT length(message) FROM client_errors WHERE fingerprint = 'long'), 500, 'message обрезан до 500');

-- Насыщение счётчика повторов: на 169 весь пакет падал с 22003.
INSERT INTO client_errors(org_id,location_id,device_uuid,fingerprint,source,message,count)
VALUES ('60000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001',
        '63000000-0000-4000-8000-000000000001','hot','react','storm',2147483000);
SET LOCAL ROLE authenticated;
SELECT pg_temp.claims('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001',
  '[{"fingerprint":"hot","source":"react","message":"storm","count":1000},
    {"fingerprint":"sibling","source":"react","message":"m"}]'::jsonb),
  2, 'переполнение счётчика не валит пакет');
RESET ROLE;
SELECT is((SELECT count FROM client_errors WHERE fingerprint = 'hot'), 2147483647,
  'счётчик насыщается на INTEGER max, без wrap');
SELECT is((SELECT count(*)::int FROM client_errors WHERE fingerprint = 'sibling'), 1,
  'валидный сосед пережил насыщение счётчика');

-- Дедупликация и шесть источников (074/082) сохраняются.
SET LOCAL ROLE authenticated;
SELECT pg_temp.claims('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001');
SELECT is(report_client_errors('63000000-0000-4000-8000-0000000000ac',
  '[{"fingerprint":"s1","source":"window","message":"m"},{"fingerprint":"s2","source":"promise","message":"m"},
    {"fingerprint":"s3","source":"react","message":"m"},{"fingerprint":"s4","source":"outbox","message":"m"},
    {"fingerprint":"s5","source":"print","message":"m"},{"fingerprint":"s6","source":"shift","message":"m"},
    {"fingerprint":"s6","source":"shift","message":"m","count":4},
    {"fingerprint":"s7","source":"martian","message":"m"}]'::jsonb),
  8, 'шесть источников и повтор приняты');
RESET ROLE;
SELECT is((SELECT count(DISTINCT source)::int FROM client_errors
           WHERE device_uuid = '63000000-0000-4000-8000-0000000000ac'), 6,
  'шесть источников, включая shift, сохранены');
SELECT is((SELECT count FROM client_errors WHERE fingerprint = 's6'), 5,
  'повтор схлопнут в count (1+4)');
SELECT is((SELECT source FROM client_errors WHERE fingerprint = 's7'), 'window',
  'неизвестный source по-прежнему клампится в window');

-- ── 4. Права ──
SELECT ok(NOT has_table_privilege('authenticated','client_errors','SELECT'), 'authenticated не читает client_errors');
SELECT ok(NOT has_table_privilege('authenticated','client_errors','INSERT'), 'authenticated не пишет в client_errors');
SELECT ok(NOT has_table_privilege('authenticated','client_errors','UPDATE'), 'authenticated не обновляет client_errors');
SELECT ok(NOT has_table_privilege('authenticated','client_errors','DELETE'), 'authenticated не удаляет client_errors');
SELECT ok(NOT has_table_privilege('anon','client_errors','SELECT'), 'anon не читает client_errors');
SELECT ok(NOT has_table_privilege('anon','client_errors','INSERT'), 'anon не пишет в client_errors');
SELECT ok(NOT has_table_privilege('authenticated','ops_errors','SELECT'), 'authenticated не читает ops_errors');
SELECT ok(NOT has_table_privilege('anon','ops_errors','SELECT'), 'anon не читает ops_errors');
SELECT ok(NOT has_function_privilege('authenticated','telemetry_device_belongs_to_caller(uuid)','EXECUTE'),
  'helper не выдан authenticated');
SELECT ok(NOT has_function_privilege('anon','telemetry_device_belongs_to_caller(uuid)','EXECUTE'),
  'helper не выдан anon');
SELECT ok(has_function_privilege('authenticated','report_client_errors(uuid,jsonb)','EXECUTE'),
  'подпись RPC сохранена и доступна authenticated');
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE proname = 'telemetry_device_belongs_to_caller'), true,
  'helper — SECURITY DEFINER');
SELECT ok(
  (SELECT proconfig::text LIKE '%search_path=public, pg_temp%'
   FROM pg_proc WHERE proname = 'telemetry_device_belongs_to_caller'),
  'у helper закреплён search_path');

-- ── 5. Побочные эффекты: очистка ──
INSERT INTO client_errors(org_id,location_id,device_uuid,fingerprint,source,message,last_seen_at)
VALUES ('60000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001',
        '63000000-0000-4000-8000-000000000001','old','react','old', NOW() - INTERVAL '40 days');
SET LOCAL ROLE authenticated;
SELECT pg_temp.claims('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001');
SELECT throws_ok(
  $$SELECT report_client_errors('63000000-0000-4000-8000-00000000000b', '[{"fingerprint":"x","source":"react","message":"m"}]'::jsonb)$$,
  'device_not_registered', 'вызов с чужим устройством отвергнут');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM client_errors WHERE fingerprint = 'old'), 1,
  'отвергнутый вызов не запустил 30-дневную очистку');
SET LOCAL ROLE authenticated;
SELECT pg_temp.claims('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001');
SELECT is(report_client_errors('63000000-0000-4000-8000-000000000001', pg_temp.one('fresh')::jsonb), 1,
  'свой вызов проходит');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM client_errors WHERE fingerprint = 'old'), 0,
  'своя 30-дневная очистка по-прежнему работает');
SELECT is((SELECT count(*)::int FROM client_errors
           WHERE org_id = '60000000-0000-4000-8000-000000000002'), 0,
  'очистка не вышла за пределы своей организации');

SELECT * FROM finish();
ROLLBACK;
