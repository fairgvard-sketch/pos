-- pgTAP: очередь уведомлений (158), аналитика удержания (159) и
-- расширенное стирание (160).
--
-- Проверяется то, ради чего это сделано: очередь обязана честно
-- называть «нечем отправлять», когорты возврата — делиться на созревшую
-- базу, а стирание — накрывать всё, что появилось после 131.

BEGIN;
SELECT plan(30);

INSERT INTO orgs (id, name) VALUES
  ('d5000000-0000-4000-8000-000000000001', 'pgTAP retention');
INSERT INTO locations (id, org_id, name, timezone, settings) VALUES
  ('d5100000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000001', 'Retention loc', 'Asia/Jerusalem',
   '{"reservations":{"duration_min":90}}'::jsonb);
INSERT INTO organization_products (org_id, product) VALUES
  ('d5000000-0000-4000-8000-000000000001', 'reservations');
INSERT INTO auth.users (id) VALUES
  ('d5400000-0000-4000-8000-000000000001'),
  ('d5400000-0000-4000-8000-000000000002');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('d5500000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000001', 'd5400000-0000-4000-8000-000000000001',
   'owner', TRUE),
  ('d5500000-0000-4000-8000-000000000002',
   'd5000000-0000-4000-8000-000000000001', 'd5400000-0000-4000-8000-000000000002',
   'manager', TRUE);
INSERT INTO tables (id, org_id, location_id, label, seats, sort_order) VALUES
  ('d5200000-0000-4000-8000-000000000001',
   'd5000000-0000-4000-8000-000000000001',
   'd5100000-0000-4000-8000-000000000001', '1', 4, 0);

INSERT INTO guests (id, org_id, phone, name, notes) VALUES
  ('d6000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001',
   '0521111111', 'Вернулась', NULL),
  ('d6000000-0000-4000-8000-000000000002', 'd5000000-0000-4000-8000-000000000001',
   '0522222222', 'Не вернулся', NULL),
  ('d6000000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000001',
   '0523333333', 'Только что', NULL),
  ('d6000000-0000-4000-8000-000000000004', 'd5000000-0000-4000-8000-000000000001',
   '0524444444', 'Стираемый', 'Заметка о госте');

-- «Вернулась»: первый визит 200 дней назад, второй через 10 дней после
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id, source, created_at
) VALUES
  ('d5000000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001',
   gen_random_uuid(), 'Вернулась', '0521111111', 2,
   NOW() - INTERVAL '200 days', 'completed', 'd6000000-0000-4000-8000-000000000001',
   'qr', NOW() - INTERVAL '202 days'),
  ('d5000000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001',
   gen_random_uuid(), 'Вернулась', '0521111111', 2,
   NOW() - INTERVAL '190 days', 'completed', 'd6000000-0000-4000-8000-000000000001',
   'qr', NOW() - INTERVAL '191 days'),
-- «Не вернулся»: единственный визит 200 дней назад
  ('d5000000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001',
   gen_random_uuid(), 'Не вернулся', '0522222222', 2,
   NOW() - INTERVAL '200 days', 'completed', 'd6000000-0000-4000-8000-000000000002',
   'instagram', NOW() - INTERVAL '201 days'),
-- «Только что»: первый визит вчера — окно ещё не прожито
  ('d5000000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001',
   gen_random_uuid(), 'Только что', '0523333333', 2,
   NOW() - INTERVAL '1 day', 'completed', 'd6000000-0000-4000-8000-000000000003',
   'site', NOW() - INTERVAL '2 days'),
-- Неявка для доли исходов
  ('d5000000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001',
   gen_random_uuid(), 'Стираемый', '0524444444', 2,
   NOW() - INTERVAL '5 days', 'no_show', 'd6000000-0000-4000-8000-000000000004',
   'qr', NOW() - INTERVAL '6 days');

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d5400000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"d5000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Очередь уведомлений (158) ────────────────────────────────
SELECT is(
  (SELECT (get_notification_outbox_web(
     'd5100000-0000-4000-8000-000000000001') ->> 'provider_ready')::BOOLEAN),
  FALSE, 'провайдера нет — и это НАЗВАНО, а не показано пустым списком');

-- Событие ставит триггер подтверждения; здесь ставим напрямую под
-- service_role, как это делает доверенный сервер
RESET ROLE;
SELECT enqueue_notification(
  'd5000000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001',
  'reservation_confirmed', '0524444444',
  '{"guest_name":"Стираемый","guest_phone":"0524444444"}'::jsonb, 'test:1');
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT status FROM notification_outbox WHERE dedupe_key = 'test:1'),
  'skipped', 'без провайдера запись не «отправлена» и не «ждёт» — она пропущена');

SELECT is(
  (SELECT last_error FROM notification_outbox WHERE dedupe_key = 'test:1'),
  'no_provider', 'причина названа');

SELECT is(
  (SELECT lang FROM notification_outbox WHERE dedupe_key = 'test:1'),
  'he', 'язык точки снят снимком: через месяц по настройкам его не восстановить');

SELECT is(
  (SELECT timezone FROM notification_outbox WHERE dedupe_key = 'test:1'),
  'Asia/Jerusalem', 'часовой пояс тоже снят снимком');

SELECT is(
  (SELECT consent FROM notification_outbox WHERE dedupe_key = 'test:1'),
  'not_collected', 'согласие не выдумывается: продукт его не собирает');

SELECT is(
  (SELECT (get_notification_outbox_web(
     'd5100000-0000-4000-8000-000000000001') -> 'summary' ->> 'skipped')::INTEGER),
  1, 'сводка отвечает на вопрос «работает ли вообще»');

SELECT is(
  (SELECT get_notification_outbox_web(
     'd5100000-0000-4000-8000-000000000001') -> 'rows' -> 0 ->> 'recipient_tail'),
  '4444', 'очередь показывает хвост номера, а не выгружает контакты');

SELECT ok(
  (SELECT NOT (get_notification_outbox_web(
     'd5100000-0000-4000-8000-000000000001') -> 'rows' -> 0 ? 'recipient')),
  'полный получатель наружу не идёт');

-- Идемпотентность: повтор не создаёт второго сообщения гостю
RESET ROLE;
SELECT enqueue_notification(
  'd5000000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001',
  'reservation_confirmed', '0524444444', '{}'::jsonb, 'test:1');
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM notification_outbox WHERE dedupe_key = 'test:1'),
  1, 'повторная постановка не создаёт вторую запись');

-- Повтор без провайдера отказывает честно
SELECT throws_ok(
  format($$SELECT retry_notification_web(
      'd5100000-0000-4000-8000-000000000001', %L)$$,
    (SELECT id FROM notification_outbox WHERE dedupe_key = 'test:1')),
  'no_provider',
  'повтор без провайдера отказывает, а не переводит запись в вечное ожидание');

-- ── Аналитика удержания (159) ────────────────────────────────
SELECT is(
  (SELECT guest_retention_analytics_web(NULL, (NOW() - INTERVAL '210 days')::DATE,
                                        NOW()::DATE) ->> 'basis'),
  'reserved_at', 'ось помечена: путать момент визита и момент заявки нельзя');

SELECT is(
  (SELECT (guest_retention_analytics_web(NULL, (NOW() - INTERVAL '210 days')::DATE,
                                         NOW()::DATE)
           -> 'return_rate' -> 'd90' ->> 'mature')::INTEGER),
  2, 'созревшая база — только те, у кого окно уже прожито');

SELECT is(
  (SELECT (guest_retention_analytics_web(NULL, (NOW() - INTERVAL '210 days')::DATE,
                                         NOW()::DATE)
           -> 'return_rate' -> 'd90' ->> 'returned')::INTEGER),
  1, 'вернулся один из двоих созревших');

SELECT ok(
  (SELECT (guest_retention_analytics_web(NULL, (NOW() - INTERVAL '210 days')::DATE,
                                         NOW()::DATE)
           -> 'return_rate' -> 'd90' ->> 'mature')::INTEGER
      < (SELECT (guest_retention_analytics_web(NULL, (NOW() - INTERVAL '210 days')::DATE,
                                               NOW()::DATE)
                 -> 'return_rate' ->> 'cohort_size')::INTEGER)),
  'вчерашний гость не считается «не вернувшимся за 90 дней» — у него ещё есть срок');

SELECT is(
  (SELECT (guest_retention_analytics_web(NULL, (NOW() - INTERVAL '210 days')::DATE,
                                         NOW()::DATE)
           -> 'outcomes' ->> 'no_show')::INTEGER),
  1, 'неявки посчитаны');

SELECT ok(
  (SELECT jsonb_array_length(guest_retention_analytics_web(
     NULL, (NOW() - INTERVAL '210 days')::DATE, NOW()::DATE) -> 'by_source') >= 2),
  'каналы разделены');

SELECT is(
  (SELECT (s ->> 'completed')::INTEGER
   FROM jsonb_array_elements(guest_retention_analytics_web(
     NULL, (NOW() - INTERVAL '210 days')::DATE, NOW()::DATE) -> 'by_source') s
   WHERE s ->> 'source' = 'instagram'),
  1, 'качество канала считается по СОСТОЯВШИМСЯ визитам, а не по заявкам');

SELECT is(
  (SELECT guest_retention_analytics_web(NULL, (NOW() - INTERVAL '210 days')::DATE,
                                        NOW()::DATE) -> 'money'),
  'null'::jsonb,
  'у точки без кассы денежного блока НЕТ — ноль описывал бы гостей, а не отсутствие кассы');

SELECT throws_ok(
  $$SELECT guest_retention_analytics_web(NULL, NOW()::DATE, (NOW() - INTERVAL '5 days')::DATE)$$,
  'invalid_range',
  'перевёрнутый период отклоняется');

-- ── Стирание (160) ───────────────────────────────────────────
-- Причина отказа с именем гостя попадает в историю визита
RESET ROLE;
INSERT INTO reservation_events (org_id, location_id, reservation_id, type, detail)
SELECT 'd5000000-0000-4000-8000-000000000001', 'd5100000-0000-4000-8000-000000000001',
       r.id, 'cancelled',
       '{"reason":"Перезвонить Стираемому по 0524444444"}'::jsonb
FROM reservations r WHERE r.guest_id = 'd6000000-0000-4000-8000-000000000004';
SET LOCAL ROLE authenticated;

-- Менеджеру необратимое действие закрыто
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d5400000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"d5000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT throws_ok(
  $$SELECT anonymize_guest_web('d6000000-0000-4000-8000-000000000004', '0524444444')$$,
  'owner_only',
  'менеджер не может необратимо стереть человека');

-- Владелец может
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"d5400000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"d5000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT lives_ok(
  $$SELECT anonymize_guest_web('d6000000-0000-4000-8000-000000000004', '0524444444')$$,
  'владелец стирает личные данные по просьбе клиента');

SELECT ok(
  (SELECT NOT EXISTS (
     SELECT 1 FROM reservation_events
     WHERE detail::TEXT LIKE '%0524444444%' OR detail::TEXT LIKE '%Стираем%')),
  'причина отказа с именем и номером стёрта из истории визита');

SELECT ok(
  (SELECT EXISTS (
     SELECT 1 FROM reservation_events WHERE type = 'cancelled')),
  'сам факт отмены остался — это запись о работе заведения');

SELECT ok(
  (SELECT NOT EXISTS (
     SELECT 1 FROM notification_outbox
     WHERE payload::TEXT LIKE '%0524444444%' OR payload::TEXT LIKE '%Стираем%')),
  'личные ключи payload очереди вычищены, а не только guest_name');

SELECT is(
  (SELECT recipient FROM notification_outbox WHERE dedupe_key = 'test:1'),
  NULL, 'получатель снят');

SELECT is(
  (SELECT customer_phone FROM reservations
   WHERE guest_id = 'd6000000-0000-4000-8000-000000000004' LIMIT 1),
  '', 'контакты в бронях стёрты, а визит остался в истории точки');

SELECT is(
  (SELECT lookup_guest_by_phone_web(
     'd5100000-0000-4000-8000-000000000001', '0524444444')),
  NULL, 'стёртого гостя узнавание больше не находит');

SELECT is(
  (SELECT notes FROM guests WHERE id = 'd6000000-0000-4000-8000-000000000004'),
  NULL, 'внутренняя заметка стёрта');

-- Повторное стирание отсекается раньше проверки номера: профиль уже
-- стёрт, и сверять больше не с чем.
SELECT throws_ok(
  $$SELECT anonymize_guest_web('d6000000-0000-4000-8000-000000000004', '0524444444')$$,
  'already_anonymized',
  'стереть дважды нельзя');

SELECT * FROM finish();
ROLLBACK;
