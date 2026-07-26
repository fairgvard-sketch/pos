-- pgTAP: standalone онлайн-заказы без POS (101).
--
-- Проверяется отделение «точка принимает заказы» от «открыта смена»:
-- режим обслуживания, недельное расписание, submit без смены для
-- standalone-организации и веб-переводы статусов (только owner/manager,
-- только standalone, чужой tenant и POS-контур неприкасаемы).
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(16);

-- ── Фикстура: org A digital-only (menu+online_orders), org B — POS ──
INSERT INTO orgs (id, name) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'pgTAP standalone A'),
  ('a0000000-0000-4000-8000-000000000002', 'pgTAP pos B');

INSERT INTO locations (id, org_id, name) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Digital loc'),
  ('a1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'POS loc');

INSERT INTO organization_products (org_id, product) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'menu'),
  ('a0000000-0000-4000-8000-000000000001', 'online_orders'),
  ('a0000000-0000-4000-8000-000000000002', 'menu'),
  ('a0000000-0000-4000-8000-000000000002', 'online_orders'),
  ('a0000000-0000-4000-8000-000000000002', 'pos');

INSERT INTO auth.users (id) VALUES
  ('a4000000-0000-4000-8000-000000000001'),  -- веб-владелец org A
  ('a4000000-0000-4000-8000-000000000002');  -- веб-владелец org B

INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('a5000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'owner', TRUE),
  ('a5000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-000000000002', 'owner', TRUE);

-- Каталог org A: категория точки + доступный товар без вариантов
INSERT INTO menu_categories (id, org_id, location_id, name, is_active) VALUES
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001', 'Кофе', TRUE);
INSERT INTO menu_items (id, org_id, category_id, name, price, is_available) VALUES
  ('a3000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'Латте', 1400, TRUE);

-- Каталог org B (для проверки гейта смены)
INSERT INTO menu_categories (id, org_id, location_id, name, is_active) VALUES
  ('a3000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002',
   'a1000000-0000-4000-8000-000000000002', 'Кофе B', TRUE);
INSERT INTO menu_items (id, org_id, category_id, name, price, is_available) VALUES
  ('a3000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000002',
   'a3000000-0000-4000-8000-000000000002', 'Эспрессо', 800, TRUE);

-- ── Режим обслуживания ───────────────────────────────────────
SELECT is(
  online_fulfilment_mode('a0000000-0000-4000-8000-000000000001', '{}'::jsonb),
  'standalone',
  'без модуля pos дефолт — standalone'
);
SELECT is(
  online_fulfilment_mode('a0000000-0000-4000-8000-000000000002', '{}'::jsonb),
  'pos',
  'с модулем pos дефолт — pos'
);
SELECT is(
  online_fulfilment_mode(
    'a0000000-0000-4000-8000-000000000002',
    '{"online_orders":{"fulfilment":"standalone"}}'::jsonb
  ),
  'standalone',
  'явная настройка fulfilment сильнее дефолта по модулю'
);

-- ── Недельное расписание ─────────────────────────────────────
SELECT ok(
  online_hours_open('{}'::jsonb, 'Asia/Jerusalem'),
  'расписание не настроено — приём в любое время'
);
SELECT ok(
  NOT online_hours_open('{"online_orders":{"hours":{}}}'::jsonb, 'Asia/Jerusalem'),
  'день не описан в hours — закрыто'
);
-- Окно вокруг текущего момента строится динамически: при переходе через
-- полночь получается overnight-дуга — обе ветки проверяются одним тестом.
SELECT ok(
  online_hours_open(
    jsonb_build_object('online_orders', jsonb_build_object('hours',
      jsonb_build_object(
        EXTRACT(DOW FROM NOW() AT TIME ZONE 'Asia/Jerusalem')::INT::TEXT,
        jsonb_build_array(jsonb_build_array(
          to_char(NOW() AT TIME ZONE 'Asia/Jerusalem' - INTERVAL '1 hour', 'HH24:MI'),
          to_char(NOW() AT TIME ZONE 'Asia/Jerusalem' + INTERVAL '1 hour', 'HH24:MI')
        ))
      )
    )),
    'Asia/Jerusalem'
  ),
  'окно вокруг текущего времени — открыто (в т.ч. через полночь)'
);

-- ── Submit: standalone без смены проходит, POS — нет ─────────
CREATE TEMP TABLE standalone_submit AS
SELECT submit_online_order(
  'a1000000-0000-4000-8000-000000000001',
  'a6000000-0000-4000-8000-000000000001',
  'Гость', '0501234567',
  '[{"menu_item_id":"a3000000-0000-4000-8000-000000000011","qty":2}]'::jsonb
) AS res;

SELECT is(
  (SELECT (res ->> 'total')::INT FROM standalone_submit),
  2800,
  'standalone: заявка без смены создана, сумма из каталога'
);
SELECT is(
  (SELECT status FROM online_orders WHERE client_uuid = 'a6000000-0000-4000-8000-000000000001'),
  'new',
  'standalone: заявка в статусе new'
);

SELECT throws_ok(
  $$SELECT submit_online_order(
    'a1000000-0000-4000-8000-000000000002',
    'a6000000-0000-4000-8000-000000000002',
    'Гость', '0501234568',
    '[{"menu_item_id":"a3000000-0000-4000-8000-000000000012","qty":1}]'::jsonb
  )$$,
  'closed',
  'pos-режим: без открытой смены заявка отклоняется как раньше'
);

-- ── Веб-переводы статусов ────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"a0000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT is(
  (SELECT set_online_order_status_web(
    'a1000000-0000-4000-8000-000000000001',
    (SELECT id FROM online_orders WHERE client_uuid = 'a6000000-0000-4000-8000-000000000001'),
    'accepted'
  ) ->> 'status'),
  'accepted',
  'владелец принимает заявку из веб-кабинета без PIN'
);
SELECT is(
  (SELECT decided_by_member FROM online_orders
   WHERE client_uuid = 'a6000000-0000-4000-8000-000000000001'),
  'a5000000-0000-4000-8000-000000000001'::uuid,
  'решение атрибутировано члену организации'
);

-- Ретрай той же кнопки — no-op, не ошибка
SELECT is(
  (SELECT set_online_order_status_web(
    'a1000000-0000-4000-8000-000000000001',
    (SELECT id FROM online_orders WHERE client_uuid = 'a6000000-0000-4000-8000-000000000001'),
    'accepted'
  ) ->> 'duplicate'),
  'true',
  'повтор того же статуса — duplicate, не ошибка'
);

SELECT throws_ok(
  $$SELECT set_online_order_status_web(
    'a1000000-0000-4000-8000-000000000001',
    (SELECT id FROM online_orders WHERE client_uuid = 'a6000000-0000-4000-8000-000000000001'),
    'rejected'
  )$$,
  'invalid_transition',
  'rejected возможен только из new'
);

SELECT is(
  (SELECT set_online_order_status_web(
    'a1000000-0000-4000-8000-000000000001',
    (SELECT id FROM online_orders WHERE client_uuid = 'a6000000-0000-4000-8000-000000000001'),
    'ready'
  ) ->> 'status'),
  'ready',
  'accepted → ready (preparing можно пропустить)'
);

-- ── Чужой tenant и POS-контур ────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"a0000000-0000-4000-8000-000000000002"}}',
  true
);

SELECT throws_ok(
  $$SELECT set_online_order_status_web(
    'a1000000-0000-4000-8000-000000000001',
    (SELECT id FROM online_orders WHERE client_uuid = 'a6000000-0000-4000-8000-000000000001'),
    'completed'
  )$$,
  'location not in organization',
  'чужая точка отклоняется до чтения заявки'
);

SELECT throws_ok(
  $$SELECT set_online_order_status_web(
    'a1000000-0000-4000-8000-000000000002',
    'a6000000-0000-4000-8000-000000000099',
    'accepted'
  )$$,
  'pos_mode',
  'pos-режим точки: жизненный цикл остаётся на кассе'
);

SELECT * FROM finish();
ROLLBACK;
