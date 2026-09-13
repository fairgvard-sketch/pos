-- 170: серверные границы приёма телеметрии (F6.2).
--
-- Клиентская очистка (F6.1) — не граница: report_client_errors принимает
-- произвольный JSON от произвольного клиента. На 169 воспроизводится четыре
-- дефекта:
--   1. p_device_uuid не сверялся с devices — авторизованная касса писала
--      диагностику от имени чужого устройства (другой сотрудник, другая
--      точка, другая организация) и от имени вовсе неизвестного UUID;
--   2. элемент без 'source' либо с 'source': null давал NOT NULL violation
--      (23502) и валил ВЕСЬ пакет, включая валидные элементы рядом;
--   3. прямой cast (v_elem ->> 'count')::INTEGER валил весь пакет на строке
--      (22P02), дроби (22P02) и значении за пределами INTEGER (22003);
--   4. счётчик повторов рос как INTEGER + INTEGER: на горячем fingerprint
--      сумма упиралась в 2^31 и весь пакет падал с 22003.
-- Плюс: SQL NULL вместо массива проходил как пустой пакет (jsonb_typeof(NULL)
-- — это NULL, а не 'null'); дневной лимит новых fingerprint считался COUNT-ом
-- до INSERT, поэтому два параллельных соединения на 99 строках оставляли 101;
-- 30-дневная очистка запускалась и для чужого device_uuid.
--
-- Та же ловушка NULL действует и на уровне элемента: у отсутствующего ключа
-- jsonb_typeof(v_elem -> 'fingerprint') возвращает SQL NULL, поэтому проверка
-- через `<> 'string'` пропускала элемент без fingerprint/message в INSERT и
-- роняла весь пакет (23502). Сравнение идёт через IS DISTINCT FROM.
--
-- Здесь закрываются все пять. Подпись и формат ответа не меняются: RPC
-- по-прежнему report_client_errors(uuid, jsonb) -> INTEGER, новых клиентских
-- параметров нет, 082-поведение (шесть source, клампинг неизвестного в
-- 'window', дедупликация) сохранено.

-- ── Принадлежность устройства ──
-- UUID — ключ поиска, а не право писать от имени устройства (та же модель,
-- что в register_device 169). Сверяется тройка org + location + auth_user_id.
-- archived_at намеренно не проверяется: архив остаётся косметическим
-- признаком, а архивная касса должна уметь сообщить о своей же ошибке.
-- Одна учётка с несколькими device_uuid остаётся рабочей моделью.
CREATE FUNCTION telemetry_device_belongs_to_caller(p_device_uuid UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.devices d
    WHERE d.device_uuid = p_device_uuid
      AND d.org_id = auth_org_id()
      AND d.location_id = auth_location_id()
      AND d.auth_user_id = auth.uid()
  )
$$;
REVOKE ALL ON FUNCTION telemetry_device_belongs_to_caller(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION telemetry_device_belongs_to_caller(UUID) TO service_role;

CREATE OR REPLACE FUNCTION report_client_errors(
  p_device_uuid UUID,
  p_errors      JSONB
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org      UUID := auth_org_id();
  v_loc      UUID := auth_location_id();
  v_uid      UUID := auth.uid();
  v_elem     JSONB;
  v_fp       TEXT;
  v_source   TEXT;
  v_count    INTEGER;
  v_is_new   INTEGER;
  v_today    INTEGER;
  v_accepted INTEGER := 0;
BEGIN
  IF v_org IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  -- p_errors IS NULL проверяется отдельно: jsonb_typeof(NULL) — это NULL,
  -- поэтому NULL <> 'array' не TRUE, и SQL NULL проходил как пустой пакет,
  -- молча возвращая 0 и запуская при этом 30-дневную очистку.
  IF p_device_uuid IS NULL OR p_errors IS NULL OR jsonb_typeof(p_errors) <> 'array' THEN
    RAISE EXCEPTION 'errors must be a json array';
  END IF;

  -- Как в 169: ужесточение применяется к клиентской роли, доверенные
  -- серверные/операторские вызовы сохраняют прежнюю семантику. anon сюда
  -- не дотягивается — EXECUTE у него отозван.
  IF current_setting('role', TRUE) = 'authenticated'
     AND NOT telemetry_device_belongs_to_caller(p_device_uuid) THEN
    RAISE EXCEPTION 'device_not_registered'
      USING HINT = 'diagnostics are accepted only for this account''s own registered device';
  END IF;

  -- Хвост чистится только после проверки принадлежности: чужой вызов не
  -- должен запускать удаление в чужой организации. Это по-прежнему
  -- оппортунистическая очистка при поступлении ошибок, а не гарантия
  -- удаления всех данных через 30 дней (см. docs/deployment.md).
  DELETE FROM client_errors
  WHERE org_id = v_org AND last_seen_at < NOW() - INTERVAL '30 days';

  -- Дневной лимит считается COUNT-ом и применяется при INSERT: между ними
  -- параллельное соединение успевало вставить свой новый fingerprint, и на
  -- 99 строках двое оставляли 101. Блокировка берётся на пару
  -- org+device — ровно на спорный счётчик, без глобальной сериализации
  -- организаций и устройств. Коллизия хеша лишь сериализует лишнюю пару.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_org::TEXT || '/' || p_device_uuid::TEXT, 0));

  SELECT COUNT(*) INTO v_today
  FROM client_errors
  WHERE org_id = v_org AND device_uuid = p_device_uuid AND day = CURRENT_DATE;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_errors) LIMIT 20 LOOP
    -- Структурная проверка вместо EXCEPTION WHEN OTHERS: битый элемент
    -- пропускается, валидные соседи сохраняются, а настоящий сбой БД
    -- остаётся сбоем и не выдаётся за успешный приём.
    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;
    -- Сравнение через IS DISTINCT FROM, а не через <>: у отсутствующего ключа
    -- v_elem -> 'fingerprint' — это SQL NULL, jsonb_typeof(NULL) тоже NULL,
    -- поэтому NULL <> 'string' — NULL, а не TRUE: IF не срабатывал, элемент
    -- без 'fingerprint'/'message' доходил до INSERT и валил ВЕСЬ пакет с 23502,
    -- вместе с валидным соседом. Одна проверка покрывает все случаи сразу:
    -- отсутствующий ключ, JSON null и object/array/number/boolean вместо
    -- строки. Общий EXCEPTION здесь не годится — он прячет настоящий сбой БД.
    IF jsonb_typeof(v_elem -> 'fingerprint') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_elem -> 'message') IS DISTINCT FROM 'string' THEN
      CONTINUE;
    END IF;
    v_fp := LEFT(v_elem ->> 'fingerprint', 64);
    -- Пустой fingerprint пропускается; пустая строка в message остаётся
    -- допустимой — контракт 082 здесь не меняется.
    IF v_fp IS NULL OR v_fp = '' THEN
      CONTINUE;  -- пустой fingerprint не дедуплицируется осмысленно
    END IF;

    v_source := v_elem ->> 'source';
    -- NULL/отсутствующий source раньше уходил в INSERT как NULL и валил
    -- пакет: NULL NOT IN (...) — это NULL, а не TRUE.
    IF v_source IS NULL
       OR v_source NOT IN ('window', 'promise', 'react', 'outbox', 'print', 'shift') THEN
      v_source := 'window';
    END IF;

    -- count берётся только из JSON-числа: строка/дробь/выход за INTEGER
    -- больше не роняют пакет. Нечисловой count — это 1, границы 1…1000
    -- прежние.
    v_count := 1;
    IF jsonb_typeof(v_elem -> 'count') = 'number' THEN
      v_count := LEAST(GREATEST(FLOOR((v_elem -> 'count')::NUMERIC), 1), 1000)::INTEGER;
    END IF;

    IF v_today >= 100 AND NOT EXISTS (
      SELECT 1 FROM client_errors
      WHERE org_id = v_org AND device_uuid = p_device_uuid
        AND fingerprint = v_fp AND day = CURRENT_DATE
    ) THEN
      CONTINUE;  -- дневной лимит новых fingerprint исчерпан
    END IF;

    INSERT INTO client_errors (
      org_id, location_id, device_uuid, fingerprint, source, message,
      stack, route, app_version, user_agent, count
    ) VALUES (
      v_org, v_loc, p_device_uuid, v_fp, v_source,
      LEFT(v_elem ->> 'message', 500),
      -- Нестроковые поля обнуляются, а не сериализуются в текст: объект в
      -- 'stack' иначе попадал в журнал целиком, как есть.
      CASE WHEN jsonb_typeof(v_elem -> 'stack') = 'string' THEN LEFT(v_elem ->> 'stack', 4000) END,
      CASE WHEN jsonb_typeof(v_elem -> 'route') = 'string' THEN LEFT(v_elem ->> 'route', 200) END,
      CASE WHEN jsonb_typeof(v_elem -> 'app_version') = 'string' THEN LEFT(v_elem ->> 'app_version', 32) END,
      CASE WHEN jsonb_typeof(v_elem -> 'user_agent') = 'string' THEN LEFT(v_elem ->> 'user_agent', 256) END,
      v_count
    )
    ON CONFLICT (org_id, device_uuid, fingerprint, day) DO UPDATE SET
      -- Счётчик насыщается на INTEGER max вместо падения всего пакета:
      -- сумма считается в BIGINT и подрезается. Тип колонки не меняется —
      -- 2^31 повторов одной ошибки за сутки уже означает шторм, а не счёт.
      count        = LEAST(client_errors.count::BIGINT + EXCLUDED.count::BIGINT,
                           2147483647::BIGINT)::INTEGER,
      last_seen_at = NOW()
    RETURNING (xmax = 0)::INTEGER INTO v_is_new;

    v_today := v_today + COALESCE(v_is_new, 0);
    v_accepted := v_accepted + 1;
  END LOOP;

  RETURN v_accepted;
END $$;

REVOKE EXECUTE ON FUNCTION report_client_errors FROM anon, public;
GRANT EXECUTE ON FUNCTION report_client_errors(UUID, JSONB)
  TO authenticated, service_role;
