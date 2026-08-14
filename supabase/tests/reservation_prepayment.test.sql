-- pgTAP: предоплата брони (164).
--
-- Проверяется то, из-за чего эту функцию вообще нельзя писать наспех:
--   * без здорового провайдера предоплата НЕ существует ни в каком виде;
--   * сумму считает сервер, клиент повлиять на неё не может;
--   * «оплачено» появляется только из проверенного подтверждения;
--   * повтор вебхука не создаёт ни второго платежа, ни второй брони;
--   * неоплаченная бронь держит стол и отпускает его по истечении срока.

BEGIN;
SELECT plan(27);

INSERT INTO orgs (id, name) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'pgTAP prepay');
INSERT INTO locations (id, org_id, name, timezone, settings) VALUES
  ('d1000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001', 'Prepay loc', 'Asia/Jerusalem',
   jsonb_build_object('reservations', jsonb_build_object(
     'enabled', TRUE,
     'instant', TRUE,
     'max_party', 20,
     'deposit_required', TRUE,
     'deposit_amount', 5000,      -- 50 ₪ с гостя, в агоротах
     'deposit_from_party', 2,
     'deposit_refund_hours', 24,
     'schedule', jsonb_build_object(
       'weekly', jsonb_build_object(
         '0', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '1', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '2', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '3', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '4', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '5', jsonb_build_array(jsonb_build_array('00:00', '23:45')),
         '6', jsonb_build_array(jsonb_build_array('00:00', '23:45'))),
       'lead_min', 0, 'horizon_days', 30))));
INSERT INTO organization_products (org_id, product) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'reservations');

INSERT INTO table_zones (id, org_id, location_id, name, is_active, sort_order) VALUES
  ('d3000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'Зал', TRUE, 1);
INSERT INTO tables (id, org_id, location_id, zone_id, label, seats, is_active) VALUES
  ('d4000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001',
   'd3000000-0000-4000-8000-000000000001', '1', 4, TRUE);

-- ── Без провайдера предоплаты не существует ──────────────────

SELECT is(
  reservation_prepay_policy('d1000000-0000-4000-8000-000000000001', 4),
  NULL,
  'без здорового провайдера политики нет, хотя сумма в настройках задана');

SELECT throws_ok($$
  SELECT begin_reservation_prepayment(
    'd1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001',
    '0541234567', 4, NOW() + INTERVAL '2 hours')
$$, 'prepay_unavailable', 'начать оплату без провайдера нельзя');

-- Провайдер заведён, но ещё не проверен — этого НЕ достаточно
INSERT INTO payment_providers (id, org_id, location_id, provider, status, credential_ref) VALUES
  ('d6000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001', 'cardcom', 'configured', 'CARDCOM_TERMINAL');

SELECT is(
  reservation_prepay_policy('d1000000-0000-4000-8000-000000000001', 4),
  NULL,
  'статуса configured мало: живой проверки связи не было');

-- ── Живой провайдер ──────────────────────────────────────────

UPDATE payment_providers SET status = 'healthy'
WHERE id = 'd6000000-0000-4000-8000-000000000001';

SELECT is(
  (reservation_prepay_policy('d1000000-0000-4000-8000-000000000001', 4) ->> 'amount_per_guest')::INTEGER,
  5000, 'сумма с гостя берётся из настроек точки');
SELECT is(
  (reservation_prepay_policy('d1000000-0000-4000-8000-000000000001', 4) ->> 'total')::INTEGER,
  20000, 'итог считает СЕРВЕР: 4 гостя × 50 ₪');
SELECT is(
  reservation_prepay_policy('d1000000-0000-4000-8000-000000000001', 4) ->> 'currency',
  'ILS', 'валюта приходит с сервера');
SELECT is(
  (reservation_prepay_policy('d1000000-0000-4000-8000-000000000001', 4) ->> 'refund_cutoff_hours')::INTEGER,
  24, 'срок бесплатной отмены — из настроек');

-- Порог по размеру компании (063) продолжает работать
SELECT is(
  reservation_prepay_policy('d1000000-0000-4000-8000-000000000001', 1),
  NULL, 'одиночному гостю предоплата не требуется: порог от двух');

-- Политика гостю секретов не отдаёт
SELECT ok(
  NOT (reservation_prepay_policy('d1000000-0000-4000-8000-000000000001', 4) ? 'credential_ref'),
  'политика не содержит ссылки на секрет провайдера');

-- ── Начало оплаты держит стол ────────────────────────────────

SELECT lives_ok($$
  SELECT begin_reservation_prepayment(
    'd1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001',
    '0541234567', 4, NOW() + INTERVAL '2 hours',
    NULL, NULL, NULL, 'Вольд', 'Анотов', 'guest@example.com')
$$, 'оплата начинается при живом провайдере');

SELECT is(
  (SELECT deposit_status FROM reservations
   WHERE client_uuid = 'd2000000-0000-4000-8000-000000000001'),
  'awaiting', 'бронь ждёт оплаты, а не считается оплаченной');
-- Даже в instant-режиме бронь НЕ подтверждена, пока не заплачено
SELECT is(
  (SELECT status FROM reservations
   WHERE client_uuid = 'd2000000-0000-4000-8000-000000000001'),
  'new', 'instant-режим не подтверждает бронь до оплаты');
SELECT isnt(
  (SELECT hold_expires_at FROM reservations
   WHERE client_uuid = 'd2000000-0000-4000-8000-000000000001'),
  NULL, 'у неоплаченной брони стоит срок удержания стола');
-- Стол реально занят: он выбран, значит EXCLUDE-констрейнт его держит
SELECT isnt(
  (SELECT table_id FROM reservations
   WHERE client_uuid = 'd2000000-0000-4000-8000-000000000001'),
  NULL, 'стол закреплён — место не уедет, пока гость платит');
SELECT is(
  (SELECT amount_minor FROM reservation_payments
   WHERE attempt_key = 'd5000000-0000-4000-8000-000000000001'),
  20000, 'в попытке лежит серверная сумма');

-- Повторный тап «оплатить» не создаёт вторую бронь
SELECT is(
  (SELECT (begin_reservation_prepayment(
     'd1000000-0000-4000-8000-000000000001',
     'd2000000-0000-4000-8000-000000000001',
     'd5000000-0000-4000-8000-000000000001',
     '0541234567', 4, NOW() + INTERVAL '2 hours') ->> 'duplicate')::BOOLEAN),
  TRUE, 'повтор попытки идемпотентен');
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservation_payments
   WHERE attempt_key = 'd5000000-0000-4000-8000-000000000001'),
  1, 'второй записи о платеже не появилось');

-- ── Подтверждение только проверенное ─────────────────────────

SELECT throws_ok($$
  SELECT confirm_reservation_prepayment(
    'd5000000-0000-4000-8000-000000000001', 'tx-1', 100)
$$, 'amount_mismatch', 'платёж на чужую сумму отклонён');

SELECT is(
  (SELECT deposit_status FROM reservations
   WHERE client_uuid = 'd2000000-0000-4000-8000-000000000001'),
  'awaiting', 'после отказа бронь так и не оплачена');

SELECT is(
  confirm_reservation_prepayment(
    'd5000000-0000-4000-8000-000000000001', 'tx-1', 20000) ->> 'status',
  'paid', 'верная сумма подтверждает оплату');

SELECT is(
  (SELECT deposit_status FROM reservations
   WHERE client_uuid = 'd2000000-0000-4000-8000-000000000001'),
  'paid', 'депозит помечен оплаченным');
SELECT is(
  (SELECT status FROM reservations
   WHERE client_uuid = 'd2000000-0000-4000-8000-000000000001'),
  'confirmed', 'только теперь instant-бронь подтверждена');
SELECT is(
  (SELECT hold_expires_at FROM reservations
   WHERE client_uuid = 'd2000000-0000-4000-8000-000000000001'),
  NULL, 'удержание снято — бронь больше не временная');
SELECT isnt(
  (SELECT verified_at FROM reservation_payments
   WHERE attempt_key = 'd5000000-0000-4000-8000-000000000001'),
  NULL, 'момент проверки записан');

-- Повторная доставка вебхука ничего не меняет
SELECT is(
  (SELECT (confirm_reservation_prepayment(
     'd5000000-0000-4000-8000-000000000001', 'tx-1', 20000) ->> 'duplicate')::BOOLEAN),
  TRUE, 'повтор вебхука идемпотентен');

-- ── Истёкшее удержание возвращает стол ───────────────────────

SELECT begin_reservation_prepayment(
  'd1000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000002',
  'd5000000-0000-4000-8000-000000000002',
  '0549999999', 2, NOW() + INTERVAL '6 hours',
  NULL, NULL, NULL, 'Второй', 'Гость', 'second@example.com');

UPDATE reservation_payments SET expires_at = NOW() - INTERVAL '1 minute'
WHERE attempt_key = 'd5000000-0000-4000-8000-000000000002';

SELECT lives_ok($$ SELECT expire_reservation_holds() $$, 'уборка удержаний отрабатывает');

SELECT is(
  (SELECT status FROM reservations
   WHERE client_uuid = 'd2000000-0000-4000-8000-000000000002'),
  'cancelled', 'неоплаченная бронь отменена, стол вернулся в продажу');

SELECT * FROM finish();
ROLLBACK;
