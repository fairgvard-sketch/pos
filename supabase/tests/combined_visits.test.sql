-- pgTAP: один канонический счётчик визитов (161).
--
-- Проверяется то, из-за чего он и заведён: на живой приёмке один гость
-- показывался с 6 визитами в списке и 4 в карточке, а читалка называла
-- третье число. Здесь три вида активности — только брони, только касса
-- и бронь, посаженная в заказ, — и главное: связанный случай НЕ должен
-- считаться дважды.

BEGIN;
SELECT plan(16);

INSERT INTO orgs (id, name) VALUES
  ('e5000000-0000-4000-8000-000000000001', 'pgTAP combined visits');
INSERT INTO locations (id, org_id, name, timezone, currency, vat_rate, settings) VALUES
  ('e5100000-0000-4000-8000-000000000001',
   'e5000000-0000-4000-8000-000000000001', 'Visits loc', 'Asia/Jerusalem',
   'ILS', 18, '{"reservations":{"duration_min":90}}'::jsonb);
INSERT INTO organization_products (org_id, product) VALUES
  ('e5000000-0000-4000-8000-000000000001', 'reservations');
INSERT INTO auth.users (id) VALUES ('e5400000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('e5500000-0000-4000-8000-000000000001',
   'e5000000-0000-4000-8000-000000000001', 'e5400000-0000-4000-8000-000000000001',
   'owner', TRUE);
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('e5300000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001',
   'e5100000-0000-4000-8000-000000000001', 'Кассир', 'manager', 'x');

-- Legacy-счётчик лояльности намеренно РАЗЪЕХАЛСЯ с реальностью: именно
-- он и показывался в карточке вместо визитов.
INSERT INTO guests (id, org_id, phone, name, visits, total_spent, points) VALUES
  ('e6000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001',
   '0521111111', 'Только брони', 99, 0, 250),
  ('e6000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000001',
   '0522222222', 'Только касса', 99, 0, 0),
  ('e6000000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-000000000001',
   '0523333333', 'Бронь в заказе', 99, 0, 0);

-- ── Только брони: три завершённых визита ─────────────────────
INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id)
SELECT 'e5000000-0000-4000-8000-000000000001', 'e5100000-0000-4000-8000-000000000001',
       gen_random_uuid(), 'Только брони', '0521111111', 2,
       NOW() - make_interval(days => 10 * i), 'completed',
       'e6000000-0000-4000-8000-000000000001'
FROM generate_series(1, 3) i;

-- ── Только касса: два оплаченных заказа без брони ────────────
INSERT INTO orders (
  org_id, location_id, staff_id, client_uuid, daily_number, status,
  vat_rate, total, guest_id, created_at, paid_at)
SELECT 'e5000000-0000-4000-8000-000000000001', 'e5100000-0000-4000-8000-000000000001',
       'e5300000-0000-4000-8000-000000000001', gen_random_uuid(), i, 'paid',
       18, 5000, 'e6000000-0000-4000-8000-000000000002',
       NOW() - make_interval(days => 5 * i), NOW() - make_interval(days => 5 * i)
FROM generate_series(1, 2) i;

-- ── Связанный случай: ОДИН визит, у которого есть и бронь, и заказ ──
INSERT INTO orders (
  id, org_id, location_id, staff_id, client_uuid, daily_number, status,
  vat_rate, total, guest_id, created_at, paid_at) VALUES
  ('e7000000-0000-4000-8000-000000000001',
   'e5000000-0000-4000-8000-000000000001', 'e5100000-0000-4000-8000-000000000001',
   'e5300000-0000-4000-8000-000000000001', gen_random_uuid(), 50, 'paid',
   18, 12000, 'e6000000-0000-4000-8000-000000000003',
   NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days');

INSERT INTO reservations (
  org_id, location_id, client_uuid, customer_name, customer_phone,
  party_size, reserved_at, status, guest_id, order_id) VALUES
  ('e5000000-0000-4000-8000-000000000001', 'e5100000-0000-4000-8000-000000000001',
   gen_random_uuid(), 'Бронь в заказе', '0523333333', 2,
   NOW() - INTERVAL '3 days', 'completed', 'e6000000-0000-4000-8000-000000000003',
   'e7000000-0000-4000-8000-000000000001');

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"e5400000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"e5000000-0000-4000-8000-000000000001"}}',
  true
);

CREATE TEMP VIEW rows AS
SELECT g ->> 'name' AS name,
       (g ->> 'combined_visits')::INTEGER AS combined,
       (g ->> 'visits')::INTEGER AS loyalty,
       (g -> 'why_segment' ->> 'visits')::INTEGER AS why
FROM jsonb_array_elements(get_backoffice_guests(p_limit => 100)) g;

-- ── 1. Только брони ──────────────────────────────────────────
SELECT is((SELECT combined FROM rows WHERE name = 'Только брони'), 3,
  'три завершённых брони — три визита');

SELECT is((SELECT combined FROM rows WHERE name = 'Только брони'),
          (SELECT why FROM rows WHERE name = 'Только брони'),
  'канонический счётчик совпадает с тем, что объясняет метку');

SELECT is((SELECT loyalty FROM rows WHERE name = 'Только брони'), 99,
  'счётчик лояльности кассы сохранён и НЕ подменён — это другое понятие');

-- ── 2. Только касса ──────────────────────────────────────────
SELECT is((SELECT combined FROM rows WHERE name = 'Только касса'), 2,
  'два оплаченных заказа без брони — два визита');

SELECT is((SELECT combined FROM rows WHERE name = 'Только касса'),
          (SELECT why FROM rows WHERE name = 'Только касса'),
  'и здесь строка и объяснение сходятся');

-- ── 3. Связанный случай: НЕ дважды ───────────────────────────
SELECT is((SELECT combined FROM rows WHERE name = 'Бронь в заказе'), 1,
  'бронь, посаженная в заказ, — ОДИН визит, а не два');

SELECT is(
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000003') ->> 'combined_visits')::INTEGER),
  1, 'карточка того же гостя показывает то же самое число');

-- ── 4. Список и карточка сходятся у всех троих ───────────────
SELECT is(
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000001') ->> 'combined_visits')::INTEGER),
  (SELECT combined FROM rows WHERE name = 'Только брони'),
  'список и карточка: только брони');

SELECT is(
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000002') ->> 'combined_visits')::INTEGER),
  (SELECT combined FROM rows WHERE name = 'Только касса'),
  'список и карточка: только касса');

SELECT is(
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000001')
           -> 'why_segment' ->> 'visits')::INTEGER),
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000001') ->> 'combined_visits')::INTEGER),
  'в карточке объяснение метки и счётчик — одно число');

-- ── 5. Лояльность не пострадала ──────────────────────────────
SELECT is(
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000001') ->> 'visits')::INTEGER),
  99, 'счётчик лояльности в карточке остался прежним');

SELECT is(
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000001') ->> 'points')::INTEGER),
  250, 'баллы не тронуты');

/*
 * ЗАФИКСИРОВАНО ФАКТИЧЕСКОЕ ПОВЕДЕНИЕ, А НЕ ЖЕЛАЕМОЕ.
 *
 * `guest_retention_facts` (155) исключает заказ, привязанный к броне,
 * ЦЕЛИКОМ — чтобы посаженный визит не посчитался дважды. Вместе с
 * визитом теряются и деньги этого заказа: у гостя, который всегда
 * бронирует стол, `spend` остаётся нулём.
 *
 * Это отдельный дефект (VIP по тратам у такого заведения не сработает
 * никогда), и он НЕ входит в четыре исправляемых здесь. Тест закрепляет
 * текущую правду, чтобы будущая правка была заметной и осознанной.
 */
SELECT is(
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000003')
           -> 'why_segment' ->> 'spend')::INTEGER),
  0, 'известное ограничение 155: деньги заказа под бронью в spend не попадают');

-- ── 6. Разложение видно и проверяемо ─────────────────────────
SELECT is(
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000003')
           -> 'why_segment' ->> 'from_bookings')::INTEGER),
  1, 'бронь посчитана в броневой части');

SELECT is(
  (SELECT (get_guest_card('e6000000-0000-4000-8000-000000000003')
           -> 'why_segment' ->> 'from_register')::INTEGER),
  0, 'а в кассовой — нет, иначе это и был бы двойной счёт');

-- ── 7. Отбор и страницы не изменились ────────────────────────
SELECT is(
  (SELECT jsonb_array_length(get_backoffice_guests(p_limit => 2))),
  2, 'страница по-прежнему ограничена сервером');

SELECT * FROM finish();
ROLLBACK;
