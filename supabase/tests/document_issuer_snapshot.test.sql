-- pgTAP: слепок эмитента в документе (миграция 150).
--
-- Дефект, который набор закрывает: личность эмитента (название бизнеса,
-- ח.פ, адрес) жила только колонками `locations`, и печать с выгрузкой
-- читали её ЖИВОЙ. Смена реквизитов задним числом меняла содержимое уже
-- выпущенных חשבונית и уже сданных наборов מבנה אחיד.
--
-- Проверяется главное обещание: выпущенный документ помнит своего
-- эмитента и не меняется, когда настройки точки поменяли ПОСЛЕ выпуска.
-- Плюс граница: пока документ не выпущен (номера нет), слепка тоже нет —
-- открытый заказ ещё не документ.

BEGIN;
SELECT plan(18);

-- ── Триггеры на месте ────────────────────────────────────────
SELECT has_column('public', 'orders',  'issuer_tax_id', 'orders помнит ח.פ эмитента');
SELECT has_column('public', 'refunds', 'issuer_tax_id', 'refunds помнит ח.פ эмитента');
SELECT has_trigger('public', 'orders', 'trg_orders_issuer_number',
  'снимок снимается при присвоении номера чека');
SELECT has_trigger('public', 'orders', 'trg_orders_issuer_insert',
  'снимок снимается и у заказа, вставленного сразу с номером');

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name)
VALUES ('4a000000-0000-4000-8000-000000000001', 'issuer snapshot org');

INSERT INTO organization_products (org_id, product)
VALUES ('4a000000-0000-4000-8000-000000000001', 'pos');

INSERT INTO locations (
  id, org_id, name, timezone,
  receipt_business_name, receipt_tax_id, receipt_address
) VALUES (
  '4a100000-0000-4000-8000-000000000001',
  '4a000000-0000-4000-8000-000000000001',
  'Pinsker', 'Asia/Jerusalem',
  'בולוצ׳קה בע״מ', '515111111', 'פינסקר 29, תל אביב'
);

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash)
VALUES ('4a200000-0000-4000-8000-000000000001',
        '4a000000-0000-4000-8000-000000000001',
        '4a100000-0000-4000-8000-000000000001', 'owner', 'owner', 'unused');

-- Открытый заказ: ещё НЕ документ
INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total
) VALUES (
  '4a500000-0000-4000-8000-000000000001',
  '4a000000-0000-4000-8000-000000000001',
  '4a100000-0000-4000-8000-000000000001',
  '4a200000-0000-4000-8000-000000000001',
  '4a600000-0000-4000-8000-000000000001',
  1, 'here', 'open', 5000, 18, 763, 5000
);

SELECT is(
  (SELECT issuer_tax_id FROM orders WHERE id = '4a500000-0000-4000-8000-000000000001'),
  NULL,
  'открытый заказ ещё не документ — эмитента не запоминает'
);

-- ── Выпуск документа: заказ получает номер ───────────────────
UPDATE orders
   SET status = 'paid', paid_at = NOW(), receipt_number = 1
 WHERE id = '4a500000-0000-4000-8000-000000000001';

SELECT is(
  (SELECT issuer_name FROM orders WHERE id = '4a500000-0000-4000-8000-000000000001'),
  'בולוצ׳קה בע״מ',
  'в момент выпуска документ запомнил имя эмитента'
);
SELECT is(
  (SELECT issuer_tax_id FROM orders WHERE id = '4a500000-0000-4000-8000-000000000001'),
  '515111111',
  'и ח.פ'
);
SELECT is(
  (SELECT issuer_address FROM orders WHERE id = '4a500000-0000-4000-8000-000000000001'),
  'פינסקר 29, תל אביב',
  'и адрес'
);

-- ── Возврат по этому заказу тоже запоминает эмитента ─────────
INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float)
VALUES ('4a400000-0000-4000-8000-000000000001',
        '4a000000-0000-4000-8000-000000000001',
        '4a100000-0000-4000-8000-000000000001',
        '4a200000-0000-4000-8000-000000000001', 'open', 0);

INSERT INTO refunds (id, org_id, order_id, shift_id, staff_id, amount, method)
VALUES ('4a800000-0000-4000-8000-000000000001',
        '4a000000-0000-4000-8000-000000000001',
        '4a500000-0000-4000-8000-000000000001',
        '4a400000-0000-4000-8000-000000000001',
        '4a200000-0000-4000-8000-000000000001', 1000, 'cash');

SELECT is(
  (SELECT issuer_tax_id FROM refunds WHERE id = '4a800000-0000-4000-8000-000000000001'),
  '515111111',
  'зикуй запоминает эмитента так же, как чек'
);

-- ── ГЛАВНОЕ: смена реквизитов не трогает выпущенное ──────────
-- Ровно тот сценарий, из-за которого всё это делается: владелец
-- поменял ח.פ и название после того, как документы выпущены.
UPDATE locations
   SET receipt_business_name = 'עסק אחר בע״מ',
       receipt_tax_id        = '515999999',
       receipt_address       = 'רוטשילד 15, תל אביב'
 WHERE id = '4a100000-0000-4000-8000-000000000001';

SELECT is(
  (SELECT issuer_tax_id FROM orders WHERE id = '4a500000-0000-4000-8000-000000000001'),
  '515111111',
  'выпущенный чек не изменился после смены ח.פ точки'
);
SELECT is(
  (SELECT issuer_name FROM orders WHERE id = '4a500000-0000-4000-8000-000000000001'),
  'בולוצ׳קה בע״מ',
  'и название на нём осталось прежним'
);
SELECT is(
  (SELECT issuer_tax_id FROM refunds WHERE id = '4a800000-0000-4000-8000-000000000001'),
  '515111111',
  'выпущенный зикуй тоже не изменился'
);

-- ── Новый документ берёт уже НОВЫЕ реквизиты ────────────────
-- Обратная половина требования: слепок замораживает прошлое, но не
-- будущее — смена реквизитов обязана применяться к следующим документам.
INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total,
  receipt_number, paid_at
) VALUES (
  '4a500000-0000-4000-8000-000000000002',
  '4a000000-0000-4000-8000-000000000001',
  '4a100000-0000-4000-8000-000000000001',
  '4a200000-0000-4000-8000-000000000001',
  '4a600000-0000-4000-8000-000000000002',
  2, 'here', 'paid', 3000, 18, 458, 3000, 2, NOW()
);

SELECT is(
  (SELECT issuer_tax_id FROM orders WHERE id = '4a500000-0000-4000-8000-000000000002'),
  '515999999',
  'следующий документ выпущен уже с новым ח.פ'
);

-- ── Фолбэк имени: точка без receipt_business_name ───────────
-- На бумагу уходит `COALESCE(receipt_business_name, name)`, и в слепке
-- обязано лежать то же самое, иначе перепечатка разойдётся с оригиналом.
INSERT INTO locations (id, org_id, name, timezone, receipt_tax_id)
VALUES ('4a100000-0000-4000-8000-000000000002',
        '4a000000-0000-4000-8000-000000000001',
        'Rothschild branch', 'Asia/Jerusalem', '515222222');

INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total,
  receipt_number, paid_at
) VALUES (
  '4a500000-0000-4000-8000-000000000003',
  '4a000000-0000-4000-8000-000000000001',
  '4a100000-0000-4000-8000-000000000002',
  '4a200000-0000-4000-8000-000000000001',
  '4a600000-0000-4000-8000-000000000003',
  1, 'here', 'paid', 1000, 18, 153, 1000, 1, NOW()
);

SELECT is(
  (SELECT issuer_name FROM orders WHERE id = '4a500000-0000-4000-8000-000000000003'),
  'Rothschild branch',
  'без receipt_business_name в слепок идёт имя точки — как и на бумагу'
);

-- ── Void до оплаты документом не становится ─────────────────
INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total
) VALUES (
  '4a500000-0000-4000-8000-000000000004',
  '4a000000-0000-4000-8000-000000000001',
  '4a100000-0000-4000-8000-000000000001',
  '4a200000-0000-4000-8000-000000000001',
  '4a600000-0000-4000-8000-000000000004',
  3, 'here', 'open', 2000, 18, 305, 2000
);
UPDATE orders SET status = 'voided'
 WHERE id = '4a500000-0000-4000-8000-000000000004';

SELECT is(
  (SELECT issuer_name FROM orders WHERE id = '4a500000-0000-4000-8000-000000000004'),
  NULL,
  'отменённый до оплаты заказ эмитента не запоминает — он не документ'
);

-- ── Выгрузка видит эмитента документа, а не живые настройки ──
-- Ради этого 150 и делалась: реквизиты точки уже поменяли выше, и набор
-- за период обязан нести ТЕ, с которыми документы были выпущены.
SELECT is(
  (SELECT d ->> 'issuer_tax_id'
     FROM jsonb_array_elements(
       uf_export_documents_for(
         '4a100000-0000-4000-8000-000000000001'::uuid,
         (NOW() AT TIME ZONE 'Asia/Jerusalem')::date,
         (NOW() AT TIME ZONE 'Asia/Jerusalem')::date,
         NULL, NULL, 200
       ) -> 'documents'
     ) AS d
    WHERE d ->> 'kind' = 'refund'
    LIMIT 1),
  '515111111',
  'выгрузка отдаёт ח.פ из документа, а не сегодняшний из настроек'
);

-- ── Два разных эмитента в периоде видны ДО сборки набора ────
-- В заголовке מבנה אחיד один ח.פ: период, где реквизиты менялись,
-- обязан быть распознан как неотдаваемый, а не усреднён молча.
SELECT is(
  (uf_export_issuers_for(
     '4a100000-0000-4000-8000-000000000001'::uuid,
     (NOW() AT TIME ZONE 'Asia/Jerusalem')::date,
     (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
   ) ->> 'count')::int,
  2,
  'период со сменой реквизитов показывает двух эмитентов'
);

-- А ровный период — ровно одного, и набор собирается как обычно
SELECT is(
  (uf_export_issuers_for(
     '4a100000-0000-4000-8000-000000000002'::uuid,
     (NOW() AT TIME ZONE 'Asia/Jerusalem')::date,
     (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
   ) ->> 'count')::int,
  1,
  'период без смены реквизитов — один эмитент'
);

SELECT * FROM finish();
ROLLBACK;
