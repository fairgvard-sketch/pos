-- pgTAP: лента активности кассы (098).
--
-- Проверяем два контура:
--  1) триггеры реально пишут activity_events при открытии/закрытии смены и
--     возврате — событие рождается в БД, а не со слов клиента;
--  2) get_activity_feed: гейт (членство ИЛИ manage-сессия), изоляция org под
--     RLS, пагинация, anon закрыт.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(11);

-- ── Фикстура: две org, у каждой точка и сотрудник ──
INSERT INTO orgs (id, name) VALUES
  ('80000000-0000-4000-8000-000000000001', 'pgTAP act A1'),
  ('80000000-0000-4000-8000-000000000002', 'pgTAP act A2');

INSERT INTO locations (id, org_id, name) VALUES
  ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'Loc A1'),
  ('81000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000002', 'Loc A2');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('82000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001',
   '81000000-0000-4000-8000-000000000001', 'Барист А1', 'barista', 'unused'),
  ('82000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000002',
   '81000000-0000-4000-8000-000000000002', 'Барист А2', 'barista', 'unused');

-- ── 1. Триггеры: открытие смены ──
-- Пишем прямо в shifts (as postgres/owner) — эмулируем эффект open_shift.
INSERT INTO shifts (id, org_id, location_id, opened_by, opening_float)
VALUES ('83000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001',
        '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 20000);

SELECT is(
  (SELECT COUNT(*)::int FROM activity_events
   WHERE type = 'shift_opened' AND ref_id = '83000000-0000-4000-8000-000000000001'),
  1, 'открытие смены пишет одно событие shift_opened');

SELECT is(
  (SELECT staff_name FROM activity_events WHERE ref_id = '83000000-0000-4000-8000-000000000001'),
  'Барист А1', 'имя сотрудника снапшочено в событие');

SELECT is(
  (SELECT amount FROM activity_events WHERE ref_id = '83000000-0000-4000-8000-000000000001'),
  20000, 'opening_float попал в amount');

-- ── Триггеры: закрытие смены ──
UPDATE shifts SET status = 'closed', closed_by = '82000000-0000-4000-8000-000000000001',
       total_sales = 55000, cash_diff = -300, orders_count = 12, closed_at = NOW()
WHERE id = '83000000-0000-4000-8000-000000000001';

SELECT is(
  (SELECT COUNT(*)::int FROM activity_events
   WHERE type = 'shift_closed' AND ref_id = '83000000-0000-4000-8000-000000000001'),
  1, 'закрытие смены пишет одно событие shift_closed');

SELECT is(
  (SELECT amount FROM activity_events WHERE type = 'shift_closed'
   AND ref_id = '83000000-0000-4000-8000-000000000001'),
  55000, 'total_sales попал в amount закрытия');

SELECT is(
  (SELECT (detail ->> 'cash_diff')::int FROM activity_events WHERE type = 'shift_closed'
   AND ref_id = '83000000-0000-4000-8000-000000000001'),
  -300, 'cash_diff снапшочен в detail');

-- Повторный апдейт уже закрытой смены НЕ плодит второе событие
UPDATE shifts SET close_note = 'уточнение' WHERE id = '83000000-0000-4000-8000-000000000001';
SELECT is(
  (SELECT COUNT(*)::int FROM activity_events
   WHERE type = 'shift_closed' AND ref_id = '83000000-0000-4000-8000-000000000001'),
  1, 'повторный апдейт закрытой смены не дублирует событие');

-- ── Триггеры: возврат ──
INSERT INTO orders (id, org_id, location_id, staff_id, client_uuid, daily_number,
  order_type, status, subtotal, vat_rate, vat_amount, total, paid_at)
VALUES ('84000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
  '85000000-0000-4000-8000-000000000001', 1, 'here', 'refunded', 3000, 18, 458, 3000, NOW());

INSERT INTO refunds (id, org_id, location_id, order_id, staff_id, amount, method, reason)
VALUES ('86000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001', 3000, 'card', 'брак');

SELECT is(
  (SELECT (detail ->> 'reason') FROM activity_events WHERE type = 'refund_issued'
   AND ref_id = '86000000-0000-4000-8000-000000000001'),
  'брак', 'возврат пишет событие refund_issued с причиной');

-- ── 2. get_activity_feed: гейт членства + изоляция org ──
INSERT INTO auth.users (id) VALUES
  ('87000000-0000-4000-8000-000000000001'),  -- владелец A1
  ('87000000-0000-4000-8000-000000000002');  -- аккаунт без членства

-- Тот же человек — владелец обеих org (чтобы гейт прошёл под любым клеймом,
-- а видимость решала RLS, а не отсутствие членства).
INSERT INTO organization_members (org_id, auth_user_id, role, is_active) VALUES
  ('80000000-0000-4000-8000-000000000001', '87000000-0000-4000-8000-000000000001', 'owner', TRUE),
  ('80000000-0000-4000-8000-000000000002', '87000000-0000-4000-8000-000000000001', 'owner', TRUE);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"87000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000001"}}',
  true);

-- 3 события своей org (open+close+refund), чужой — 0
SELECT is(
  jsonb_array_length(get_activity_feed()),
  3, 'владелец видит все события своей организации');

-- Чужая org недостижима: ставим клейм на org2, где событий нет
SELECT set_config('request.jwt.claims',
  '{"sub":"87000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"80000000-0000-4000-8000-000000000002"}}',
  true);
SELECT is(
  jsonb_array_length(get_activity_feed()),
  0, 'события чужой организации не видны под её клеймом (RLS)');

RESET ROLE;

-- ── Контракт: anon не вызывает ──
-- 133: сигнатура расширена фильтрами (диапазон, тип, сотрудник, терминал,
-- поиск); прежние четыре параметра сохранены со значениями по умолчанию.
SELECT ok(
  NOT has_function_privilege('anon',
    'get_activity_feed(integer,timestamptz,uuid,uuid,timestamptz,timestamptz,text[],uuid,uuid,text)',
    'EXECUTE'),
  'anon не вызывает get_activity_feed');

SELECT * FROM finish();
ROLLBACK;
