-- pgTAP: подписки на точку, grace-период, счета и location-capability (108/109).
--
-- Контракт Phase 7 (коммерциализация):
--   * продаются варианты POS / POS+QR / QR отдельно — на ТОЧКУ;
--   * доступ живёт до current_period_end + grace_days, а не до
--     current_period_end: касса не умирает в утренний пик;
--   * в grace подписка past_due, но entitlement ещё активен;
--   * org-уровневый грант (developer/manual, бэкфилл 100) действует во
--     всех точках; location-подписка — только в своей;
--   * счета неизменяемы и не удаляются (инвариант №2 CLAUDE.md);
--   * суммы — целые агороты (инвариант №1), НДС считает БД;
--   * биллинговые RPC закрыты от клиентских ролей;
--   * sandbox не работает на боевой организации.

BEGIN;
SELECT plan(63);

-- ── Структура и доступ ───────────────────────────────────────
SELECT has_table('product_prices');
SELECT has_table('subscriptions');
SELECT has_table('invoices');
SELECT has_table('invoice_lines');
SELECT has_table('subscription_events');

SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'subscriptions'),
  true, 'RLS включён на subscriptions'
);
SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'invoices'),
  true, 'RLS включён на invoices'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'subscriptions', 'INSERT'),
  'authenticated не пишет подписки напрямую'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'invoices', 'UPDATE'),
  'authenticated не правит счета напрямую'
);
SELECT ok(
  NOT has_table_privilege('anon', 'invoices', 'SELECT'),
  'anon не читает счета'
);
SELECT ok(
  has_table_privilege('authenticated', 'product_prices', 'SELECT'),
  'authenticated читает прайс (карточки продуктов в кабинете)'
);

-- Денежные RPC недоступны клиентским ролям: оплата не инициируется
-- из браузера (урок cardcom-plan.md P9).
SELECT ok(
  NOT has_function_privilege('authenticated', 'grant_subscription(uuid,text,uuid,integer)', 'EXECUTE'),
  'authenticated не может выдать себе подписку'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'mark_invoice_paid(uuid,text,text)', 'EXECUTE'),
  'authenticated не может отметить счёт оплаченным'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'issue_invoice(uuid,timestamptz,integer,integer,numeric)', 'EXECUTE'),
  'authenticated не может выставлять счета'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'billing_sandbox_advance(uuid,integer)', 'EXECUTE'),
  'authenticated не может двигать время подписки'
);
SELECT ok(
  has_function_privilege('authenticated', 'org_billing_state(uuid)', 'EXECUTE'),
  'authenticated читает состояние своей подписки'
);

-- ── Фикстуры: сеть из трёх точек ─────────────────────────────
--   Дизенгоф — POS + QR
--   Ротшильд — только POS
--   Киоск    — только QR (кассы нет вовсе)
INSERT INTO orgs (id, name, account_type) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'Billing Net', 'customer'),
  ('b0000000-0000-4000-8000-000000000002', 'Billing Dev', 'developer');

INSERT INTO locations (id, org_id, name) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Дизенгоф'),
  ('b1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'Ротшильд'),
  ('b1000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'Киоск'),
  ('b1000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002', 'Dev loc');

-- ── Прайс ────────────────────────────────────────────────────
SELECT is(
  (SELECT billing_unit FROM current_product_price('pos')),
  'location', 'POS тарифицируется за точку'
);
SELECT ok(
  (SELECT amount_agorot FROM current_product_price('menu')) > 0,
  'QR-меню имеет собственную цену (продаётся отдельно от POS)'
);
SELECT is(
  (SELECT bundle_with FROM current_product_price('menu')),
  'pos', 'QR-меню дешевле в связке с POS'
);

-- Новая цена не переписывает старую: версионирование effective_from.
INSERT INTO product_prices (product, amount_agorot, billing_cycle, effective_from)
VALUES ('reservations', 12900, 'monthly', NOW() + INTERVAL '30 days');
SELECT is(
  (SELECT amount_agorot FROM current_product_price('reservations')),
  9900, 'будущая цена не действует до effective_from'
);

-- ── Подписки на точку: POS / POS+QR / QR ─────────────────────
SELECT lives_ok(
  $$ SELECT grant_subscription(
       'b0000000-0000-4000-8000-000000000001', 'pos',
       'b1000000-0000-4000-8000-000000000001', 1) $$,
  'POS выдан в Дизенгоф'
);
SELECT lives_ok(
  $$ SELECT grant_subscription(
       'b0000000-0000-4000-8000-000000000001', 'menu',
       'b1000000-0000-4000-8000-000000000001', 1) $$,
  'QR выдан в Дизенгоф (связка POS + QR)'
);
SELECT lives_ok(
  $$ SELECT grant_subscription(
       'b0000000-0000-4000-8000-000000000001', 'pos',
       'b1000000-0000-4000-8000-000000000002', 1) $$,
  'POS выдан в Ротшильд (без QR)'
);
SELECT lives_ok(
  $$ SELECT grant_subscription(
       'b0000000-0000-4000-8000-000000000001', 'menu',
       'b1000000-0000-4000-8000-000000000003', 1) $$,
  'QR выдан в Киоск (точка без кассы)'
);

SELECT throws_ok(
  $$ SELECT grant_subscription(
       'b0000000-0000-4000-8000-000000000001', 'pos',
       'b1000000-0000-4000-8000-000000000004', 1) $$,
  'location_not_in_org',
  'подписку нельзя выдать на чужую точку'
);

-- Главное: продукт куплен ТОЧЕЧНО и не растекается по сети.
SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001', 'pos_operate'),
  'Дизенгоф: касса работает'
);
SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001', 'public_menu'),
  'Дизенгоф: QR-меню работает'
);
SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002', 'pos_operate'),
  'Ротшильд: касса работает'
);
SELECT ok(
  NOT org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002', 'public_menu'),
  'Ротшильд: QR НЕ работает — за него не платили'
);
SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000003', 'public_menu'),
  'Киоск: QR работает без кассы (standalone-продукт)'
);
SELECT ok(
  NOT org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000003', 'pos_operate'),
  'Киоск: касса НЕ работает — POS там не куплен'
);
SELECT ok(
  NOT org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000003', 'unknown_capability'),
  'неизвестная capability — FALSE (fail closed)'
);

-- ── Регресс 110: продажа подписки не гасит org-грант ─────────
-- Организация живёт на бэкфилле 100 (org-уровневый грант, точек две).
-- Первая продажа подписки на ОДНУ точку не должна отключать продукт
-- в остальных: тихая потеря кассы в горячем потоке недопустима.
INSERT INTO orgs (id, name) VALUES
  ('b0000000-0000-4000-8000-000000000003', 'Legacy Backfill Org');
INSERT INTO locations (id, org_id, name) VALUES
  ('b1000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000003', 'Legacy A'),
  ('b1000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000003', 'Legacy B');
INSERT INTO organization_products (org_id, product, is_active, status, source)
VALUES ('b0000000-0000-4000-8000-000000000003', 'pos', TRUE, 'active', 'manual');

SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000003',
    'b1000000-0000-4000-8000-000000000006', 'pos_operate'),
  'org-грант действует во всех точках до продажи подписок'
);

SELECT lives_ok(
  $$ SELECT grant_subscription(
       'b0000000-0000-4000-8000-000000000003', 'pos',
       'b1000000-0000-4000-8000-000000000005', 1) $$,
  'подписка продана в одну точку сети'
);

SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000003',
    'b1000000-0000-4000-8000-000000000006', 'pos_operate'),
  '110: продажа подписки в одной точке НЕ гасит org-грант в другой'
);
SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000003',
    'b1000000-0000-4000-8000-000000000005', 'pos_operate'),
  'оплаченная точка тоже работает'
);

-- Обратная сторона 110: агрегатная org-строка (source=subscription),
-- которую пишет sync_entitlement_from_subscription, НЕ должна открывать
-- продукт во всей сети — иначе QR, купленный в киоске, включится везде.
SELECT is(
  (SELECT source FROM organization_products
   WHERE org_id = 'b0000000-0000-4000-8000-000000000001' AND product = 'menu'),
  'subscription', 'продажа подписки пишет агрегатную строку organization_products'
);
SELECT ok(
  NOT org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002', 'public_menu'),
  '110: агрегатная строка не открывает продукт в неоплаченной точке'
);

-- ── Grace-период ─────────────────────────────────────────────
-- Оплаченный период кончился вчера, grace 7 дней → доступ ЖИВ.
UPDATE subscriptions
SET current_period_end = NOW() - INTERVAL '1 day', grace_days = 7
WHERE org_id = 'b0000000-0000-4000-8000-000000000001'
  AND product = 'pos'
  AND location_id = 'b1000000-0000-4000-8000-000000000001';

SELECT is(
  refresh_subscription_status((
    SELECT id FROM subscriptions
    WHERE org_id = 'b0000000-0000-4000-8000-000000000001'
      AND product = 'pos'
      AND location_id = 'b1000000-0000-4000-8000-000000000001')),
  'past_due', 'истёкший оплаченный период переводит подписку в past_due'
);
SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001', 'pos_operate'),
  'в grace касса ПРОДОЛЖАЕТ работать (не умирает в утренний пик)'
);

-- Grace истёк → доступ гаснет.
UPDATE subscriptions
SET current_period_end = NOW() - INTERVAL '30 days', grace_days = 7
WHERE org_id = 'b0000000-0000-4000-8000-000000000001'
  AND product = 'pos'
  AND location_id = 'b1000000-0000-4000-8000-000000000001';

SELECT is(
  refresh_subscription_status((
    SELECT id FROM subscriptions
    WHERE org_id = 'b0000000-0000-4000-8000-000000000001'
      AND product = 'pos'
      AND location_id = 'b1000000-0000-4000-8000-000000000001')),
  'suspended', 'после grace подписка приостановлена'
);
SELECT ok(
  NOT org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001', 'pos_operate'),
  'после grace касса заблокирована'
);
SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002', 'pos_operate'),
  'приостановка одной точки не гасит кассу в другой'
);

-- Продление возвращает доступ, данные не пострадали.
SELECT lives_ok(
  $$ SELECT grant_subscription(
       'b0000000-0000-4000-8000-000000000001', 'pos',
       'b1000000-0000-4000-8000-000000000001', 1) $$,
  'подписку можно возобновить'
);
SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001', 'pos_operate'),
  'после оплаты касса снова работает'
);

-- ── Триал ────────────────────────────────────────────────────
SELECT lives_ok(
  $$ SELECT start_trial(
       'b0000000-0000-4000-8000-000000000001', 'reservations',
       'b1000000-0000-4000-8000-000000000002', 14, 7) $$,
  'триал брони запущен в Ротшильде'
);
SELECT is(
  (SELECT (start_trial('b0000000-0000-4000-8000-000000000001', 'reservations',
                       'b1000000-0000-4000-8000-000000000002', 14, 7) ->> 'created')::BOOLEAN),
  false, 'повторный запуск триала не продлевает его (идемпотентность)'
);
SELECT ok(
  org_has_capability_at('b0000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002', 'public_reservations'),
  'триал даёт полный доступ к продукту'
);
SELECT is(
  (SELECT status FROM organization_products
   WHERE org_id = 'b0000000-0000-4000-8000-000000000001' AND product = 'reservations'),
  'trialing', 'entitlement организации отражает триал'
);

-- ── Счета ────────────────────────────────────────────────────
SELECT lives_ok(
  $$ SELECT issue_invoice('b0000000-0000-4000-8000-000000000001') $$,
  'счёт за период выставлен'
);

SELECT ok(
  (SELECT COUNT(*) FROM invoice_lines il
   JOIN invoices i ON i.id = il.invoice_id
   WHERE i.org_id = 'b0000000-0000-4000-8000-000000000001') >= 4,
  'в счёте строка на каждую пару (продукт, точка)'
);

-- НДС и итог считает БД; агороты целые.
SELECT ok(
  (SELECT total_agorot = (subtotal_agorot - discount_agorot) + vat_agorot
   FROM invoices WHERE org_id = 'b0000000-0000-4000-8000-000000000001'
   ORDER BY created_at DESC LIMIT 1),
  'итог счёта = (сумма − скидка) + НДС'
);
SELECT ok(
  (SELECT discount_agorot > 0
   FROM invoices WHERE org_id = 'b0000000-0000-4000-8000-000000000001'
   ORDER BY created_at DESC LIMIT 1),
  'скидка за связку POS + QR применена в Дизенгофе'
);

-- Счета неизменяемы и не удаляются.
-- Номер счёта берётся из последовательности, которая не откатывается
-- вместе с транзакцией теста: сверяем код ошибки, а не текст с номером.
SELECT throws_ok(
  $$ UPDATE invoices SET total_agorot = 1
     WHERE org_id = 'b0000000-0000-4000-8000-000000000001' $$,
  'P0001',
  NULL,
  'сумму выставленного счёта нельзя переписать'
);
SELECT throws_ok(
  $$ DELETE FROM invoices WHERE org_id = 'b0000000-0000-4000-8000-000000000001' $$,
  'invoice_immutable: счета не удаляются, используйте status=void',
  'счёт нельзя удалить'
);

-- Оплата продлевает подписки и идемпотентна.
SELECT is(
  (SELECT (mark_invoice_paid(id) ->> 'changed')::BOOLEAN
   FROM invoices WHERE org_id = 'b0000000-0000-4000-8000-000000000001'
   ORDER BY created_at DESC LIMIT 1),
  true, 'счёт отмечен оплаченным'
);
SELECT is(
  (SELECT (mark_invoice_paid(id) ->> 'changed')::BOOLEAN
   FROM invoices WHERE org_id = 'b0000000-0000-4000-8000-000000000001'
   ORDER BY created_at DESC LIMIT 1),
  false, 'повторная отметка оплаты не продлевает подписку второй раз'
);

-- ── Аудит append-only ────────────────────────────────────────
SELECT ok(
  (SELECT COUNT(*) FROM subscription_events
   WHERE org_id = 'b0000000-0000-4000-8000-000000000001') > 0,
  'переходы подписки пишутся в аудит'
);
SELECT throws_ok(
  $$ UPDATE subscription_events SET event = 'tampered'
     WHERE org_id = 'b0000000-0000-4000-8000-000000000001' $$,
  'subscription_events_append_only',
  'аудит подписок нельзя переписать'
);

-- ── Sandbox: только developer/demo и только под флагом ───────
SELECT throws_ok(
  $$ SELECT billing_sandbox_advance((
       SELECT id FROM subscriptions
       WHERE org_id = 'b0000000-0000-4000-8000-000000000001' LIMIT 1), 30) $$,
  'sandbox_disabled: требуется SET LOCAL app.billing_sandbox = ''on''',
  'без флага sandbox не работает'
);

SET LOCAL app.billing_sandbox = 'on';

SELECT throws_ok(
  $$ SELECT billing_sandbox_advance((
       SELECT id FROM subscriptions
       WHERE org_id = 'b0000000-0000-4000-8000-000000000001' LIMIT 1), 30) $$,
  NULL,
  'sandbox не трогает боевую организацию даже под флагом'
);

SELECT lives_ok(
  $$ SELECT start_trial('b0000000-0000-4000-8000-000000000002', 'pos',
                        'b1000000-0000-4000-8000-000000000004', 14, 7) $$,
  'триал в developer-организации запущен'
);
SELECT is(
  (SELECT billing_sandbox_advance(
     (SELECT id FROM subscriptions
      WHERE org_id = 'b0000000-0000-4000-8000-000000000002' AND product = 'pos'),
     20) ->> 'status'),
  'past_due',
  'sandbox прогоняет trial → grace без ожидания реальных дат'
);

SELECT * FROM finish();
ROLLBACK;
