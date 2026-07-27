-- pgTAP: приём подтверждённого платежа от провайдера (111).
--
-- Контракт автовыдачи после оплаты:
--   * повтор webhook (ретрай провайдера) НЕ продлевает подписку дважды;
--   * сумма и валюта сверяются со счётом: несовпадение → rejected,
--     счёт не трогается (защита от подделанного уведомления);
--   * успешный платёж продлевает подписки одной транзакцией;
--   * закрытый/несуществующий счёт не оплачивается;
--   * журнал платежей append-only и закрыт от клиентских ролей;
--   * приём платежа недоступен никому, кроме service_role.

BEGIN;
SELECT plan(25);

-- ── Структура и доступ ───────────────────────────────────────
SELECT has_table('billing_payment_events');

SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'billing_payment_events'),
  true, 'RLS включён на журнале платежей'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'billing_payment_events', 'SELECT'),
  'клиент не читает сырые webhook-payload'
);
SELECT ok(
  NOT has_table_privilege('anon', 'billing_payment_events', 'SELECT'),
  'аноним не читает журнал платежей'
);

-- Приём платежа — только сервер. Иначе клиент «подтвердил» бы оплату сам.
SELECT ok(
  NOT has_function_privilege('authenticated',
    'record_provider_payment(text,text,uuid,integer,text,text,text,jsonb)', 'EXECUTE'),
  'authenticated не может провести платёж'
);
SELECT ok(
  NOT has_function_privilege('anon',
    'record_provider_payment(text,text,uuid,integer,text,text,text,jsonb)', 'EXECUTE'),
  'anon не может провести платёж'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'invoice_payment_context(uuid)', 'EXECUTE'),
  'authenticated не читает платёжный контекст счёта'
);

-- ── Фикстуры: организация со счётом ──────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('c0000000-0000-4000-8000-0000000000a1', 'Payment Intake Org');
INSERT INTO locations (id, org_id, name) VALUES
  ('c1000000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000a1', 'Точка A');

SELECT lives_ok(
  $$ SELECT grant_subscription(
       'c0000000-0000-4000-8000-0000000000a1', 'menu',
       'c1000000-0000-4000-8000-0000000000a1', 1) $$,
  'подписка выдана — есть что продлевать'
);

-- Сдвигаем период в прошлое, чтобы продление было заметно.
UPDATE subscriptions
SET current_period_end = NOW() + INTERVAL '2 days'
WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1';

SELECT lives_ok(
  $$ SELECT issue_invoice('c0000000-0000-4000-8000-0000000000a1') $$,
  'счёт выставлен'
);

-- ── Контекст для платёжной сессии ────────────────────────────
-- Сумма для провайдера берётся ОТСЮДА, а не из тела клиентского запроса.
SELECT is(
  (SELECT (invoice_payment_context(id) ->> 'amount_agorot')::INT
   FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  (SELECT total_agorot FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  'платёжный контекст отдаёт сумму счёта из БД'
);
SELECT is(
  (SELECT (invoice_payment_context('c0000000-0000-4000-8000-00000000ffff') ->> 'found')),
  'false', 'несуществующий счёт не даёт платёжного контекста'
);

-- ── Несовпадение суммы: платёж отклоняется ───────────────────
SELECT is(
  (SELECT (record_provider_payment(
     'stripe', 'evt_wrong_amount', id, 1, 'ILS'
   ) ->> 'outcome')
   FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  'rejected', 'сумма меньше выставленной — платёж отклонён'
);
SELECT is(
  (SELECT status FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  'open', 'отклонённый платёж не закрывает счёт'
);
SELECT is(
  (SELECT reject_reason FROM billing_payment_events WHERE event_id = 'evt_wrong_amount'),
  'amount_mismatch', 'причина отклонения зафиксирована в журнале'
);

-- Чужая валюта тоже не проходит.
SELECT is(
  (SELECT (record_provider_payment(
     'stripe', 'evt_wrong_currency', id, total_agorot, 'USD'
   ) ->> 'outcome')
   FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  'rejected', 'платёж в другой валюте отклонён'
);

-- ── Успешный платёж ──────────────────────────────────────────
SELECT is(
  (SELECT (record_provider_payment(
     'stripe', 'evt_ok_1', id, total_agorot, 'ILS',
     'checkout.session.completed', 'pi_12345'
   ) ->> 'outcome')
   FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  'applied', 'корректный платёж принят'
);
SELECT is(
  (SELECT status FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  'paid', 'счёт закрыт как оплаченный'
);
SELECT is(
  (SELECT payment_method FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  'card', 'способ оплаты — карта'
);
SELECT ok(
  (SELECT current_period_end FROM subscriptions
   WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1')
  > NOW() + INTERVAL '25 days',
  'подписка продлена автоматически — доступ открылся без оператора'
);

-- ── Идемпотентность: ретрай провайдера ───────────────────────
SELECT is(
  (SELECT (record_provider_payment(
     'stripe', 'evt_ok_1', id, total_agorot, 'ILS'
   ) ->> 'outcome')
   FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  'duplicate', 'повтор того же события — duplicate'
);

-- Ключевая проверка: второй webhook не продлил подписку ещё на месяц.
SELECT ok(
  (SELECT current_period_end FROM subscriptions
   WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1')
  < NOW() + INTERVAL '40 days',
  'ретрай НЕ продлевает подписку второй раз'
);

-- Новое событие по уже оплаченному счёту тоже не продлевает.
SELECT is(
  (SELECT (record_provider_payment(
     'stripe', 'evt_ok_2', id, total_agorot, 'ILS'
   ) ->> 'outcome')
   FROM invoices WHERE org_id = 'c0000000-0000-4000-8000-0000000000a1'),
  'duplicate', 'другое событие по оплаченному счёту не проводится повторно'
);

-- ── Несуществующий счёт ──────────────────────────────────────
SELECT is(
  (record_provider_payment(
     'stripe', 'evt_no_invoice', 'c0000000-0000-4000-8000-00000000eeee', 1000, 'ILS'
   ) ->> 'reason'),
  'invoice_not_found', 'платёж по несуществующему счёту отклонён'
);

-- ── Журнал append-only ───────────────────────────────────────
SELECT throws_ok(
  $$ UPDATE billing_payment_events SET outcome = 'applied'
     WHERE event_id = 'evt_wrong_amount' $$,
  'billing_payment_events_append_only',
  'журнал платежей нельзя переписать'
);
SELECT throws_ok(
  $$ DELETE FROM billing_payment_events WHERE event_id = 'evt_ok_1' $$,
  'billing_payment_events_append_only',
  'журнал платежей нельзя очистить'
);

SELECT * FROM finish();
ROLLBACK;
