-- pgTAP: отчёт «Продажи» для веб-владельца бэкофиса (089).
--
-- Ключевой инвариант: членство в organization_members заменяет PIN-сессию,
-- но НЕ расширяет видимость — чужая организация остаётся недостижимой,
-- потому что тело отчёта читается под RLS вызывающего (SECURITY INVOKER).
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(8);

-- ── Фикстура: две организации с оплаченным заказом в каждой ──
INSERT INTO orgs (id, name) VALUES
  ('60000000-0000-4000-8000-000000000001', 'pgTAP org R1'),
  ('60000000-0000-4000-8000-000000000002', 'pgTAP org R2');

INSERT INTO locations (id, org_id, name) VALUES
  ('61000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'Loc R1'),
  ('61000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002', 'Loc R2');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('62000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
   '61000000-0000-4000-8000-000000000001', 'pgTAP staff R1', 'barista', 'unused-in-test'),
  ('62000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002',
   '61000000-0000-4000-8000-000000000002', 'pgTAP staff R2', 'barista', 'unused-in-test');

-- Org R1 — заказ на 100.00, Org R2 — на 700.00 (суммы различимы в отчёте)
INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total, paid_at
) VALUES
  ('64000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
   '61000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000001',
   '65000000-0000-4000-8000-000000000001', 1, 'here', 'paid', 10000, 18, 1525, 10000, NOW()),
  ('64000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002',
   '61000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000002',
   '65000000-0000-4000-8000-000000000002', 1, 'here', 'paid', 70000, 18, 10678, 70000, NOW());

INSERT INTO auth.users (id) VALUES
  ('63000000-0000-4000-8000-000000000001'),  -- владелец бэкофиса Org R1
  ('63000000-0000-4000-8000-000000000002'),  -- бухгалтер Org R1
  ('63000000-0000-4000-8000-000000000003');  -- аккаунт без членства

INSERT INTO organization_members (org_id, auth_user_id, role, is_active) VALUES
  ('60000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', 'owner', TRUE),
  ('60000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000002', 'accountant', TRUE);

SET LOCAL ROLE authenticated;

-- ── Владелец бэкофиса: без PIN-сессии, без location_id в токене ──
-- Именно так выглядит JWT веб-владельца: точки в нём нет.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"63000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"60000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT lives_ok(
  $$ SELECT sales_report(NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day') $$,
  'владелец бэкофиса получает отчёт без PIN-сессии'
);

SELECT is(
  (sales_report(NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day')
     -> 'summary' ->> 'gross_sales')::bigint,
  10000::bigint,
  'отчёт считает выручку своей организации'
);

-- Главная проверка: сумма Org R2 (70000) в отчёт не попала
SELECT is(
  (sales_report(NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day')
     -> 'summary' ->> 'orders_count')::bigint,
  1::bigint,
  'заказ чужой организации не попадает в отчёт владельца'
);

SELECT is(
  (sales_report(NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day')
     -> 'summary' ->> 'gross_sales')::bigint,
  10000::bigint,
  'выручка не смешивает организации даже при одинаковом периоде'
);

-- ── accountant не является владельческой ролью для этого отчёта ──
-- Гейт 089 его не пропускает, дальше он идёт прежним путём —
-- через require_staff_perm. Тот сейчас в МЯГКОМ режиме (055
-- переопределила 045 телом 044), поэтому вызов без токена проходит.
-- Проверяем именно то, что зависит от 089: с ЗАВЕДОМО БИТЫМ токеном
-- accountant отвергается, то есть членство ему прохода не дало.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"63000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"60000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$ SELECT sales_report(NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 'Asia/Jerusalem',
                         '66000000-0000-4000-8000-0000000000ff') $$,
  'P0001', 'staff session invalid',
  'accountant не проходит как владелец и остаётся на staff-гейте'
);

-- ── Аккаунт без членства (устройство): прежний путь через PIN-сессию ──
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"63000000-0000-4000-8000-000000000003","role":"authenticated","app_metadata":{"org_id":"60000000-0000-4000-8000-000000000001","location_id":"61000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$ SELECT sales_report(NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 'Asia/Jerusalem',
                         '66000000-0000-4000-8000-0000000000ff') $$,
  'P0001', 'staff session invalid',
  'битый токен без членства по-прежнему отвергается'
);

RESET ROLE;

-- ── Контракт функции не изменился (касса зовёт ту же сигнатуру) ──
SELECT has_function('sales_report',
  ARRAY['timestamptz','timestamptz','text','uuid']);
SELECT ok(
  NOT has_function_privilege('anon',
    'sales_report(timestamptz,timestamptz,text,uuid)', 'EXECUTE'),
  'anon не вызывает sales_report'
);

SELECT * FROM finish();
ROLLBACK;
