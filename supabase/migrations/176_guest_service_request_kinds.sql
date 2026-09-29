-- ============================================================
-- 176: полный набор запросов официанту из ANGLE Live Table
--
-- Расширяет существующий отслеживаемый поток 172 без новой таблицы:
-- каждая просьба остаётся идемпотентной, видна персоналу и проходит
-- new → accepted → completed/cancelled.
-- ============================================================

ALTER TABLE service_requests
  DROP CONSTRAINT service_requests_kind_check;

ALTER TABLE service_requests
  ADD CONSTRAINT service_requests_kind_check CHECK (kind IN (
    'call_waiter', 'water', 'cutlery', 'napkins', 'bread',
    'next_course', 'hold_course', 'problem', 'bill'
  ));

CREATE OR REPLACE FUNCTION submit_service_request(
  p_location_id UUID,
  p_table_token UUID,
  p_client_uuid UUID,
  p_kind         TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_table    tables%ROWTYPE;
  v_existing service_requests%ROWTYPE;
BEGIN
  IF p_client_uuid IS NULL THEN
    RAISE EXCEPTION 'invalid_client_uuid';
  END IF;
  IF p_kind NOT IN (
    'call_waiter', 'water', 'cutlery', 'napkins', 'bread',
    'next_course', 'hold_course', 'problem', 'bill'
  ) THEN
    RAISE EXCEPTION 'invalid_kind';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;
  IF NOT org_has_capability_at(v_loc.org_id, v_loc.id, 'table_service') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  IF v_loc.service_mode <> 'tables'
     OR NOT EXISTS (
       SELECT 1 FROM shifts
       WHERE location_id = v_loc.id AND status = 'open'
     ) THEN
    RAISE EXCEPTION 'service_unavailable';
  END IF;

  SELECT * INTO v_table
  FROM tables
  WHERE location_id = p_location_id
    AND public_token = p_table_token
    AND is_active
    AND status <> 'disabled';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_table';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('service-client:' || p_client_uuid::TEXT, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('service-table:' || v_table.id::TEXT, 0)
  );

  SELECT * INTO v_existing
  FROM service_requests
  WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    IF v_existing.location_id <> p_location_id
       OR v_existing.table_id <> v_table.id
       OR v_existing.kind <> p_kind THEN
      RAISE EXCEPTION 'invalid_client_uuid';
    END IF;
    RETURN jsonb_build_object(
      'request_id', v_existing.id,
      'client_uuid', v_existing.client_uuid,
      'status', v_existing.status,
      'duplicate', TRUE
    );
  END IF;

  SELECT * INTO v_existing
  FROM service_requests
  WHERE table_id = v_table.id
    AND kind = p_kind
    AND status IN ('new', 'accepted')
  ORDER BY created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'request_id', v_existing.id,
      'client_uuid', v_existing.client_uuid,
      'status', v_existing.status,
      'duplicate', TRUE
    );
  END IF;

  IF (SELECT COUNT(*) FROM service_requests
      WHERE table_id = v_table.id
        AND created_at > NOW() - INTERVAL '15 minutes') >= 8 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT COUNT(*) FROM service_requests
      WHERE location_id = p_location_id
        AND status IN ('new', 'accepted')) >= 100 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  INSERT INTO service_requests (
    org_id, location_id, table_id, table_label, client_uuid, kind
  ) VALUES (
    v_loc.org_id, v_loc.id, v_table.id, v_table.label, p_client_uuid, p_kind
  ) RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'request_id', v_existing.id,
    'client_uuid', v_existing.client_uuid,
    'status', v_existing.status,
    'duplicate', FALSE
  );
END $$;

REVOKE ALL ON FUNCTION submit_service_request(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_service_request(UUID, UUID, UUID, TEXT)
  TO service_role;

COMMENT ON FUNCTION submit_service_request(UUID, UUID, UUID, TEXT) IS
  'ANGLE Guest 176: idempotent full waiter-request set from a verified table QR; service_role only.';
