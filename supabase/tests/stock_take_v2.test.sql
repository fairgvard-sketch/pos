-- pgTAP: инвентаризация 2.0 (079) — недостача и излишек в деньгах
-- в ответе stock_take. Запуск: supabase test db.

BEGIN;
SELECT plan(4);

INSERT INTO orgs (id, name) VALUES
  ('43000000-0000-4000-8000-000000000001', 'pgTAP org D');

INSERT INTO locations (id, org_id, name) VALUES
  ('43100000-0000-4000-8000-000000000001',
   '43000000-0000-4000-8000-000000000001', 'Loc D');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('43200000-0000-4000-8000-000000000001',
        '43000000-0000-4000-8000-000000000001',
        '43100000-0000-4000-8000-000000000001',
        'pgTAP owner', 'owner', 'unused-in-test');

-- Мука 10 кг по 320/кг, стаканы 100 шт по 60
INSERT INTO supply_items (id, org_id, location_id, name, unit, stock, cost) VALUES
  ('43600000-0000-4000-8000-000000000001',
   '43000000-0000-4000-8000-000000000001',
   '43100000-0000-4000-8000-000000000001', 'Мука', 'г', 10000, 320),
  ('43600000-0000-4000-8000-000000000002',
   '43000000-0000-4000-8000-000000000001',
   '43100000-0000-4000-8000-000000000001', 'Стакан', 'шт', 100, 60);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"43c00000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"43000000-0000-4000-8000-000000000001","location_id":"43100000-0000-4000-8000-000000000001"}}',
  true
);

-- Строгий режим (090): привилегированные RPC требуют staff-сессию
INSERT INTO staff_sessions (token, staff_id, org_id, location_id)
VALUES ('43d00000-0000-4000-8000-000000000001',
        '43200000-0000-4000-8000-000000000001',
        '43000000-0000-4000-8000-000000000001',
        '43100000-0000-4000-8000-000000000001');

-- Мука: факт 8000 (недостача 2000 г = 640), стаканы: факт 110 (излишек 10 = 600)
CREATE TEMP TABLE cnt AS
SELECT stock_take(
  '43200000-0000-4000-8000-000000000001',
  '[{"kind":"supply","supply_item_id":"43600000-0000-4000-8000-000000000001","counted":8000},
    {"kind":"supply","supply_item_id":"43600000-0000-4000-8000-000000000002","counted":110}]'::jsonb,
  NULL, '43d00000-0000-4000-8000-000000000001'
) AS r;

SELECT is((SELECT (r ->> 'items')::int FROM cnt), 2, 'пересчитаны обе позиции');
SELECT is((SELECT (r ->> 'shortage_value')::bigint FROM cnt),
  640::bigint, 'недостача: round(2000×320/1000)');
SELECT is((SELECT (r ->> 'surplus_value')::bigint FROM cnt),
  600::bigint, 'излишек: 10×60');
SELECT is((SELECT stock FROM supply_items WHERE id = '43600000-0000-4000-8000-000000000001'),
  8000, 'остаток муки = факт');

SELECT * FROM finish();
ROLLBACK;
