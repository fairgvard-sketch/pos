-- pgTAP: stock_report.counts (085) — «инвентаризация была» отличимо от
-- «не проверяли», даже когда поправка нулевая.

BEGIN;
SELECT plan(3);

-- ── Фикстуры (паттерн stock_flow.test.sql) ───────────────────
INSERT INTO orgs (id, name) VALUES
  ('45000000-0000-4000-8000-000000000001', 'pgTAP org V');
INSERT INTO locations (id, org_id, name) VALUES
  ('45100000-0000-4000-8000-000000000001',
   '45000000-0000-4000-8000-000000000001', 'Loc V');
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('45200000-0000-4000-8000-000000000001',
        '45000000-0000-4000-8000-000000000001',
        '45100000-0000-4000-8000-000000000001',
        'pgTAP owner', 'owner', 'unused-in-test');

INSERT INTO supply_items (id, org_id, location_id, name, unit, stock, cost) VALUES
  ('45600000-0000-4000-8000-000000000001',
   '45000000-0000-4000-8000-000000000001',
   '45100000-0000-4000-8000-000000000001', 'Стаканы', 'шт', 0, 50),
  ('45600000-0000-4000-8000-000000000002',
   '45000000-0000-4000-8000-000000000001',
   '45100000-0000-4000-8000-000000000001', 'Крышки', 'шт', 0, 30);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"45c00000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"45000000-0000-4000-8000-000000000001","location_id":"45100000-0000-4000-8000-000000000001"}}',
  true
);

-- Приход обоих, затем инвентаризация ТОЛЬКО стаканов — ровно в ноль
SELECT receive_stock(
  '45200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"45600000-0000-4000-8000-000000000001","qty":100,"unit_cost":50},
    {"kind":"supply","supply_item_id":"45600000-0000-4000-8000-000000000002","qty":100,"unit_cost":30}]'::jsonb
);
SELECT stock_take(
  '45200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"45600000-0000-4000-8000-000000000001","counted":100}]'::jsonb
);

CREATE TEMP TABLE rep AS
SELECT stock_report(NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 hour') AS r;

SELECT is(
  (SELECT (i ->> 'counts')::int FROM rep, jsonb_array_elements((SELECT r -> 'items' FROM rep)) i
    WHERE i ->> 'name' = 'Стаканы'),
  1,
  'нулевая инвентаризация стаканов видна: counts = 1'
);
SELECT is(
  (SELECT (i ->> 'count_adj')::int FROM rep, jsonb_array_elements((SELECT r -> 'items' FROM rep)) i
    WHERE i ->> 'name' = 'Стаканы'),
  0,
  'поправка при точном совпадении — ноль'
);
SELECT is(
  (SELECT (i ->> 'counts')::int FROM rep, jsonb_array_elements((SELECT r -> 'items' FROM rep)) i
    WHERE i ->> 'name' = 'Крышки'),
  0,
  'крышки не проверяли: counts = 0'
);

SELECT * FROM finish();
ROLLBACK;
