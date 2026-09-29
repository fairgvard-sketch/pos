-- pgTAP: ANGLE Guest service requests (172).
BEGIN;
SELECT plan(36);

-- ── Contract and privileges ────────────────────────────────
SELECT has_table('service_requests', 'service_requests exists');
SELECT has_table('service_request_events', 'append-only request history exists');
SELECT has_function('submit_service_request', ARRAY['uuid', 'uuid', 'uuid', 'text']);
SELECT has_function('get_service_request_status', ARRAY['uuid']);
SELECT has_function('set_service_request_status', ARRAY['uuid', 'text', 'uuid']);
SELECT ok(
  has_table_privilege('authenticated', 'service_requests', 'SELECT'),
  'POS can read org-scoped tasks'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'service_requests', 'INSERT,UPDATE,DELETE'),
  'POS cannot bypass task transition RPC'
);
SELECT ok(
  NOT has_table_privilege('anon', 'service_requests', 'SELECT,INSERT,UPDATE,DELETE'),
  'anonymous browser has no direct table access'
);
SELECT ok(
  NOT has_function_privilege('anon', 'submit_service_request(uuid,uuid,uuid,text)', 'EXECUTE'),
  'anon cannot call submit RPC directly'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'submit_service_request(uuid,uuid,uuid,text)', 'EXECUTE'),
  'authenticated client cannot impersonate public Edge validation'
);
SELECT ok(
  has_function_privilege('authenticated', 'set_service_request_status(uuid,text,uuid)', 'EXECUTE'),
  'POS can transition a request with a staff session'
);

-- ── Fixture ────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Guest service org'),
  ('a0000000-0000-4000-8000-000000000002', 'Other org');
INSERT INTO locations (id, org_id, name, service_mode) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Guest service loc', 'tables'),
  ('a1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'Other loc', 'tables');
INSERT INTO organization_products (org_id, product) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'online_orders'),
  ('a0000000-0000-4000-8000-000000000002', 'online_orders');
INSERT INTO tables (id, org_id, location_id, label, public_token) VALUES
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', '12', 'a2100000-0000-4000-8000-000000000001');
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Server', 'barista', 'unused');
INSERT INTO staff_sessions (token, staff_id, org_id, location_id) VALUES
  ('a3100000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001');
INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float) VALUES
  ('a3200000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
   'open', 0);

SELECT ok(
  org_has_capability_at(
    'a0000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'table_service'
  ),
  'ANGLE Orders entitlement enables table_service'
);

UPDATE locations SET service_mode = 'counter'
WHERE id = 'a1000000-0000-4000-8000-000000000001';
SELECT throws_ok($$
  SELECT submit_service_request(
    'a1000000-0000-4000-8000-000000000001',
    'a2100000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000010',
    'water')
$$, 'service_unavailable', 'counter-only location cannot create orphan table tasks');
UPDATE locations SET service_mode = 'tables'
WHERE id = 'a1000000-0000-4000-8000-000000000001';

UPDATE shifts SET status = 'closed'
WHERE id = 'a3200000-0000-4000-8000-000000000001';
SELECT throws_ok($$
  SELECT submit_service_request(
    'a1000000-0000-4000-8000-000000000001',
    'a2100000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000011',
    'water')
$$, 'service_unavailable', 'closed shift cannot receive an unstaffed service task');
UPDATE shifts SET status = 'open'
WHERE id = 'a3200000-0000-4000-8000-000000000001';

-- ── Public creation, idempotency and deduplication ─────────
SELECT is(
  submit_service_request(
    'a1000000-0000-4000-8000-000000000001',
    'a2100000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    'water'
  ) ->> 'status',
  'new',
  'valid table QR creates a new request'
);
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM service_requests
   WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
  1,
  'one task row is stored'
);
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM service_request_events
   WHERE service_request_id = (
     SELECT id FROM service_requests WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'
   ) AND status = 'new'),
  1,
  'creation is recorded in append-only history'
);
SELECT is(
  submit_service_request(
    'a1000000-0000-4000-8000-000000000001',
    'a2100000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    'water'
  ) ->> 'duplicate',
  'true',
  'same client_uuid is idempotent'
);
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM service_requests
   WHERE table_id = 'a2000000-0000-4000-8000-000000000001' AND kind = 'water'),
  1,
  'idempotent retry does not add a second task'
);
SELECT is(
  submit_service_request(
    'a1000000-0000-4000-8000-000000000001',
    'a2100000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000002',
    'water'
  ) ->> 'client_uuid',
  'a4000000-0000-4000-8000-000000000001',
  'same active table request is joined instead of duplicated'
);
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM service_requests
   WHERE table_id = 'a2000000-0000-4000-8000-000000000001' AND kind = 'water'),
  1,
  'deduplication leaves one staff task'
);
SELECT throws_ok($$
  SELECT submit_service_request(
    'a1000000-0000-4000-8000-000000000001',
    'a2100000-0000-4000-8000-000000000099',
    'a4000000-0000-4000-8000-000000000003',
    'water')
$$, 'invalid_table', 'unknown table token is rejected');
SELECT throws_ok($$
  SELECT submit_service_request(
    'a1000000-0000-4000-8000-000000000001',
    'a2100000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000003',
    'open_cash_drawer')
$$, 'invalid_kind', 'request kind is an allow-list');
SELECT is(
  submit_service_request(
    'a1000000-0000-4000-8000-000000000001',
    'a2100000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000004',
    'bread'
  ) ->> 'status',
  'new',
  'expanded waiter-request allow-list accepts bread'
);
SELECT is(
  get_service_request_status('a4000000-0000-4000-8000-000000000001') ->> 'status',
  'new',
  'guest can poll the created request through the service-role RPC'
);

-- ── Strict POS lifecycle ────────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"a0000000-0000-4000-8000-000000000001","location_id":"a1000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok($$
  SELECT set_service_request_status(
    (SELECT id FROM service_requests WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
    'accepted', NULL)
$$, 'staff session required', 'new task cannot be accepted without a PIN session');
SELECT lives_ok($$
  SELECT set_service_request_status(
    (SELECT id FROM service_requests WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
    'accepted', 'a3100000-0000-4000-8000-000000000001')
$$, 'staff accepts request in one action');
SELECT is(
  (SELECT status FROM service_requests
   WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
  'accepted',
  'request is accepted'
);
SELECT ok(
  (SELECT accepted_at IS NOT NULL FROM service_requests
   WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
  'acceptance timestamp is captured'
);
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM service_request_events
   WHERE service_request_id = (
     SELECT id FROM service_requests WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'
   ) AND status = 'accepted'),
  1,
  'acceptance is recorded in history'
);
SELECT lives_ok($$
  SELECT set_service_request_status(
    (SELECT id FROM service_requests WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
    'completed', 'a3100000-0000-4000-8000-000000000001')
$$, 'accepted request completes in one action');
SELECT is(
  (SELECT status FROM service_requests
   WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
  'completed',
  'request is completed'
);
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM service_request_events
   WHERE service_request_id = (
     SELECT id FROM service_requests WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'
   )),
  3,
  'history contains new, accepted and completed'
);
SELECT lives_ok($$
  SELECT set_service_request_status(
    (SELECT id FROM service_requests WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
    'completed', 'a3100000-0000-4000-8000-000000000001')
$$, 'replayed completion is idempotent');
SELECT throws_ok($$
  SELECT set_service_request_status(
    (SELECT id FROM service_requests WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
    'accepted', 'a3100000-0000-4000-8000-000000000001')
$$, 'already_closed', 'closed request cannot move backwards');

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a5000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"a0000000-0000-4000-8000-000000000002","location_id":"a1000000-0000-4000-8000-000000000002"}}',
  true
);
SELECT throws_ok($$
  SELECT set_service_request_status(
    (SELECT id FROM service_requests WHERE client_uuid = 'a4000000-0000-4000-8000-000000000001'),
    'completed', 'a3100000-0000-4000-8000-000000000001')
$$, 'staff session invalid', 'staff session from another organization cannot touch the task');

SELECT * FROM finish();
ROLLBACK;
