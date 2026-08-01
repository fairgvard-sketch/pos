-- pgTAP: воронка гостевой брони и атрибуция канала (124).
--
-- Главное, что проверяется: трекинг не умеет ронять бронирование. Битый
-- шаг, чужая точка, выключенный продукт, лимит — всё это ноль, а не
-- исключение. Плюс дедупликация шагов и нормализация канала.

BEGIN;
SELECT plan(18);

-- ── Фикстура: org A с Reserve, org B без него ────────────────
INSERT INTO orgs (id, name) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'pgTAP funnel A'),
  ('d0000000-0000-4000-8000-000000000002', 'pgTAP funnel B');

INSERT INTO locations (id, org_id, name) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Funnel loc A'),
  ('d1000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'Funnel loc B');

INSERT INTO organization_products (org_id, product) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'reservations'),
  ('d0000000-0000-4000-8000-000000000002', 'menu');

-- ── Нормализация канала ──────────────────────────────────────
SELECT is(normalize_reserve_source('qr', '{}'::jsonb), 'qr',
  'явный src становится каналом как есть');
SELECT is(normalize_reserve_source(NULL, '{"source":"IG"}'::jsonb), 'instagram',
  'синонимы площадки сводятся к одному имени');
SELECT is(normalize_reserve_source('qr', '{"source":"instagram"}'::jsonb), 'qr',
  'наш src сильнее utm_source площадки');
SELECT is(normalize_reserve_source(NULL, '{}'::jsonb), 'direct',
  'без меток канал — direct, а не NULL');
SELECT is(normalize_reserve_source('<script>', '{}'::jsonb), 'script',
  'мусор из адреса чистится до [a-z0-9_-]');

-- ── Шаги воронки ─────────────────────────────────────────────
SELECT is(
  track_reserve_event('d1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001', 'page_view', 'qr'),
  1, 'шаг записан');
SELECT is(
  track_reserve_event('d1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001', 'page_view', 'qr'),
  0, 'повтор того же шага сессии дубля не создаёт');

-- Спрос по датам: одна строка на пару «дата + компания», а не одна на
-- сессию и не одна на каждый тап.
SELECT is(
  track_reserve_event('d1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001', 'no_slots', 'qr', '{}'::jsonb,
    2, CURRENT_DATE + 1),
  1, 'неудовлетворённый спрос на дату записан');
SELECT is(
  track_reserve_event('d1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001', 'no_slots', 'qr', '{}'::jsonb,
    2, CURRENT_DATE + 2),
  1, 'другая дата — отдельная строка спроса');
SELECT is(
  track_reserve_event('d1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001', 'no_slots', 'qr', '{}'::jsonb,
    2, CURRENT_DATE + 2),
  0, 'та же дата и компания второй раз не пишутся');

-- ── Отказы: ноль, но не исключение ───────────────────────────
SELECT is(
  track_reserve_event('d1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000002', 'нашествие', 'qr'),
  0, 'неизвестный шаг отбрасывается молча');
SELECT is(
  track_reserve_event('d1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000003', 'page_view', 'qr'),
  0, 'без продукта reservations телеметрия не собирается');
SELECT is(
  track_reserve_event('d1000000-0000-4000-8000-000000000009',
    'd2000000-0000-4000-8000-000000000004', 'page_view', 'qr'),
  0, 'несуществующая точка — ноль');
SELECT is(
  track_reserve_event(NULL, NULL, 'page_view'),
  0, 'пустые обязательные параметры — ноль');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM reservation_funnel_events
   WHERE location_id = 'd1000000-0000-4000-8000-000000000002'),
  0, 'ни одна отклонённая попытка не оставила строки');

-- ── Атрибуция брони ──────────────────────────────────────────
INSERT INTO reservations (id, org_id, location_id, client_uuid, customer_name,
                          customer_phone, party_size, reserved_at, status)
VALUES ('d3000000-0000-4000-8000-000000000001',
        'd0000000-0000-4000-8000-000000000001',
        'd1000000-0000-4000-8000-000000000001',
        'd4000000-0000-4000-8000-000000000001', 'Гость', '0501112233', 2,
        NOW() + INTERVAL '3 hours', 'confirmed');

SELECT is(
  track_reserve_event('d1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001', 'submitted', NULL,
    '{"source":"instagram","campaign":"summer"}'::jsonb,
    2, CURRENT_DATE + 1, TIME '19:00', NULL,
    'd3000000-0000-4000-8000-000000000001'),
  1, 'отправка заявки записана');
SELECT is(
  (SELECT source FROM reservations WHERE id = 'd3000000-0000-4000-8000-000000000001'),
  'instagram',
  'канал привода проставлен на самой броне — отчёт не зависит от событий');
SELECT is(
  (SELECT utm ->> 'campaign' FROM reservations
   WHERE id = 'd3000000-0000-4000-8000-000000000001'),
  'summer',
  'исходные метки сохранены целиком, а не только нормализованный канал');

SELECT * FROM finish();
ROLLBACK;
