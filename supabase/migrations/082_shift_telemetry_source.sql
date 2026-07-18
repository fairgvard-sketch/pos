-- 082: источник телеметрии 'shift' — событие shift_overdue.
--
-- Защита от висящих смен (P1): касса шлёт shift_overdue в журнал 074, когда
-- открытая смена пересекла границу операционного дня (settings.shift.day_cutoff,
-- дефолт 04:00). До применения миграции старый сервер тихо клампит неизвестный
-- source в 'window' — событие не теряется, порядок релиза не критичен.

ALTER TABLE client_errors DROP CONSTRAINT client_errors_source_check;
ALTER TABLE client_errors ADD CONSTRAINT client_errors_source_check
  CHECK (source IN ('window', 'promise', 'react', 'outbox', 'print', 'shift'));

-- Валидация внутри report_client_errors — тот же список (тело из 074,
-- изменена только строка допустимых source).
CREATE OR REPLACE FUNCTION report_client_errors(
  p_device_uuid UUID,
  p_errors      JSONB
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  IF p_device_uuid IS NULL OR jsonb_typeof(p_errors) <> 'array' THEN
    RAISE EXCEPTION 'errors must be a json array';
  END IF;

  DELETE FROM client_errors
  WHERE org_id = v_org AND last_seen_at < NOW() - INTERVAL '30 days';

  SELECT COUNT(*) INTO v_today
  FROM client_errors
  WHERE org_id = v_org AND device_uuid = p_device_uuid AND day = CURRENT_DATE;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_errors) LIMIT 20 LOOP
    v_fp := LEFT(v_elem ->> 'fingerprint', 64);
    IF v_fp IS NULL OR v_elem ->> 'message' IS NULL THEN
      CONTINUE;  -- битый элемент не валит остальной пакет
    END IF;

    v_source := v_elem ->> 'source';
    IF v_source NOT IN ('window', 'promise', 'react', 'outbox', 'print', 'shift') THEN
      v_source := 'window';
    END IF;
    v_count := LEAST(GREATEST(COALESCE((v_elem ->> 'count')::INTEGER, 1), 1), 1000);

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
      LEFT(v_elem ->> 'stack', 4000),
      LEFT(v_elem ->> 'route', 200),
      LEFT(v_elem ->> 'app_version', 32),
      LEFT(v_elem ->> 'user_agent', 256),
      v_count
    )
    ON CONFLICT (org_id, device_uuid, fingerprint, day) DO UPDATE SET
      count        = client_errors.count + EXCLUDED.count,
      last_seen_at = NOW()
    RETURNING (xmax = 0)::INTEGER INTO v_is_new;

    v_today := v_today + v_is_new;
    v_accepted := v_accepted + 1;
  END LOOP;

  RETURN v_accepted;
END $$;

REVOKE EXECUTE ON FUNCTION report_client_errors FROM anon, public;
GRANT EXECUTE ON FUNCTION report_client_errors(UUID, JSONB)
  TO authenticated, service_role;
