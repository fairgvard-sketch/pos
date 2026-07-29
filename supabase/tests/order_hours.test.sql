-- pgTAP: часы работы как окно приёма онлайн-заказов (112) и предзаказ
-- вне этих часов (116).
--
-- Проверяется, что расписание online_orders.hours ограничивает не только
-- «принимаем ли сейчас», но и выбранное гостем время pickup_at, причём
-- для ВСЕХ точек, включая POS с открытой сменой. Отдельно проверяется
-- разделение 116: заказ «на сейчас» требует открытых часов в этот момент,
-- предзаказ — только попадания pickup_at внутрь будущего окна.
--
-- Окна строятся динамически от текущего момента: прогон в любое время
-- суток (в т.ч. через полночь) должен быть стабильным.

BEGIN;
SELECT plan(18);

-- ── Хелперы окон ─────────────────────────────────────────────
-- Расписание «открыто от -N до +M часов относительно сейчас» для
-- сегодняшнего дня недели точки.
CREATE FUNCTION pg_temp.hours_around(p_back INTERVAL, p_fwd INTERVAL)
RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object('online_orders', jsonb_build_object('hours',
    jsonb_build_object(
      EXTRACT(DOW FROM NOW() AT TIME ZONE 'Asia/Jerusalem')::INT::TEXT,
      jsonb_build_array(jsonb_build_array(
        to_char(NOW() AT TIME ZONE 'Asia/Jerusalem' - p_back, 'HH24:MI'),
        to_char(NOW() AT TIME ZONE 'Asia/Jerusalem' + p_fwd, 'HH24:MI')
      ))
    )
  ))
$$;

-- ── online_hours_open_at: ядро ───────────────────────────────
SELECT ok(
  online_hours_open_at('{}'::jsonb, 'Asia/Jerusalem', NOW()),
  'расписание не настроено — открыто в любой момент'
);
SELECT ok(
  NOT online_hours_open_at('{"online_orders":{"hours":{}}}'::jsonb, 'Asia/Jerusalem', NOW()),
  'день не описан — закрыто'
);
-- Выключение расписания из бэкофиса шлёт hours: null. patch_location_settings_web
-- мержит через ||, поэтому ключ остаётся со значением JSON null — это должно
-- читаться как «ограничений нет», иначе точка молча закрылась бы навсегда.
SELECT ok(
  online_hours_open_at('{"online_orders":{"hours":null}}'::jsonb, 'Asia/Jerusalem', NOW()),
  'hours: null (снятое расписание) — приём в любое время'
);
SELECT ok(
  online_hours_open_at(
    pg_temp.hours_around(INTERVAL '1 hour', INTERVAL '1 hour'),
    'Asia/Jerusalem', NOW()
  ),
  'момент внутри окна — открыто'
);
-- Окно [-3ч, -2ч]: «сейчас» уже за его правой границей.
SELECT ok(
  NOT online_hours_open_at(
    pg_temp.hours_around(INTERVAL '3 hours', INTERVAL '-2 hours'),
    'Asia/Jerusalem', NOW()
  ),
  'момент после закрытия — закрыто'
);
-- Явное окно через полночь: 20:00–02:00, проверяем обе дуги.
SELECT ok(
  online_hours_open_at(
    '{"online_orders":{"hours":{"0":[["20:00","02:00"]],"1":[["20:00","02:00"]],"2":[["20:00","02:00"]],"3":[["20:00","02:00"]],"4":[["20:00","02:00"]],"5":[["20:00","02:00"]],"6":[["20:00","02:00"]]}}}'::jsonb,
    'Asia/Jerusalem',
    (DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Jerusalem') + INTERVAL '23 hours')
      AT TIME ZONE 'Asia/Jerusalem'
  ),
  'окно через полночь: 23:00 — открыто (дуга до полуночи)'
);
SELECT ok(
  online_hours_open_at(
    '{"online_orders":{"hours":{"0":[["20:00","02:00"]],"1":[["20:00","02:00"]],"2":[["20:00","02:00"]],"3":[["20:00","02:00"]],"4":[["20:00","02:00"]],"5":[["20:00","02:00"]],"6":[["20:00","02:00"]]}}}'::jsonb,
    'Asia/Jerusalem',
    (DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Jerusalem') + INTERVAL '1 hour')
      AT TIME ZONE 'Asia/Jerusalem'
  ),
  'окно через полночь: 01:00 — открыто (дуга после полуночи)'
);
SELECT ok(
  NOT online_hours_open_at(
    '{"online_orders":{"hours":{"0":[["20:00","02:00"]],"1":[["20:00","02:00"]],"2":[["20:00","02:00"]],"3":[["20:00","02:00"]],"4":[["20:00","02:00"]],"5":[["20:00","02:00"]],"6":[["20:00","02:00"]]}}}'::jsonb,
    'Asia/Jerusalem',
    (DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Jerusalem') + INTERVAL '10 hours')
      AT TIME ZONE 'Asia/Jerusalem'
  ),
  'окно через полночь: 10:00 — закрыто'
);

-- online_hours_open (обёртка) не изменила поведение
SELECT is(
  online_hours_open(pg_temp.hours_around(INTERVAL '1 hour', INTERVAL '1 hour'), 'Asia/Jerusalem'),
  online_hours_open_at(pg_temp.hours_around(INTERVAL '1 hour', INTERVAL '1 hour'), 'Asia/Jerusalem', NOW()),
  'online_hours_open — обёртка над ядром с NOW()'
);

-- ── Фикстура: POS-организация с открытой сменой ──────────────
-- Часы проверяются и для POS: смена сама по себе не открывает приём.
INSERT INTO orgs (id, name) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'pgTAP hours POS');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'Hours loc', 'Asia/Jerusalem');

INSERT INTO organization_products (org_id, product) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'menu'),
  ('c0000000-0000-4000-8000-000000000001', 'online_orders'),
  ('c0000000-0000-4000-8000-000000000001', 'pos');

INSERT INTO menu_categories (id, org_id, location_id, name, is_active) VALUES
  ('c3000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001', 'Кофе', TRUE);
INSERT INTO menu_items (id, org_id, category_id, name, price, is_available) VALUES
  ('c3000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-000000000001',
   'c3000000-0000-4000-8000-000000000001', 'Латте', 1000, TRUE);

-- Смена открыта: гейт кассы пройден, дальше решают только часы.
INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('c2000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001', 'Бариста', 'barista', 'x');

INSERT INTO shifts (id, org_id, location_id, opened_by, status, opening_float) VALUES
  ('c7000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   'open', 0);

-- Точка открыта «сейчас» (окно ±1 час), заказ на ближайшее время.
UPDATE locations
SET settings = pg_temp.hours_around(INTERVAL '1 hour', INTERVAL '1 hour')
WHERE id = 'c1000000-0000-4000-8000-000000000001';

SELECT lives_ok($$
  SELECT submit_online_order(
    'c1000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000001',
    'Гость', '0501234567',
    '[{"menu_item_id":"c3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb,
    NOW() + INTERVAL '30 minutes'
  )
$$, 'POS: заявка на время внутри часов проходит');

-- Время вне часов работы — заявка отклонена, несмотря на открытую смену.
SELECT throws_ok($$
  SELECT submit_online_order(
    'c1000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000002',
    'Гость', '0501234567',
    '[{"menu_item_id":"c3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb,
    NOW() + INTERVAL '90 minutes'
  )
$$, 'pickup_outside_hours', 'POS: заявка на время вне часов отклонена');

-- Точка закрыта прямо сейчас — приём не идёт даже с открытой сменой.
UPDATE locations
SET settings = pg_temp.hours_around(INTERVAL '3 hours', INTERVAL '-2 hours')
WHERE id = 'c1000000-0000-4000-8000-000000000001';

SELECT throws_ok($$
  SELECT submit_online_order(
    'c1000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000003',
    'Гость', '0501234567',
    '[{"menu_item_id":"c3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb
  )
$$, 'closed', 'POS: вне часов работы приём закрыт, открытая смена не спасает');

-- ── Предзаказ вне часов работы (116) ─────────────────────────
-- Точка закрыта СЕЙЧАС (окно [-3ч, -2ч]), но завтра открыта круглые сутки:
-- заявка «ко времени» внутрь завтрашнего окна должна приниматься. До 116
-- сюда прилетало 'closed' ещё до проверки pickup_at, и заведение переставало
-- принимать предзаказы на следующий день, едва закрывшись.
UPDATE locations
SET settings = jsonb_build_object('online_orders', jsonb_build_object('hours',
  jsonb_build_object(
    -- сегодня: окно уже закрылось
    EXTRACT(DOW FROM NOW() AT TIME ZONE 'Asia/Jerusalem')::INT::TEXT,
    jsonb_build_array(jsonb_build_array(
      to_char(NOW() AT TIME ZONE 'Asia/Jerusalem' - INTERVAL '3 hours', 'HH24:MI'),
      to_char(NOW() AT TIME ZONE 'Asia/Jerusalem' - INTERVAL '2 hours', 'HH24:MI')
    )),
    -- завтра: открыто весь день
    EXTRACT(DOW FROM (NOW() + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem')::INT::TEXT,
    jsonb_build_array(jsonb_build_array('00:00', '23:59'))
  )
))
WHERE id = 'c1000000-0000-4000-8000-000000000001';

SELECT lives_ok($$
  SELECT submit_online_order(
    'c1000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000005',
    'Гость', '0501234567',
    '[{"menu_item_id":"c3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb,
    NOW() + INTERVAL '20 hours'
  )
$$, 'закрыто сейчас — предзаказ на завтрашнее окно принимается (116)');

-- Заказ «на сейчас» (pickup_at IS NULL) при этом по-прежнему отклоняется:
-- готовить некому, предзаказ не должен открывать эту дверь.
SELECT throws_ok($$
  SELECT submit_online_order(
    'c1000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000006',
    'Гость', '0501234567',
    '[{"menu_item_id":"c3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb
  )
$$, 'closed', 'закрыто сейчас — заказ «как можно скорее» по-прежнему отклонён');

-- Прошедшее время нормализуется в «сейчас» ДО гейта: иначе pickup_at на
-- минуту назад считался бы предзаказом и обходил проверку «открыто сейчас».
SELECT throws_ok($$
  SELECT submit_online_order(
    'c1000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000007',
    'Гость', '0501234567',
    '[{"menu_item_id":"c3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb,
    NOW() - INTERVAL '1 minute'
  )
$$, 'closed', 'прошедшее pickup_at = «сейчас», а не предзаказ');

-- Предзаказ на момент, когда точка тоже закрыта, остаётся запрещён.
SELECT throws_ok($$
  SELECT submit_online_order(
    'c1000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000008',
    'Гость', '0501234567',
    '[{"menu_item_id":"c3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb,
    NOW() + INTERVAL '30 minutes'
  )
$$, 'pickup_outside_hours', 'предзаказ на закрытый момент отклонён');

-- Пауза с кассы (054) сильнее предзаказа: это ручное «мы не принимаем».
UPDATE locations
SET settings = settings || jsonb_build_object('online_orders',
  (settings -> 'online_orders') || jsonb_build_object(
    'paused_until', to_char(NOW() + INTERVAL '1 hour', 'YYYY-MM-DD"T"HH24:MI:SSOF')
  ))
WHERE id = 'c1000000-0000-4000-8000-000000000001';

SELECT throws_ok($$
  SELECT submit_online_order(
    'c1000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000009',
    'Гость', '0501234567',
    '[{"menu_item_id":"c3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb,
    NOW() + INTERVAL '20 hours'
  )
$$, 'paused', 'пауза с кассы запрещает и предзаказ');

-- Расписание не задано — поведение как раньше (приём в любое время).
UPDATE locations
SET settings = '{}'::jsonb
WHERE id = 'c1000000-0000-4000-8000-000000000001';

SELECT lives_ok($$
  SELECT submit_online_order(
    'c1000000-0000-4000-8000-000000000001',
    'c6000000-0000-4000-8000-000000000004',
    'Гость', '0501234567',
    '[{"menu_item_id":"c3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb,
    NOW() + INTERVAL '90 minutes'
  )
$$, 'без расписания заказ на любое время проходит (обратная совместимость)');

SELECT * FROM finish();
ROLLBACK;
