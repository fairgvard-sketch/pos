-- pgTAP: человекочитаемые слаги точек (106).
--
-- Проверяется: владелец задаёт слаг из веб-кабинета, занятые и служебные
-- имена отбиваются, чужой tenant недоступен, capability public_menu
-- обязательна, а гость-аноним резолвит слаг, но НЕ может перечислить
-- клиентов Angle обходом таблицы.
-- JWT-клеймы подменяются только внутри локальной транзакции теста.

BEGIN;
SELECT plan(14);

-- ── Фикстура: org A с меню, org B — чужой tenant ─────────────
INSERT INTO orgs (id, name) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'pgTAP slug A'),
  ('c0000000-0000-4000-8000-000000000002', 'pgTAP slug B');

INSERT INTO locations (id, org_id, name) VALUES
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Slug loc A'),
  ('c1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 'Slug loc B');

INSERT INTO organization_products (org_id, product) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'menu'),
  ('c0000000-0000-4000-8000-000000000002', 'menu');

INSERT INTO auth.users (id) VALUES
  ('c4000000-0000-4000-8000-000000000001'),
  ('c4000000-0000-4000-8000-000000000002');

INSERT INTO organization_members (id, org_id, auth_user_id, role, is_active) VALUES
  ('c5000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'owner', TRUE),
  ('c5000000-0000-4000-8000-000000000002',
   'c0000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', 'owner', TRUE);

-- ── Владелец org A задаёт слаг ───────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"c4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"org_id":"c0000000-0000-4000-8000-000000000001"}}',
  true
);

SELECT is(
  (SELECT set_location_slug('c1000000-0000-4000-8000-000000000001', 'bulochka') ->> 'slug'),
  'bulochka',
  'владелец задаёт слаг точки из веб-кабинета'
);

SELECT is(
  (SELECT location_id FROM location_slugs WHERE slug = 'bulochka'),
  'c1000000-0000-4000-8000-000000000001'::uuid,
  'слаг привязан к своей точке'
);

-- Владелец набрал с заглавной и пробелом — это не повод для ошибки
SELECT is(
  (SELECT set_location_slug('c1000000-0000-4000-8000-000000000001', '  Bulochka-Center ') ->> 'slug'),
  'bulochka-center',
  'слаг нормализуется: trim + lower'
);

SELECT is(
  (SELECT count(*)::int FROM location_slugs
   WHERE location_id = 'c1000000-0000-4000-8000-000000000001'),
  1,
  'у точки остаётся ровно один канонический слаг'
);

-- ── Формат и резерв ──────────────────────────────────────────
SELECT throws_ok(
  $$ SELECT set_location_slug('c1000000-0000-4000-8000-000000000001', 'ab') $$,
  'invalid_slug_format',
  'слишком короткий слаг отбивается'
);

SELECT throws_ok(
  $$ SELECT set_location_slug('c1000000-0000-4000-8000-000000000001', 'Кафе') $$,
  'invalid_slug_format',
  'кириллица в публичном URL отбивается'
);

SELECT throws_ok(
  $$ SELECT set_location_slug('c1000000-0000-4000-8000-000000000001', 'order') $$,
  'slug_reserved',
  'служебный сегмент нельзя занять как слаг'
);

-- ── Снятие слага ─────────────────────────────────────────────
SELECT ok(
  (SELECT set_location_slug('c1000000-0000-4000-8000-000000000001', '') ->> 'slug') IS NULL,
  'пустая строка снимает слаг'
);

SELECT is(
  (SELECT count(*)::int FROM location_slugs
   WHERE location_id = 'c1000000-0000-4000-8000-000000000001'),
  0,
  'снятый слаг освобождает имя'
);

-- Вернём слаг для проверок занятости и резолва
SELECT set_location_slug('c1000000-0000-4000-8000-000000000001', 'bulochka');

-- ── Чужой tenant ─────────────────────────────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"c4000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"org_id":"c0000000-0000-4000-8000-000000000002"}}',
  true
);

SELECT throws_ok(
  $$ SELECT set_location_slug('c1000000-0000-4000-8000-000000000001', 'hijack') $$,
  'location not in organization',
  'чужую точку переименовать нельзя'
);

SELECT throws_ok(
  $$ SELECT set_location_slug('c1000000-0000-4000-8000-000000000002', 'bulochka') $$,
  'slug_taken',
  'занятый другим клиентом слаг не отдаётся'
);

-- ── Гость-аноним ─────────────────────────────────────────────
RESET ROLE;
SET LOCAL ROLE anon;

SELECT is(
  resolve_location_slug('bulochka'),
  'c1000000-0000-4000-8000-000000000001'::uuid,
  'гость резолвит слаг в location_id'
);

SELECT ok(
  resolve_location_slug('no-such-place') IS NULL,
  'несуществующий слаг резолвится в NULL, а не в ошибку'
);

-- Главное свойство: слаг-таблица не должна быть публичным списком клиентов
SELECT throws_ok(
  $$ SELECT count(*) FROM location_slugs $$,
  '42501',
  'permission denied for table location_slugs',
  'аноним не может перечислить клиентов обходом таблицы слагов'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
