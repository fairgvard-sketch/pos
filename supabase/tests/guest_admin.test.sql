-- pgTAP: клиентская база — правка профиля, дубли, слияние, приватность (131).
--
-- Три обещания раздела «Customers», которые проверяются здесь:
--
--   * слияние НИЧЕГО не теряет: история переезжает, балансы
--     складываются, старый номер продолжает узнавать человека;
--   * стирание личных данных НЕ трогает заказы — это документы учёта,
--     но и не оставляет имя в аудите правок;
--   * профиль правится только через RPC: колоночных грантов больше нет.

BEGIN;
SELECT plan(56);

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'pgTAP customers'),
  ('e0000000-0000-4000-8000-0000000000ff', 'pgTAP чужая');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('e1000000-0000-4000-8000-000000000001',
   'e0000000-0000-4000-8000-000000000001', 'Главная', 'Asia/Jerusalem'),
  ('e1000000-0000-4000-8000-0000000000ff',
   'e0000000-0000-4000-8000-0000000000ff', 'Чужая', 'Asia/Jerusalem');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('e3000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', 'Бариста', 'barista', 'x');

-- Гости. G1 и G2 — один человек: номер записан с кодом страны и без.
INSERT INTO guests (id, org_id, phone, name, stamps, points, visits, total_spent,
                    tags, created_at, last_visit_at) VALUES
  ('e2000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   '0501234567', 'Дана', 2, 500, 3, 10000, ARRAY['VIP'],
   NOW() - INTERVAL '100 days', NOW() - INTERVAL '2 days'),
  ('e2000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001',
   '972501234567', 'Дана Леви', 1, 100, 1, 4000, ARRAY['опоздала'],
   NOW() - INTERVAL '300 days', NOW() - INTERVAL '10 days'),
  ('e2000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001',
   '0521112222', 'Йоси', 0, 0, 10, 50000, '{}',
   NOW() - INTERVAL '400 days', NOW() - INTERVAL '200 days'),
  ('e2000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000001',
   '0539998888', 'Йоси', 0, 0, 0, 0, '{}', NOW() - INTERVAL '3 days', NULL),
  -- Тот же номер в ЧУЖОЙ организации: в дубли попасть не должен
  ('e2000000-0000-4000-8000-0000000000ff', 'e0000000-0000-4000-8000-0000000000ff',
   '0501234567', 'Чужая Дана', 0, 0, 1, 1000, '{}', NOW(), NOW());

-- История второго профиля — она и должна переехать при слиянии
INSERT INTO orders (id, org_id, location_id, staff_id, client_uuid, daily_number,
                    status, subtotal, vat_rate, total, guest_id) VALUES
  ('e4000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001',
   'e5000000-0000-4000-8000-000000000001', 1, 'paid', 4000, 18, 4000,
   'e2000000-0000-4000-8000-000000000002'),
  -- Заказ третьего профиля: он переживёт стирание личных данных
  ('e4000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001',
   'e5000000-0000-4000-8000-000000000003', 2, 'paid', 5000, 18, 5000,
   'e2000000-0000-4000-8000-000000000003');

INSERT INTO loyalty_events (org_id, guest_id, order_id, kind, points_delta) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000002',
   'e4000000-0000-4000-8000-000000000001', 'earn', 100);

INSERT INTO reservations (id, org_id, location_id, client_uuid, customer_name,
                          customer_phone, party_size, reserved_at, duration_min,
                          status, note, guest_id) VALUES
  ('e6000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001',
   'Дана Леви', '972501234567', 2, NOW() - INTERVAL '20 days', 90, 'completed',
   'у окна', 'e2000000-0000-4000-8000-000000000002'),
  -- Прошлый визит третьего гостя: контакты обязаны стереться
  ('e6000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000003',
   'Йоси', '0521112222', 4, NOW() - INTERVAL '30 days', 90, 'completed',
   'без глютена', 'e2000000-0000-4000-8000-000000000003');

INSERT INTO waitlist_entries (org_id, location_id, client_uuid, guest_id,
                              customer_name, customer_phone, party_size,
                              wanted_date, time_from, time_to) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
   'e7000000-0000-4000-8000-00000000000f', 'e2000000-0000-4000-8000-000000000002',
   'Дана Леви', '972501234567', 2, CURRENT_DATE, '19:00', '21:00');

-- Веб-владелец: право даёт членство, PIN-сессия не нужна (091/096)
INSERT INTO auth.users (id) VALUES ('e8000000-0000-4000-8000-000000000001');
INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('e9000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'e8000000-0000-4000-8000-000000000001', 'owner', TRUE);

-- ── Правка профиля стала RPC-only ────────────────────────────
-- Проверяем ГРАНТ, а не попытку записи: pgTAP исполняется
-- суперпользователем, для которого колоночные гранты не действуют.
SELECT ok(NOT has_column_privilege('authenticated', 'guests', 'name', 'UPDATE'),
  'имя гостя правится только через RPC');
SELECT ok(NOT has_column_privilege('authenticated', 'guests', 'phone', 'UPDATE'),
  'телефон гостя правится только через RPC');
SELECT ok(NOT has_column_privilege('authenticated', 'guests', 'notes', 'UPDATE'),
  'заметка гостя правится только через RPC (грант 114 отозван)');
SELECT ok(has_column_privilege('authenticated', 'guests', 'name', 'INSERT'),
  'заводить гостя касса по-прежнему может прямой вставкой');

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"e8000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"e0000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── 1. Телефон в профиле ─────────────────────────────────────
SELECT lives_ok($$
  SELECT set_guest_profile('e2000000-0000-4000-8000-000000000004',
                           p_phone => '054-000-11-11')
$$, 'телефон правится из кабинета');
SELECT is(
  (SELECT phone FROM guests WHERE id = 'e2000000-0000-4000-8000-000000000004'),
  '0540001111', 'телефон нормализован до цифр — ключ узнавания один');
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guest_audit
   WHERE guest_id = 'e2000000-0000-4000-8000-000000000004' AND field = 'phone'),
  1, 'смена телефона попала в аудит');

SELECT throws_ok($$
  SELECT set_guest_profile('e2000000-0000-4000-8000-000000000004',
                           p_phone => '0501234567')
$$, 'phone_taken',
  'занятый номер отдаёт свой код — кабинет предложит слияние, а не «нарушение уникальности»');
SELECT throws_ok($$
  SELECT set_guest_profile('e2000000-0000-4000-8000-000000000004', p_phone => '12')
$$, 'phone_invalid', 'обрывок номера не принимается');
SELECT is(
  (SELECT phone FROM guests WHERE id = 'e2000000-0000-4000-8000-000000000004'),
  '0540001111', 'после отказов телефон остался прежним');

SELECT throws_ok($$
  SELECT set_guest_profile('e2000000-0000-4000-8000-0000000000ff', p_name => 'Взлом')
$$, 'guest not found', 'чужого гостя не поправить');

-- ── 2. Сегменты ──────────────────────────────────────────────
SELECT is(jsonb_array_length(get_backoffice_guests()), 4,
  'список отдаёт клиентов своей организации');
SELECT is(
  jsonb_array_length(get_backoffice_guests(p_min_visits => 3)), 2,
  'сегмент «от 3 визитов»');
SELECT is(
  jsonb_array_length(get_backoffice_guests(p_min_spent => 20000)), 1,
  'сегмент «от 200 ₪»');
SELECT is(
  jsonb_array_length(get_backoffice_guests(p_tags => ARRAY['VIP'])), 1,
  'сегмент по метке');
SELECT is(
  jsonb_array_length(get_backoffice_guests(p_seen_days => 5)), 1,
  'сегмент «был за последние 5 дней»');
SELECT is(
  jsonb_array_length(get_backoffice_guests(p_inactive_days => 90)), 1,
  'сегмент «пропал»: ни разу не приходивший в него не попадает');
SELECT is(
  get_backoffice_guests(p_sort => 'spend') -> 0 ->> 'id',
  'e2000000-0000-4000-8000-000000000003',
  'сортировка по сумме ставит самого дорогого первым');
SELECT is(
  get_guest_tags_web() -> 0 ->> 'tag', 'VIP',
  'метки для сегментов приходят из данных');

-- ── 3. Дубли ─────────────────────────────────────────────────
CREATE FUNCTION pg_temp.dups() RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT find_guest_duplicates_web()
$$;

SELECT is(jsonb_array_length(pg_temp.dups()), 2,
  'найдены обе группы: один номер и одно имя');
SELECT is(
  (SELECT jsonb_array_length(d -> 'guests') FROM jsonb_array_elements(pg_temp.dups()) d
   WHERE d ->> 'reason' = 'phone'),
  2, 'номер с кодом страны и без — один человек, а не три: чужая организация не в счёт');
SELECT is(
  (SELECT jsonb_array_length(d -> 'guests') FROM jsonb_array_elements(pg_temp.dups()) d
   WHERE d ->> 'reason' = 'name'),
  2, 'одинаковое имя при разных номерах — подсказка, а не приговор');

-- ── 4. Слияние ───────────────────────────────────────────────
SELECT is(
  merge_guests_web('e2000000-0000-4000-8000-000000000001',
                   'e2000000-0000-4000-8000-000000000002') ->> 'orders',
  '1', 'слияние переносит заказы');

SELECT is(
  (SELECT guest_id FROM orders WHERE id = 'e4000000-0000-4000-8000-000000000001'),
  'e2000000-0000-4000-8000-000000000001', 'заказ теперь у объединённого профиля');
SELECT is(
  (SELECT guest_id FROM loyalty_events WHERE order_id = 'e4000000-0000-4000-8000-000000000001'),
  'e2000000-0000-4000-8000-000000000001', 'движение баллов переехало');
SELECT is(
  (SELECT guest_id FROM reservations WHERE id = 'e6000000-0000-4000-8000-000000000001'),
  'e2000000-0000-4000-8000-000000000001', 'бронь переехала');
SELECT is(
  (SELECT guest_id FROM waitlist_entries WHERE client_uuid = 'e7000000-0000-4000-8000-00000000000f'),
  'e2000000-0000-4000-8000-000000000001', 'лист ожидания переехал');

SELECT results_eq($$
  SELECT visits, total_spent, points, stamps
  FROM guests WHERE id = 'e2000000-0000-4000-8000-000000000001'
$$, $$ VALUES (4, 14000, 600, 3) $$,
  'балансы сложились — история не потерялась');

SELECT is(
  (SELECT cardinality(tags) FROM guests WHERE id = 'e2000000-0000-4000-8000-000000000001'),
  2, 'метки обоих профилей объединены');

-- Объединённый профиль клиенту БОЛЬШЕ НЕ ВИДЕН (132), поэтому смотрим на
-- него вне роли: иначе сравнивали бы с NULL и «проверка» проходила бы
-- при любой ошибке слияния.
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guests),
  3, 'касса не видит объединённый профиль даже прямым запросом к таблице');

RESET ROLE;
SELECT results_eq($$
  SELECT visits, total_spent, points, stamps
  FROM guests WHERE id = 'e2000000-0000-4000-8000-000000000002'
$$, $$ VALUES (0, 0, 0, 0) $$,
  'исходный профиль обнулён — балансы не считаются дважды');
SELECT is(
  (SELECT merged_into FROM guests WHERE id = 'e2000000-0000-4000-8000-000000000002'),
  'e2000000-0000-4000-8000-000000000001',
  'исходный остаётся указателем, а не удаляется');
SET LOCAL ROLE authenticated;

SELECT ok(
  (SELECT 'e4000000-0000-4000-8000-000000000001' = ANY(orders) FROM guest_merges
   WHERE source_id = 'e2000000-0000-4000-8000-000000000002'),
  'журнал слияния помнит КАКИЕ заказы переехали, а не только сколько');
SELECT is(
  (SELECT (balances ->> 'total_spent')::INTEGER FROM guest_merges
   WHERE source_id = 'e2000000-0000-4000-8000-000000000002'),
  4000, 'балансы исходного сняты до переноса');
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guest_audit WHERE field = 'merge'),
  2, 'слияние записано в аудит обоих профилей');

SELECT is(jsonb_array_length(get_backoffice_guests()), 3,
  'объединённый профиль ушёл из списка');

SELECT throws_ok($$
  SELECT merge_guests_web('e2000000-0000-4000-8000-000000000001',
                          'e2000000-0000-4000-8000-000000000002')
$$, 'guest_merged', 'повторное слияние того же профиля отклонено');
SELECT throws_ok($$
  SELECT merge_guests_web('e2000000-0000-4000-8000-000000000001',
                          'e2000000-0000-4000-8000-000000000001')
$$, 'same_guest', 'профиль не сливается сам с собой');
SELECT throws_ok($$
  SELECT merge_guests_web('e2000000-0000-4000-8000-000000000001',
                          'e2000000-0000-4000-8000-0000000000ff')
$$, 'guest not found', 'чужого гостя не присоединить');

-- Старый номер продолжает узнавать человека: иначе слияние жило бы
-- до первого нового заказа.
RESET ROLE;
INSERT INTO reservations (org_id, location_id, client_uuid, customer_name,
                          customer_phone, party_size, reserved_at, duration_min, status)
VALUES ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
        'e7000000-0000-4000-8000-000000000009', 'Дана', '972501234567', 2,
        NOW() + INTERVAL '2 days', 90, 'confirmed');
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT guest_id FROM reservations WHERE client_uuid = 'e7000000-0000-4000-8000-000000000009'),
  'e2000000-0000-4000-8000-000000000001',
  'бронь по СТАРОМУ номеру попала в объединённый профиль');
SELECT is(
  guest_history('972501234567')::jsonb ->> 'guest_id',
  'e2000000-0000-4000-8000-000000000001',
  'хостес по старому номеру видит историю объединённого профиля');

-- ── 5. Удаление личных данных ────────────────────────────────
SELECT throws_ok($$
  SELECT anonymize_guest_web('e2000000-0000-4000-8000-000000000003', '0000000000')
$$, 'confirm_mismatch', 'промах строкой в списке не стирает чужого человека');

SELECT throws_ok($$
  SELECT anonymize_guest_web('e2000000-0000-4000-8000-000000000001', '0501234567')
$$, 'has_upcoming_reservation',
  'гость с будущим визитом не стирается — хостес осталась бы без контактов');

SELECT is(
  anonymize_guest_web('e2000000-0000-4000-8000-000000000003', '052-111-2222')
    ->> 'reservations',
  '1', 'стирание обезличивает прошлые визиты');

-- Стёртый профиль клиенту тоже не виден (132): это тот же случай, что и
-- объединённый — старая сборка кассы не должна показывать его никогда.
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guests),
  2, 'касса не видит стёртый профиль даже прямым запросом к таблице');

RESET ROLE;
SELECT results_eq($$
  SELECT name, notes, cardinality(tags), anonymized_at IS NOT NULL
  FROM guests WHERE id = 'e2000000-0000-4000-8000-000000000003'
$$, $$ VALUES (NULL::TEXT, NULL::TEXT, 0, TRUE) $$,
  'имя, заметка и метки стёрты');
SELECT ok(
  (SELECT phone LIKE 'deleted:%' FROM guests WHERE id = 'e2000000-0000-4000-8000-000000000003'),
  'телефон заменён на заведомо не-номер');
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT customer_phone FROM reservations WHERE id = 'e6000000-0000-4000-8000-000000000003'),
  '', 'контакт в прошлой брони стёрт');
SELECT is(
  (SELECT note FROM reservations WHERE id = 'e6000000-0000-4000-8000-000000000003'),
  NULL, 'заметка о госте в брони стёрта');

-- Заказ — документ учёта: он остаётся целиком (docs/israel-compliance.md)
SELECT results_eq($$
  SELECT total, guest_id FROM orders WHERE id = 'e4000000-0000-4000-8000-000000000003'
$$, $$ VALUES (5000, 'e2000000-0000-4000-8000-000000000003'::UUID) $$,
  'заказ и его связь с профилем не тронуты — это документ учёта');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guest_audit
   WHERE guest_id = 'e2000000-0000-4000-8000-000000000003'
     AND (old_value IS NOT NULL OR new_value IS NOT NULL)),
  0, 'аудит правок не хранит стёртых значений — иначе имя осталось бы в базе');
SELECT is(
  (SELECT COUNT(*)::INTEGER FROM guest_audit
   WHERE guest_id = 'e2000000-0000-4000-8000-000000000003' AND field = 'anonymize'),
  1, 'сам факт стирания записан');

SELECT is(jsonb_array_length(get_backoffice_guests()), 2,
  'стёртый профиль ушёл из списка');

SELECT throws_ok($$
  SELECT anonymize_guest_web('e2000000-0000-4000-8000-000000000003', '0521112222')
$$, 'already_anonymized', 'повторное стирание отклонено прямо, а не отказом по номеру');
SELECT throws_ok($$
  SELECT set_guest_profile('e2000000-0000-4000-8000-000000000003', p_name => 'Возврат')
$$, 'guest_anonymized', 'стёртый профиль не редактируется обратно');

-- Освободившийся номер достаётся НОВОМУ человеку, а не стёртому профилю
RESET ROLE;
INSERT INTO reservations (org_id, location_id, client_uuid, customer_name,
                          customer_phone, party_size, reserved_at, duration_min, status)
VALUES ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
        'e7000000-0000-4000-8000-00000000000a', 'Новый Йоси', '0521112222', 2,
        NOW() + INTERVAL '5 days', 90, 'new');

SELECT isnt(
  (SELECT guest_id FROM reservations WHERE client_uuid = 'e7000000-0000-4000-8000-00000000000a'),
  'e2000000-0000-4000-8000-000000000003',
  'новый гость с тем же номером получает новый профиль, а не стёртый');

SELECT * FROM finish();
ROLLBACK;
