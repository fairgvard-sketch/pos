-- pgTAP: оборотка (078) — начальный/конечный остаток по якорям журнала
-- и движение в деньгах из снапшотов value (077).
-- Запуск: supabase test db (production не затрагивается).

BEGIN;
SELECT plan(10);

-- ── Фикстуры ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('42000000-0000-4000-8000-000000000001', 'pgTAP org C');

INSERT INTO locations (id, org_id, name) VALUES
  ('42100000-0000-4000-8000-000000000001',
   '42000000-0000-4000-8000-000000000001', 'Loc C');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('42200000-0000-4000-8000-000000000001',
        '42000000-0000-4000-8000-000000000001',
        '42100000-0000-4000-8000-000000000001',
        'pgTAP owner', 'owner', 'unused-in-test');

INSERT INTO supply_items (id, org_id, location_id, name, unit, stock, cost) VALUES
  ('42600000-0000-4000-8000-000000000001',
   '42000000-0000-4000-8000-000000000001',
   '42100000-0000-4000-8000-000000000001', 'Молоко', 'мл', 0, NULL);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"42c00000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"42000000-0000-4000-8000-000000000001","location_id":"42100000-0000-4000-8000-000000000001"}}',
  true
);

-- ── История: приход «позавчера», расход «сегодня» ────────────
CREATE TEMP TABLE recv AS
SELECT receive_stock(
  '42200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"42600000-0000-4000-8000-000000000001","qty":1000,"unit_cost":800}]'::jsonb
) AS r;

UPDATE stock_movements SET created_at = NOW() - INTERVAL '2 days'
WHERE supply_item_id = '42600000-0000-4000-8000-000000000001';
UPDATE supply_docs SET created_at = NOW() - INTERVAL '2 days'
WHERE location_id = '42100000-0000-4000-8000-000000000001';

CREATE TEMP TABLE waste AS
SELECT add_waste(
  '42200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"42600000-0000-4000-8000-000000000001","qty":200,"reason":"пролили"}]'::jsonb
) AS r;

CREATE TEMP TABLE cnt AS
SELECT stock_take(
  '42200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"42600000-0000-4000-8000-000000000001","counted":700}]'::jsonb
) AS r;

-- ── Период «сегодня»: приход за бортом, opening — якорь ──────
CREATE TEMP TABLE repa AS
SELECT stock_report(NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 hour') AS r;

SELECT is((SELECT (r -> 'items' -> 0 ->> 'opening')::int FROM repa),
  1000, 'opening = stock_after последней строки до периода');
SELECT is((SELECT (r -> 'items' -> 0 ->> 'waste')::int FROM repa),
  200, 'waste за период');
SELECT is((SELECT (r -> 'items' -> 0 ->> 'waste_value')::int FROM repa),
  160, 'waste_value: round(200×800/1000)');
SELECT is((SELECT (r -> 'items' -> 0 ->> 'count_adj')::int FROM repa),
  -100, 'инвентаризация: дельта −100');
SELECT is((SELECT (r -> 'items' -> 0 ->> 'count_value')::int FROM repa),
  -80, 'недостача в деньгах: round(−100×800/1000)');
SELECT is((SELECT (r -> 'items' -> 0 ->> 'closing')::int FROM repa),
  700, 'closing = stock_after последней строки периода');
SELECT is((SELECT (r -> 'items' -> 0 ->> 'closing_value')::int FROM repa),
  560, 'стоимость остатка: 700 мл × 800/л');

-- ── Период «с позапозавчера»: opening 0, приход внутри ───────
CREATE TEMP TABLE repb AS
SELECT stock_report(NOW() - INTERVAL '3 days', NOW() + INTERVAL '1 hour') AS r;

SELECT is((SELECT (r -> 'items' -> 0 ->> 'opening')::int FROM repb),
  0, 'первое движение внутри периода: opening = stock_after − qty_delta');
SELECT is((SELECT (r -> 'items' -> 0 ->> 'received_value')::int FROM repb),
  800, 'received_value за период');

-- ── Пустой период: позиции без движений не попадают ──────────
CREATE TEMP TABLE repc AS
SELECT stock_report(NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours') AS r;

SELECT is((SELECT jsonb_array_length(r -> 'items') FROM repc),
  0, 'без движений в периоде отчёт пуст');

SELECT * FROM finish();
ROLLBACK;
