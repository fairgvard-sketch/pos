-- pgTAP: автоматические сегменты гостя (155).
--
-- Проверяется то, ради чего они и переписывались: сегмент обязан
-- работать у точки БЕЗ кассы, не надуваться отказами и тестовыми
-- бронями, объяснять себя числами и не называть новичка потерянным.

BEGIN;
SELECT plan(25);

INSERT INTO orgs (id, name) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'pgTAP segments');
INSERT INTO locations (id, org_id, name, timezone, settings) VALUES
  ('b1100000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'Seg loc', 'Asia/Jerusalem',
   '{"reservations":{"duration_min":90}}'::jsonb);
INSERT INTO organization_products (org_id, product) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'reservations');
INSERT INTO auth.users (id) VALUES ('b1400000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('b1500000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'b1400000-0000-4000-8000-000000000001',
   'owner', TRUE);

-- Гости заводятся напрямую: тест проверяет сегменты, а не путь заведения
INSERT INTO guests (id, org_id, phone, name) VALUES
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '0521111111', 'Постоянная'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', '0522222222', 'Новичок'),
  ('b2000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001', '0523333333', 'Пропавший'),
  ('b2000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000001', '0524444444', 'Неявка'),
  ('b2000000-0000-4000-8000-000000000005', 'b1000000-0000-4000-8000-000000000001', '0525555555', 'Пустой');

-- Постоянная: шесть завершённых визитов раз в две недели, последний вчера
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id
)
SELECT 'b1000000-0000-4000-8000-000000000001',
       'b1100000-0000-4000-8000-000000000001',
       gen_random_uuid(), 'Постоянная', '0521111111', 2,
       NOW() - make_interval(days => 1 + 14 * i), 'completed',
       'b2000000-0000-4000-8000-000000000001'
FROM generate_series(0, 5) AS i;

-- Новичок: один визит неделю назад
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id
) VALUES (
  'b1000000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000001',
  gen_random_uuid(), 'Новичок', '0522222222', 2,
  NOW() - INTERVAL '7 days', 'completed', 'b2000000-0000-4000-8000-000000000002');

-- Пропавший: три визита, последний 300 дней назад
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id
)
SELECT 'b1000000-0000-4000-8000-000000000001',
       'b1100000-0000-4000-8000-000000000001',
       gen_random_uuid(), 'Пропавший', '0523333333', 2,
       NOW() - make_interval(days => 300 + 30 * i), 'completed',
       'b2000000-0000-4000-8000-000000000003'
FROM generate_series(0, 2) AS i;

-- Неявка: две неявки и ни одного состоявшегося визита
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id
)
SELECT 'b1000000-0000-4000-8000-000000000001',
       'b1100000-0000-4000-8000-000000000001',
       gen_random_uuid(), 'Неявка', '0524444444', 2,
       NOW() - make_interval(days => 3 + i), 'no_show',
       'b2000000-0000-4000-8000-000000000004'
FROM generate_series(0, 1) AS i;

-- Мусор, который НЕ должен считаться визитом: тестовая, отклонённая,
-- отменённая — все на «Пустого»
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id, is_test
) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000001',
   gen_random_uuid(), 'Пустой', '0525555555', 2, NOW() - INTERVAL '2 days',
   'completed', 'b2000000-0000-4000-8000-000000000005', TRUE),
  ('b1000000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000001',
   gen_random_uuid(), 'Пустой', '0525555555', 2, NOW() - INTERVAL '3 days',
   'rejected', 'b2000000-0000-4000-8000-000000000005', FALSE),
  ('b1000000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000001',
   gen_random_uuid(), 'Пустой', '0525555555', 2, NOW() - INTERVAL '4 days',
   'cancelled', 'b2000000-0000-4000-8000-000000000005', FALSE);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b1400000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"b1000000-0000-4000-8000-000000000001"}}',
  true
);

CREATE TEMP VIEW seg AS
SELECT g ->> 'name' AS name,
       g -> 'segments' AS segments,
       g -> 'why_segment' AS why
FROM jsonb_array_elements(get_backoffice_guests(p_limit => 100)) g;

-- ── 1. Точка без кассы получает сегменты по визитам ──────────
SELECT ok(
  (SELECT segments @> '["regular"]'::jsonb FROM seg WHERE name = 'Постоянная'),
  'шесть завершённых броней делают гостя постоянным без единой продажи');

SELECT ok(
  (SELECT segments @> '["returning"]'::jsonb FROM seg WHERE name = 'Постоянная'),
  'постоянный гость — заодно и вернувшийся');

SELECT is(
  (SELECT (why ->> 'spend')::INTEGER FROM seg WHERE name = 'Постоянная'),
  0, 'у точки без кассы трат нет — и это ноль «не измеряли», а не выдумка');

SELECT is(
  (SELECT (why ->> 'from_bookings')::INTEGER FROM seg WHERE name = 'Постоянная'),
  6, 'визиты посчитаны по броням');

SELECT is(
  (SELECT (why ->> 'from_register')::INTEGER FROM seg WHERE name = 'Постоянная'),
  0, 'кассовых визитов нет');

-- ── 2. Новичок остаётся новичком, а не «потерянным» ──────────
SELECT ok(
  (SELECT segments @> '["new"]'::jsonb FROM seg WHERE name = 'Новичок'),
  'единственный недавний визит — это «новый»');

SELECT ok(
  (SELECT NOT (segments @> '["lost"]'::jsonb) FROM seg WHERE name = 'Новичок'),
  'новичка нельзя объявлять потерянным из-за короткой истории');

SELECT ok(
  (SELECT NOT (segments @> '["returning"]'::jsonb) FROM seg WHERE name = 'Новичок'),
  'один визит — ещё не возвращение');

-- ── 3. Потерянный назван и объяснён ──────────────────────────
SELECT ok(
  (SELECT segments @> '["lost"]'::jsonb FROM seg WHERE name = 'Пропавший'),
  'триста дней молчания после трёх визитов — потерянный гость');

SELECT ok(
  (SELECT (why ->> 'days_since')::INTEGER >= 300 FROM seg WHERE name = 'Пропавший'),
  'метка объяснена числом дней, а не словом');

SELECT ok(
  (SELECT NOT (segments @> '["at_risk"]'::jsonb) FROM seg WHERE name = 'Пропавший'),
  'потерянный не помечается ещё и «под угрозой» — это одно молчание');

-- ── 4. Повторные неявки видны, но визитами не считаются ──────
SELECT ok(
  (SELECT segments @> '["repeat_no_show"]'::jsonb FROM seg WHERE name = 'Неявка'),
  'две неявки — предупреждение смене');

SELECT is(
  (SELECT (why ->> 'visits')::INTEGER FROM seg WHERE name = 'Неявка'),
  0, 'неявка не состоявшийся визит');

SELECT is(
  (SELECT (why ->> 'no_shows')::INTEGER FROM seg WHERE name = 'Неявка'),
  2, 'число неявок названо');

-- ── 5. Мусор не надувает историю ─────────────────────────────
SELECT is(
  (SELECT (why ->> 'visits')::INTEGER FROM seg WHERE name = 'Пустой'),
  0, 'тестовая, отклонённая и отменённая брони визитами не являются');

SELECT is(
  (SELECT jsonb_array_length(segments) FROM seg WHERE name = 'Пустой'),
  0, 'у гостя без настоящей истории сегментов нет вовсе');

-- ── 6. Новый визит меняет классификацию ──────────────────────
-- Данные дописываем от владельца схемы: прямая запись в reservations
-- закрыта для `authenticated` (пишут только RPC), а тесту нужны
-- конкретные статусы и даты, которых ни одна из них не принимает.
RESET ROLE;
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id
) VALUES (
  'b1000000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000001',
  gen_random_uuid(), 'Пропавший', '0523333333', 2,
  NOW() - INTERVAL '1 day', 'completed', 'b2000000-0000-4000-8000-000000000003');
SET LOCAL ROLE authenticated;

SELECT ok(
  (SELECT NOT (segments @> '["lost"]'::jsonb) FROM seg WHERE name = 'Пропавший'),
  'вернувшийся гость перестаёт быть потерянным сам, без пересчёта метки');

SELECT ok(
  (SELECT segments @> '["returning"]'::jsonb FROM seg WHERE name = 'Пропавший'),
  'и снова считается вернувшимся');

-- ── 7. Будущая бронь — отдельный ответ ───────────────────────
RESET ROLE;
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id
) VALUES (
  'b1000000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000001',
  gen_random_uuid(), 'Постоянная', '0521111111', 2,
  NOW() + INTERVAL '2 days', 'confirmed', 'b2000000-0000-4000-8000-000000000001');
SET LOCAL ROLE authenticated;

SELECT ok(
  (SELECT segments @> '["upcoming"]'::jsonb FROM seg WHERE name = 'Постоянная'),
  'будущая бронь — свой сегмент, а не замена «постоянному»');

SELECT ok(
  (SELECT segments @> '["regular"]'::jsonb FROM seg WHERE name = 'Постоянная'),
  'и постоянство при этом не потерялось');

-- ── 8. Отбор по сегменту и страницы ──────────────────────────
SELECT is(
  (SELECT jsonb_array_length(get_backoffice_guests(p_segment => 'repeat_no_show'))),
  1, 'отбор по сегменту считает сервер');

SELECT is(
  (SELECT get_backoffice_guests(p_segment => 'repeat_no_show') -> 0 ->> 'name'),
  'Неявка', 'и находит именно того');

SELECT is(
  (SELECT jsonb_array_length(get_backoffice_guests(p_limit => 2))),
  2, 'страница ограничена');

SELECT isnt(
  (SELECT get_backoffice_guests(p_limit => 1, p_offset => 0) -> 0 ->> 'phone'),
  (SELECT get_backoffice_guests(p_limit => 1, p_offset => 1) -> 0 ->> 'phone'),
  'смещение действительно двигает окно, а не отдаёт ту же строку');

-- ── 9. Граница арендатора ────────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b1400000-0000-4000-8000-000000000009","role":"authenticated","app_metadata":{"org_id":"b1000000-0000-4000-8000-000000000009"}}',
  true
);

-- Чужой JWT не просто получает пустой список: у него нет ни роли
-- кабинета, ни PIN-сессии, и функция отказывает до всякого чтения.
SELECT throws_ok(
  $$SELECT get_backoffice_guests(p_limit => 100)$$,
  'staff session required',
  'без права кабинета клиентская база не открывается');

SELECT * FROM finish();
ROLLBACK;
