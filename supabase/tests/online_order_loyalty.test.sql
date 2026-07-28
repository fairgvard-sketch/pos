-- pgTAP: лояльность в онлайн-заказах (113).
--
-- Проверяется upsert_guest_by_phone: нормализация телефона к цифрам,
-- идемпотентность по (org_id, phone), запрет затирания уточнённого
-- имени, отсечение коротких номеров, изоляция по org и закрытые гранты.
-- Балансы гость получает только при оплате (pay_order, 046) — здесь
-- проверяется лишь связь, не начисление.

BEGIN;
SELECT plan(11);

-- ── Фикстура: две org ──────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'pgTAP loyalty A'),
  ('c0000000-0000-4000-8000-000000000002', 'pgTAP loyalty B');

-- ── Функция существует и закрыта для клиентов ──────────────
SELECT has_function('upsert_guest_by_phone');

SELECT ok(
  NOT has_function_privilege('anon', 'upsert_guest_by_phone(uuid, text, text)', 'EXECUTE'),
  'anon не вызывает upsert_guest_by_phone'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'upsert_guest_by_phone(uuid, text, text)', 'EXECUTE'),
  'authenticated не вызывает upsert_guest_by_phone напрямую'
);

-- ── Нормализация: формат ввода не создаёт второго гостя ─────
SELECT lives_ok($$
  SELECT upsert_guest_by_phone(
    'c0000000-0000-4000-8000-000000000001', '050-123-4567', 'Дана')
$$, 'первый вызов заводит гостя');

SELECT is(
  (SELECT phone FROM guests WHERE org_id = 'c0000000-0000-4000-8000-000000000001'),
  '0501234567',
  'телефон нормализован к одним цифрам'
);

SELECT is(
  upsert_guest_by_phone('c0000000-0000-4000-8000-000000000001', '0501234567', 'Дана'),
  (SELECT id FROM guests WHERE org_id = 'c0000000-0000-4000-8000-000000000001'),
  'тот же номер в другом формате возвращает того же гостя'
);

SELECT is(
  (SELECT COUNT(*)::int FROM guests WHERE org_id = 'c0000000-0000-4000-8000-000000000001'),
  1,
  'повторный вызов не плодит дублей'
);

-- ── Имя из заявки не затирает уточнённое кассиром ───────────
UPDATE guests SET name = 'Дана Коэн'
WHERE org_id = 'c0000000-0000-4000-8000-000000000001';

SELECT upsert_guest_by_phone(
  'c0000000-0000-4000-8000-000000000001', '0501234567', 'дана');

SELECT is(
  (SELECT name FROM guests WHERE org_id = 'c0000000-0000-4000-8000-000000000001'),
  'Дана Коэн',
  'имя из онлайн-заявки не затирает уточнённое в кассе'
);

-- ── Короткий/пустой номер гостя не создаёт ──────────────────
SELECT is(
  upsert_guest_by_phone('c0000000-0000-4000-8000-000000000001', '12345', NULL),
  NULL,
  'слишком короткий номер → NULL, гость не заводится'
);

SELECT is(
  upsert_guest_by_phone('c0000000-0000-4000-8000-000000000001', '', NULL),
  NULL,
  'пустой номер → NULL'
);

-- ── Изоляция по org: тот же телефон в другой org — другой гость ──
SELECT isnt(
  upsert_guest_by_phone('c0000000-0000-4000-8000-000000000002', '0501234567', NULL),
  (SELECT id FROM guests WHERE org_id = 'c0000000-0000-4000-8000-000000000001'),
  'тот же телефон в другой org — отдельный гость'
);

SELECT * FROM finish();
ROLLBACK;
