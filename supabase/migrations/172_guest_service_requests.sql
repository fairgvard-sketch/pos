-- ============================================================
-- 172: ANGLE Guest — отслеживаемые запросы обслуживания стола
--
-- Первый вертикальный срез Live Table:
--   гость по QR стола создаёт запрос → сотрудник принимает → завершает →
--   гость видит фактический статус. Публичный браузер не читает таблицы
--   напрямую: submit/get закрыты на service_role и вызываются Edge Function.
--
-- `client_uuid` — секрет отслеживания и ключ идемпотентности. Статический
-- table public_token только разрешает стол; внутренний table_id наружу не
-- уходит. Повтор одинаковой активной просьбы одного стола схлопывается, чтобы
-- несколько телефонов не создавали notification fatigue персоналу.
-- ============================================================

INSERT INTO product_capabilities (product, capability)
VALUES ('online_orders', 'table_service')
ON CONFLICT DO NOTHING;

-- Публичное меню одним вызовом узнаёт, включён ли сервисный слой.
CREATE OR REPLACE FUNCTION org_public_menu_gates(p_org UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'public_menu',   org_has_capability(p_org, 'public_menu'),
    'online_orders', org_has_capability(p_org, 'online_orders'),
    'table_service', org_has_capability(p_org, 'table_service'),
    'pos',           org_has_product(p_org, 'pos')
  )
$$;

REVOKE ALL ON FUNCTION org_public_menu_gates(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION org_public_menu_gates(UUID) TO service_role;

CREATE TABLE service_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  table_id       UUID NOT NULL REFERENCES tables(id),
  table_label    TEXT NOT NULL,
  client_uuid    UUID NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'call_waiter', 'water', 'cutlery', 'napkins',
                   'problem', 'bill')),
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
                   'new', 'accepted', 'completed', 'cancelled')),
  accepted_by    UUID REFERENCES staff(id),
  completed_by   UUID REFERENCES staff(id),
  cancelled_by   UUID REFERENCES staff(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at    TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_service_requests_location_active
  ON service_requests(location_id, status, created_at)
  WHERE status IN ('new', 'accepted');
CREATE INDEX idx_service_requests_table_created
  ON service_requests(table_id, created_at DESC);

ALTER TABLE service_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_requests_select ON service_requests
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

REVOKE ALL ON service_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON service_requests TO authenticated;
GRANT ALL ON service_requests TO service_role;

ALTER PUBLICATION supabase_realtime ADD TABLE service_requests;

COMMENT ON TABLE service_requests IS
  'ANGLE Guest: просьбы стола new → accepted → completed/cancelled; публичная запись только через service_role RPC.';
COMMENT ON COLUMN service_requests.client_uuid IS
  'Непрозрачный ключ идемпотентности и публичного поллинга статуса.';

-- Append-only история нужна для метрик времени реакции и разбора пропущенных
-- просьб. Клиенты не могут её менять; событие пишет триггер основной таблицы.
CREATE TABLE service_request_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id        UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  service_request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK (status IN (
                       'new', 'accepted', 'completed', 'cancelled')),
  actor_staff        UUID REFERENCES staff(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_service_request_events_request
  ON service_request_events(service_request_id, created_at);

ALTER TABLE service_request_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_request_events_select ON service_request_events
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

REVOKE ALL ON service_request_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON service_request_events TO authenticated;
GRANT ALL ON service_request_events TO service_role;

CREATE OR REPLACE FUNCTION service_requests_log_event()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  v_actor := CASE NEW.status
    WHEN 'accepted'  THEN NEW.accepted_by
    WHEN 'completed' THEN NEW.completed_by
    WHEN 'cancelled' THEN NEW.cancelled_by
    ELSE NULL
  END;

  INSERT INTO service_request_events (
    org_id, location_id, service_request_id, status, actor_staff, created_at
  ) VALUES (
    NEW.org_id, NEW.location_id, NEW.id, NEW.status, v_actor,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.created_at ELSE NOW() END
  );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_service_requests_events ON service_requests;
CREATE TRIGGER trg_service_requests_events
  AFTER INSERT OR UPDATE ON service_requests
  FOR EACH ROW EXECUTE FUNCTION service_requests_log_event();

-- ── Публичное создание: service_role only ──────────────────
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
  IF p_kind NOT IN ('call_waiter', 'water', 'cutlery', 'napkins', 'problem', 'bill') THEN
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

  -- Сериализуем повтор клиента и все просьбы одного стола. Иначе два
  -- телефона, нажавшие одновременно, успеют оба пройти SELECT/лимит до INSERT.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('service-client:' || p_client_uuid::TEXT, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('service-table:' || v_table.id::TEXT, 0)
  );

  -- Идемпотентный повтор того же браузера.
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

  -- Одинаковая активная просьба одного стола — одна задача персоналу.
  -- Второй телефон присоединяется к ней и поллит тот же непрозрачный UUID.
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

  -- QR публичен: ограничиваем спам по столу, а не только по UUID клиента.
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

-- ── Публичный статус: client_uuid является секретом ─────────
CREATE OR REPLACE FUNCTION get_service_request_status(p_client_uuid UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request service_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request
  FROM service_requests
  WHERE client_uuid = p_client_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT org_has_capability_at(
    v_request.org_id, v_request.location_id, 'table_service'
  ) THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  RETURN jsonb_build_object(
    'client_uuid', v_request.client_uuid,
    'kind', v_request.kind,
    'status', v_request.status,
    'table_label', v_request.table_label,
    'created_at', v_request.created_at,
    'accepted_at', v_request.accepted_at,
    'completed_at', v_request.completed_at
  );
END $$;

REVOKE ALL ON FUNCTION get_service_request_status(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_service_request_status(UUID) TO service_role;

-- ── Касса: один тап принимает, следующий завершает ──────────
CREATE OR REPLACE FUNCTION set_service_request_status(
  p_request_id   UUID,
  p_status       TEXT,
  p_staff_session UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor   UUID;
  v_request service_requests%ROWTYPE;
BEGIN
  IF p_status NOT IN ('accepted', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  -- В отличие от старого горячего потока, новый endpoint сразу строгий:
  -- анонимное устройство не может принимать/закрывать просьбы гостя.
  IF p_staff_session IS NULL THEN
    RAISE EXCEPTION 'staff session required';
  END IF;
  v_actor := require_staff_session(p_staff_session);
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'staff session required';
  END IF;

  PERFORM require_location_capability('table_service');

  SELECT * INTO v_request
  FROM service_requests
  WHERE id = p_request_id
    AND org_id = auth_org_id()
    AND location_id = auth_location_id()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Повтор replay безопасен. Обратные переходы запрещены.
  IF v_request.status = p_status THEN
    RETURN jsonb_build_object('id', v_request.id, 'status', v_request.status);
  END IF;
  IF v_request.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'already_closed';
  END IF;
  IF v_request.status = 'new' AND p_status = 'completed' THEN
    RAISE EXCEPTION 'accept_first';
  END IF;

  UPDATE service_requests
  SET status = p_status,
      accepted_by = CASE WHEN p_status = 'accepted' THEN v_actor ELSE accepted_by END,
      accepted_at = CASE WHEN p_status = 'accepted' THEN NOW() ELSE accepted_at END,
      completed_by = CASE WHEN p_status = 'completed' THEN v_actor ELSE completed_by END,
      completed_at = CASE WHEN p_status = 'completed' THEN NOW() ELSE completed_at END,
      cancelled_by = CASE WHEN p_status = 'cancelled' THEN v_actor ELSE cancelled_by END,
      cancelled_at = CASE WHEN p_status = 'cancelled' THEN NOW() ELSE cancelled_at END,
      updated_at = NOW()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  RETURN jsonb_build_object('id', v_request.id, 'status', v_request.status);
END $$;

REVOKE ALL ON FUNCTION set_service_request_status(UUID, TEXT, UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_service_request_status(UUID, TEXT, UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION submit_service_request(UUID, UUID, UUID, TEXT) IS
  'ANGLE Guest 172: idempotent service task from verified table QR; service_role only.';
COMMENT ON FUNCTION set_service_request_status(UUID, TEXT, UUID) IS
  'ANGLE Guest 172: strict staff-session transition new → accepted → completed/cancelled.';
