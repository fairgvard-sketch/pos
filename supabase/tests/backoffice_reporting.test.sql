-- pgTAP: отчётность кабинета — охват, разрезы и журнал событий (133).
--
-- Два обещания, которые проверяются здесь:
--
--   * число можно проверить: отчёт называет свой охват (период, зона,
--     точки, валюта), а разрезы сводятся с итогом;
--   * журнал фильтрует СЕРВЕР: раньше кабинет отбирал по типу уже
--     загруженную страницу и отвечал на вопрос «что было среди последних
--     пятидесяти», а не «что было».

BEGIN;
SELECT plan(26);

-- ── Фикстура: организация с двумя точками ────────────────────
INSERT INTO orgs (id, name) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'pgTAP reporting');
INSERT INTO organization_products (org_id, product) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'pos');

INSERT INTO locations (id, org_id, name, timezone, currency) VALUES
  ('b1000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-000000000001', 'Дизенгоф', 'Asia/Jerusalem', 'ILS'),
  ('b1000000-0000-4000-8000-000000000002',
   'b0000000-0000-4000-8000-000000000001', 'Ротшильд', 'Asia/Jerusalem', 'ILS');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'Дана', 'barista', 'x'),
  ('b2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000002', 'Йоси', 'barista', 'x');

-- Устройство — аккаунт Auth (065): по нему событие узнаёт терминал
INSERT INTO auth.users (id) VALUES
  ('b8000000-0000-4000-8000-000000000001'),   -- веб-владелец
  ('b8000000-0000-4000-8000-00000000000d');   -- терминал
INSERT INTO devices (id, org_id, location_id, name, auth_user_id) VALUES
  ('b3000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'Стойка 1', 'b8000000-0000-4000-8000-00000000000d');

INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('b9000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'b8000000-0000-4000-8000-000000000001', 'owner', TRUE);

-- Заказы: две точки, разные каналы и типы. Суммы различимы.
INSERT INTO orders (id, org_id, location_id, staff_id, client_uuid, daily_number,
                    order_type, order_channel, source, status, subtotal, vat_rate,
                    vat_amount, total, paid_at) VALUES
  -- Стойка: канала нет — это и есть касса
  ('b4000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
   'b5000000-0000-4000-8000-000000000001', 1, 'here', NULL, 'pos', 'paid',
   10000, 18, 1525, 10000, NOW() - INTERVAL '2 hours'),
  -- Сайт: канал website, с собой
  ('b4000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
   'b5000000-0000-4000-8000-000000000002', 2, 'takeaway', 'website', 'site', 'paid',
   4000, 18, 610, 4000, NOW() - INTERVAL '1 hour'),
  -- Вторая точка
  ('b4000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002',
   'b5000000-0000-4000-8000-000000000003', 1, 'here', NULL, 'pos', 'paid',
   6000, 18, 915, 6000, NOW() - INTERVAL '30 minutes');

INSERT INTO payments (org_id, order_id, method, amount) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'cash', 10000),
  ('b0000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000002', 'card', 4000),
  ('b0000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000003', 'card', 6000);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b8000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"b0000000-0000-4000-8000-000000000001"}}',
  true
);

CREATE FUNCTION pg_temp.report(p_locs UUID[] DEFAULT NULL)
RETURNS JSONB LANGUAGE sql AS $$
  SELECT sales_report(NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day',
                      'Asia/Jerusalem', NULL, p_locs)
$$;

-- ── 1. Охват назван словами ──────────────────────────────────
SELECT is(
  (pg_temp.report() -> 'scope' ->> 'all_locations')::BOOLEAN,
  TRUE, 'без выбора точек отчёт честно говорит «все точки»');
SELECT is(
  jsonb_array_length(pg_temp.report() -> 'scope' -> 'locations'),
  2, 'охват перечисляет точки поимённо');
SELECT is(
  pg_temp.report() -> 'scope' -> 'currencies' ->> 0,
  'ILS', 'валюта названа — иначе число нечем подписать');
SELECT is(
  pg_temp.report() -> 'scope' ->> 'tz',
  'Asia/Jerusalem', 'зона времени названа: без неё день считается по-разному');

-- ── 2. Числа сводятся ────────────────────────────────────────
SELECT is(
  (pg_temp.report() -> 'summary' ->> 'gross_sales')::BIGINT,
  20000::BIGINT, 'выручка организации — сумма обеих точек');

SELECT is(
  (SELECT SUM((x ->> 'amount')::BIGINT)::BIGINT
   FROM jsonb_array_elements(pg_temp.report() -> 'by_location') x),
  (pg_temp.report() -> 'summary' ->> 'gross_sales')::BIGINT,
  'разрез по точкам сводится с итогом');
SELECT is(
  (SELECT SUM((x ->> 'amount')::BIGINT)::BIGINT
   FROM jsonb_array_elements(pg_temp.report() -> 'by_channel') x),
  (pg_temp.report() -> 'summary' ->> 'gross_sales')::BIGINT,
  'разрез по каналам сводится с итогом');
SELECT is(
  (SELECT SUM((x ->> 'amount')::BIGINT)::BIGINT
   FROM jsonb_array_elements(pg_temp.report() -> 'by_type') x),
  (pg_temp.report() -> 'summary' ->> 'gross_sales')::BIGINT,
  'разрез по типам заказа сводится с итогом');

-- ── 3. Разрезы называют вещи своими именами ──────────────────
SELECT is(
  (SELECT (x ->> 'amount')::BIGINT FROM jsonb_array_elements(pg_temp.report() -> 'by_channel') x
   WHERE x ->> 'channel' = 'pos'),
  16000::BIGINT, 'заказ, пробитый на кассе, попадает в канал «стойка»');
SELECT is(
  (SELECT (x ->> 'amount')::BIGINT FROM jsonb_array_elements(pg_temp.report() -> 'by_channel') x
   WHERE x ->> 'channel' = 'website'),
  4000::BIGINT, 'заказ с сайта попадает в свой канал');
SELECT is(
  (SELECT (x ->> 'count')::INTEGER FROM jsonb_array_elements(pg_temp.report() -> 'by_type') x
   WHERE x ->> 'type' = 'takeaway'),
  1, 'тип заказа виден отдельно');

-- ── 4. Охват по точке ────────────────────────────────────────
SELECT is(
  (pg_temp.report(ARRAY['b1000000-0000-4000-8000-000000000002']::UUID[])
     -> 'summary' ->> 'gross_sales')::BIGINT,
  6000::BIGINT, 'отчёт по одной точке считает только её');
SELECT is(
  (pg_temp.report(ARRAY['b1000000-0000-4000-8000-000000000002']::UUID[])
     -> 'scope' ->> 'all_locations')::BOOLEAN,
  FALSE, 'при выбранной точке охват это признаёт');
-- Платёж своей точки не имеет: если бы охват не шёл через заказ,
-- в отчёт одной точки попали бы деньги другой.
SELECT is(
  (SELECT SUM((x ->> 'amount')::BIGINT)::BIGINT
   FROM jsonb_array_elements(
     pg_temp.report(ARRAY['b1000000-0000-4000-8000-000000000002']::UUID[]) -> 'by_method') x),
  6000::BIGINT, 'способы оплаты скоупятся по точке ЗАКАЗА, а не по всей организации');
SELECT is(
  jsonb_array_length(
    pg_temp.report(ARRAY['b1000000-0000-4000-8000-000000000001']::UUID[]) -> 'by_location'),
  1, 'в отчёте одной точки разрез по точкам содержит одну строку');
SELECT is(
  (pg_temp.report(ARRAY[]::UUID[]) -> 'summary' ->> 'gross_sales')::BIGINT,
  20000::BIGINT, 'пустой список точек означает «все», а не «ни одной»');

-- ── 5. Журнал: событие помнит терминал ───────────────────────
RESET ROLE;
-- Смена открыта НА ТЕРМИНАЛЕ: auth.uid() — аккаунт устройства
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b8000000-0000-4000-8000-00000000000d","role":"authenticated","app_metadata":{"org_id":"b0000000-0000-4000-8000-000000000001","location_id":"b1000000-0000-4000-8000-000000000001"}}',
  true
);
INSERT INTO shifts (id, org_id, location_id, opened_by, opening_float) VALUES
  ('b6000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 20000);

-- Возврат оформлен из кабинета (устройства нет) — и это честный NULL
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b8000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"b0000000-0000-4000-8000-000000000001"}}',
  true
);
INSERT INTO refunds (id, org_id, location_id, order_id, staff_id, amount, method, reason) VALUES
  ('b7000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'b1000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000003',
   'b2000000-0000-4000-8000-000000000002', 6000, 'card', 'Пролили кофе');

SELECT is(
  (SELECT device_id FROM activity_events WHERE type = 'shift_opened'),
  'b3000000-0000-4000-8000-000000000001',
  'событие с терминала помнит терминал');
SELECT is(
  (SELECT device_id FROM activity_events WHERE type = 'refund_issued'),
  NULL, 'событие не с терминала не выдумывает устройство');

SET LOCAL ROLE authenticated;

-- ── 6. Журнал фильтрует сервер ───────────────────────────────
SELECT is(
  jsonb_array_length(get_activity_feed(p_types => ARRAY['refund_issued'])),
  1, 'фильтр по типу отбирает по всему журналу, а не по странице');
SELECT is(
  get_activity_feed(p_types => ARRAY['refund_issued']) -> 0 ->> 'device_name',
  NULL, 'терминал не подставляется там, где его не было');
SELECT is(
  get_activity_feed(p_types => ARRAY['shift_opened']) -> 0 ->> 'device_name',
  'Стойка 1', 'журнал показывает, на каком терминале это произошло');

SELECT is(
  jsonb_array_length(
    get_activity_feed(p_staff_id => 'b2000000-0000-4000-8000-000000000002')),
  1, 'фильтр по сотруднику');
SELECT is(
  jsonb_array_length(
    get_activity_feed(p_device_id => 'b3000000-0000-4000-8000-000000000001')),
  1, 'фильтр по терминалу');
SELECT is(
  jsonb_array_length(get_activity_feed(p_search => 'пролили')),
  1, 'поиск находит по причине возврата, а не только по имени');
SELECT is(
  jsonb_array_length(
    get_activity_feed(p_from => NOW() + INTERVAL '1 hour')),
  0, 'диапазон дат отсекает всё, что вне окна');
SELECT is(
  jsonb_array_length(
    get_activity_feed(p_location_id => 'b1000000-0000-4000-8000-000000000002')),
  1, 'фильтр по точке остался на месте');

SELECT * FROM finish();
ROLLBACK;
