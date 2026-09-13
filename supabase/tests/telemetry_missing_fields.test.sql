-- pgTAP: обязательные строковые поля элемента телеметрии (170, R1).
--
-- Регрессия первой версии 170: проверка `jsonb_typeof(v_elem -> 'fingerprint')
-- <> 'string'` у ОТСУТСТВУЮЩЕГО ключа даёт SQL NULL, поэтому IF не срабатывал,
-- элемент доходил до INSERT и валил весь пакет с 23502 — вместе с валидным
-- соседом. На неизменённой 169 тот же пакет принимался. Здесь каждая форма
-- битого поля проверяется отдельно: отсутствующий ключ, JSON null,
-- object/array/number/boolean вместо строки и пустой fingerprint. Каждый
-- случай прогоняется дважды: битый элемент ПОСЛЕ и ПЕРЕД валидным соседом.
--
-- Проверяется тройка: вызов не бросает исключение, RPC вернул ровно 1
-- принятый элемент, и в таблице появилась ровно одна новая строка — именно
-- валидный сосед. Пределы 20/дедупликация/count из 082 проверены отдельно
-- в конце файла, чтобы правка обязательных полей их не ослабила.

BEGIN;
SELECT plan(94);

INSERT INTO orgs (id, name)
  VALUES ('7a000000-0000-4000-8000-000000000001', 'Org missing-fields');
INSERT INTO locations (id, org_id, name)
  VALUES ('7b000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 'Point');
INSERT INTO auth.users (id) VALUES ('7c000000-0000-4000-8000-000000000001');
INSERT INTO devices (org_id, location_id, name, device_uuid, auth_user_id, settings)
  VALUES ('7a000000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000001',
          'Till', '7d000000-0000-4000-8000-000000000001',
          '7c000000-0000-4000-8000-000000000001', '{}');

-- Вызов идёт от роли authenticated; client_errors ей недоступна, поэтому
-- состояние читается отдельным SECURITY DEFINER наблюдателем.
CREATE FUNCTION pg_temp.seen(p_fp TEXT) RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)::INTEGER FROM public.client_errors
  WHERE device_uuid = '7d000000-0000-4000-8000-000000000001' AND fingerprint = p_fp;
$$;
CREATE FUNCTION pg_temp.total() RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)::INTEGER FROM public.client_errors
  WHERE device_uuid = '7d000000-0000-4000-8000-000000000001';
$$;
CREATE FUNCTION pg_temp.count_of(p_fp TEXT) RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COALESCE(SUM(count), 0)::INTEGER FROM public.client_errors
  WHERE device_uuid = '7d000000-0000-4000-8000-000000000001' AND fingerprint = p_fp;
$$;
CREATE FUNCTION pg_temp.message_of(p_fp TEXT) RETURNS TEXT
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT message FROM public.client_errors
  WHERE device_uuid = '7d000000-0000-4000-8000-000000000001' AND fingerprint = p_fp;
$$;

-- Один прогон от имени authenticated: возвращает 'accepted|delta|sibling'
-- либо SQLSTATE, если пакет всё-таки упал.
CREATE FUNCTION pg_temp.send(p_payload JSONB) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_before INTEGER; v_accepted INTEGER; v_state TEXT;
BEGIN
  v_before := pg_temp.total();
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims',
    '{"sub":"7c000000-0000-4000-8000-000000000001","role":"authenticated",'
    || '"app_metadata":{"org_id":"7a000000-0000-4000-8000-000000000001",'
    || '"location_id":"7b000000-0000-4000-8000-000000000001"}}', true);
  BEGIN
    v_accepted := report_client_errors('7d000000-0000-4000-8000-000000000001', p_payload);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE || ': ' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  IF v_state IS NOT NULL THEN
    RETURN 'batch failed with ' || v_state;
  END IF;
  RETURN v_accepted::TEXT || '|' || (pg_temp.total() - v_before)::TEXT;
END $$;

-- ── Матрица битых обязательных полей ──
-- Каждый случай — дважды: сосед первым и сосед вторым.
CREATE FUNCTION pg_temp.matrix() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $$
DECLARE
  c RECORD; reversed BOOLEAN; fp TEXT; sibling JSONB; payload JSONB; label TEXT;
  n INTEGER := 0;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('missing_fp',      '{"message":"synthetic message"}'::JSONB,        'ключ fingerprint отсутствует'),
    ('missing_message', '{"fingerprint":"bad"}'::JSONB,                  'ключ message отсутствует'),
    ('empty_object',    '{}'::JSONB,                                     'пустой объект без обоих ключей'),
    ('fp_json_null',    '{"fingerprint":null,"message":"m"}'::JSONB,     'fingerprint = JSON null'),
    ('fp_object',       '{"fingerprint":{"a":1},"message":"m"}'::JSONB,  'fingerprint — объект'),
    ('fp_array',        '{"fingerprint":["a"],"message":"m"}'::JSONB,    'fingerprint — массив'),
    ('fp_number',       '{"fingerprint":7,"message":"m"}'::JSONB,        'fingerprint — число'),
    ('fp_boolean',      '{"fingerprint":true,"message":"m"}'::JSONB,     'fingerprint — boolean'),
    ('fp_empty',        '{"fingerprint":"","message":"m"}'::JSONB,       'пустой fingerprint'),
    ('msg_json_null',   '{"fingerprint":"m_null","message":null}'::JSONB,'message = JSON null'),
    ('msg_object',      '{"fingerprint":"m_obj","message":{"a":1}}'::JSONB, 'message — объект'),
    ('msg_array',       '{"fingerprint":"m_arr","message":["m"]}'::JSONB,'message — массив'),
    ('msg_number',      '{"fingerprint":"m_num","message":7}'::JSONB,    'message — число'),
    ('msg_boolean',     '{"fingerprint":"m_bool","message":false}'::JSONB,'message — boolean')
  ) AS cases(name, bad, human)
  LOOP
    FOREACH reversed IN ARRAY ARRAY[false, true] LOOP
      fp := c.name || CASE WHEN reversed THEN '_first' ELSE '_last' END;
      label := c.human || CASE WHEN reversed THEN ' (перед соседом)' ELSE ' (после соседа)' END;
      sibling := jsonb_build_array(jsonb_build_object(
        'fingerprint', fp, 'message', 'valid sibling', 'source', 'react'));
      payload := CASE WHEN reversed
        THEN jsonb_build_array(c.bad) || sibling
        ELSE sibling || jsonb_build_array(c.bad) END;
      RETURN NEXT is(pg_temp.send(payload), '1|1', label || ': пакет цел, принят ровно один элемент');
      RETURN NEXT is(pg_temp.seen(fp), 1, label || ': валидный сосед сохранён');
      -- Накопительный инвариант: после i-го прогона в таблице ровно i строк,
      -- то есть ни один битый элемент не завёл собственную строку и ни один
      -- сосед не потерялся при откате пакета.
      n := n + 1;
      RETURN NEXT is(pg_temp.total(), n, label || ': битый элемент не создал собственной строки');
    END LOOP;
  END LOOP;
END $$;
SELECT * FROM pg_temp.matrix();

-- ── Контракт message: пустая строка остаётся допустимой ──
SELECT is(pg_temp.send('[{"fingerprint":"empty_message","message":"","source":"react"}]'::JSONB),
  '1|1', 'пустая строка в message принимается: контракт не ужесточается');
SELECT is(pg_temp.message_of('empty_message'), '',
  'пустое сообщение сохранено как пустая строка, а не NULL');

-- ── Прежние пределы 082 не ослаблены битыми элементами ──
-- 25 элементов, первые пять без message: предел 20 считается по элементам
-- пакета, а не по принятым, поэтому проходит ровно 15.
SELECT is(pg_temp.send((
    SELECT jsonb_agg(e) FROM (
      SELECT '{"fingerprint":"skip_me"}'::JSONB AS e FROM generate_series(1, 5)
      UNION ALL
      SELECT jsonb_build_object('fingerprint', 'cap_' || i, 'message', 'm', 'source', 'react')
      FROM generate_series(1, 20) i
    ) AS parts)), '15|15',
  'предел 20 элементов на вызов сохранён при битых элементах в пакете');
SELECT is(pg_temp.seen('skip_me'), 0, 'битые элементы не заняли строк при переполненном пакете');

-- Дедупликация и count через битый элемент между двумя одинаковыми.
SELECT is(pg_temp.send('[{"fingerprint":"dedup_fp","message":"m","source":"react"},
   {"message":"no fingerprint"},
   {"fingerprint":"dedup_fp","message":"m","source":"react","count":4}]'::JSONB), '2|1',
  'дедупликация переживает битый элемент между повторами');
SELECT is(pg_temp.seen('dedup_fp'), 1, 'повтор схлопнут в одну строку');
SELECT is(pg_temp.count_of('dedup_fp'), 5, 'count просуммирован (1+4), нормализация сохранена');

-- Пакет целиком из битых элементов: понятный ноль, без записей и исключения.
SELECT is(pg_temp.send('[{},{"message":"m"},{"fingerprint":"x"},{"fingerprint":null,"message":null}]'::JSONB),
  '0|0', 'пакет только из битых элементов принимает ноль и не падает');
SELECT is(pg_temp.seen('x'), 0, 'элемент без message не создал строку');
SELECT is(pg_temp.seen('m_null'), 0, 'элемент с message = null не создал строку');

SELECT * FROM finish();
ROLLBACK;
