-- pgTAP: веб-стол хостес для броней без POS (102).
--
-- Переводы статусов из кабинета: членство owner/manager, модуль
-- reservations, чужой tenant и посаженные на кассе брони (order_id)
-- неприкасаемы; терминальные completed/no_show доступны из confirmed.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(10);

-- ── Фикстура: org A с reservations, org B без модуля ─────────
INSERT INTO orgs (id, name) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'pgTAP resv A'),
  ('b0000000-0000-4000-8000-000000000002', 'pgTAP resv B');

INSERT INTO locations (id, org_id, name) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Resv loc A'),
  ('b1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'Resv loc B');

INSERT INTO organization_products (org_id, product) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'reservations'),
  ('b0000000-0000-4000-8000-000000000002', 'menu');

INSERT INTO auth.users (id) VALUES
  ('b4000000-0000-4000-8000-000000000001'),
  ('b4000000-0000-4000-8000-000000000002');

INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('b5000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'owner', TRUE),
  ('b5000000-0000-4000-8000-000000000002',
   'b0000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000002', 'owner', TRUE);

INSERT INTO reservations (id, org_id, location_id, client_uuid,
                          customer_name, customer_phone, party_size, reserved_at) VALUES
  ('b6000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
   'b7000000-0000-4000-8000-000000000001', 'Гость', '0501112233', 2,
   NOW() + INTERVAL '2 hours'),
  ('b6000000-0000-4000-8000-000000000002',
   'b0000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002',
   'b7000000-0000-4000-8000-000000000002', 'Гость B', '0502223344', 2,
   NOW() + INTERVAL '2 hours');

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"b0000000-0000-4000-8000-000000000001"}}',
  true
);

-- ── Жизненный цикл из кабинета ───────────────────────────────
SELECT is(
  (SELECT set_reservation_status_web(
    'b1000000-0000-4000-8000-000000000001',
    'b6000000-0000-4000-8000-000000000001',
    'confirmed'
  ) ->> 'status'),
  'confirmed',
  'владелец подтверждает бронь из веба без PIN'
);
SELECT is(
  (SELECT decided_by_member FROM reservations
   WHERE id = 'b6000000-0000-4000-8000-000000000001'),
  'b5000000-0000-4000-8000-000000000001'::uuid,
  'решение атрибутировано члену организации'
);
SELECT is(
  (SELECT set_reservation_status_web(
    'b1000000-0000-4000-8000-000000000001',
    'b6000000-0000-4000-8000-000000000001',
    'confirmed'
  ) ->> 'duplicate'),
  'true',
  'повтор того же статуса — duplicate, не ошибка'
);
SELECT throws_ok(
  $$SELECT set_reservation_status_web(
    'b1000000-0000-4000-8000-000000000001',
    'b6000000-0000-4000-8000-000000000001',
    'rejected'
  )$$,
  'invalid_transition',
  'rejected возможен только из new'
);
SELECT is(
  (SELECT set_reservation_status_web(
    'b1000000-0000-4000-8000-000000000001',
    'b6000000-0000-4000-8000-000000000001',
    'no_show'
  ) ->> 'status'),
  'no_show',
  'confirmed → no_show: терминальный статус освобождает окно'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM reservations
    WHERE id = 'b6000000-0000-4000-8000-000000000001'
      AND status IN ('new', 'confirmed')
  ),
  'терминальная бронь вне предикатов занятости движка'
);
SELECT throws_ok(
  $$SELECT set_reservation_status_web(
    'b1000000-0000-4000-8000-000000000001',
    'b6000000-0000-4000-8000-000000000001',
    'completed'
  )$$,
  'invalid_transition',
  'терминальный статус не переигрывается'
);

-- ── Чужой tenant ─────────────────────────────────────────────
SELECT throws_ok(
  $$SELECT set_reservation_status_web(
    'b1000000-0000-4000-8000-000000000002',
    'b6000000-0000-4000-8000-000000000002',
    'confirmed'
  )$$,
  'location not in organization',
  'чужая точка отклоняется до чтения брони'
);

-- ── Организация без модуля reservations ──────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b4000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"b0000000-0000-4000-8000-000000000002"}}',
  true
);
SELECT throws_ok(
  $$SELECT set_reservation_status_web(
    'b1000000-0000-4000-8000-000000000002',
    'b6000000-0000-4000-8000-000000000002',
    'confirmed'
  )$$,
  'module_disabled',
  'без модуля reservations веб-стол не работает'
);

-- ── Посаженная на кассе бронь неприкасаема ───────────────────
RESET ROLE;
-- RESET ROLE снимает роль, но НЕ токен: set_config(..., true) живёт до
-- конца транзакции, и здесь в нём остаётся org B из блока выше. Правка
-- ниже трогает брони org A, то есть суперюзерная фикстура шла бы с
-- чужим токеном — состояние, которого в проде не бывает (RLS и все RPC
-- пишут бронь только с org_id = auth_org_id()). Чистим явно: настройка
-- фикстуры — не запрос от арендатора, и триггер уведомлений (147)
-- должен видеть доверенный серверный контекст, а не чужую организацию.
SELECT set_config('request.jwt.claims', '{}', true);
UPDATE reservations
SET order_id = NULL, status = 'new'
WHERE id = 'b6000000-0000-4000-8000-000000000002';
-- имитируем посадку: нужен настоящий заказ для FK (и staff для смены)
INSERT INTO staff (id, org_id, name, pin_hash, role, is_active)
VALUES ('ba000000-0000-4000-8000-000000000001',
        'b0000000-0000-4000-8000-000000000001', 'pgTAP staff', 'x', 'owner', TRUE);
INSERT INTO shifts (id, org_id, location_id, opened_by, opening_float)
VALUES ('b8000000-0000-4000-8000-000000000001',
        'b0000000-0000-4000-8000-000000000001',
        'b1000000-0000-4000-8000-000000000001',
        'ba000000-0000-4000-8000-000000000001', 0);
INSERT INTO orders (id, org_id, location_id, shift_id, staff_id, client_uuid,
                    daily_number, vat_rate, status, subtotal, total)
VALUES ('b9000000-0000-4000-8000-000000000001',
        'b0000000-0000-4000-8000-000000000001',
        'b1000000-0000-4000-8000-000000000001',
        'b8000000-0000-4000-8000-000000000001',
        'ba000000-0000-4000-8000-000000000001',
        'bb000000-0000-4000-8000-000000000001', 1, 18.00, 'open', 0, 0);
UPDATE reservations
SET order_id = 'b9000000-0000-4000-8000-000000000001', status = 'confirmed'
WHERE id = 'b6000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"b0000000-0000-4000-8000-000000000001"}}',
  true
);
SELECT throws_ok(
  $$SELECT set_reservation_status_web(
    'b1000000-0000-4000-8000-000000000001',
    'b6000000-0000-4000-8000-000000000001',
    'completed'
  )$$,
  'pos_mode',
  'бронь, посаженная в POS-заказ, ведётся на кассе'
);

SELECT * FROM finish();
ROLLBACK;
