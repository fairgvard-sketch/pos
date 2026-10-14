-- pgTAP: режим «Только меню» (183).
--
-- online_orders.menu_only = TRUE — владелец показывает гостям меню без
-- заказа. Гостевая страница в этом режиме витрина, но клиент границей не
-- является: заявку обязан отклонить сервер. Отсутствие ключа и FALSE —
-- прежнее поведение (заказ принимается). Идемпотентный повтор уже
-- принятой заявки не ломается после переключения режима.

BEGIN;
SELECT plan(6);

-- ── Фикстура: standalone-точка без смен, приём в любое время ─
INSERT INTO orgs (id, name) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'pgTAP menu only');
INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'Menu only loc', 'Asia/Jerusalem');
INSERT INTO organization_products (org_id, product) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'menu'),
  ('f0000000-0000-4000-8000-000000000001', 'online_orders');
INSERT INTO menu_categories (id, org_id, location_id, name, is_active) VALUES
  ('f3000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
   'f1000000-0000-4000-8000-000000000001', 'Выпечка', TRUE);
INSERT INTO menu_items (id, org_id, category_id, name, price, is_available) VALUES
  ('f3000000-0000-4000-8000-000000000011', 'f0000000-0000-4000-8000-000000000001',
   'f3000000-0000-4000-8000-000000000001', 'Круассан', 700, TRUE);

CREATE FUNCTION pg_temp.submit(p_uuid UUID)
RETURNS JSON LANGUAGE sql AS $$
  SELECT submit_online_order(
    'f1000000-0000-4000-8000-000000000001', p_uuid, 'Гость',
    -- телефон уникален на заявку, чтобы не упереться в лимит частоты
    '0502' || RIGHT(REPLACE(p_uuid::TEXT, '-', ''), 6),
    '[{"menu_item_id":"f3000000-0000-4000-8000-000000000011","qty":1}]'::jsonb)
$$;

CREATE FUNCTION pg_temp.set_menu_only(p_value JSONB)
RETURNS VOID LANGUAGE sql AS $$
  UPDATE locations
     SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb),
       '{online_orders}',
       COALESCE(settings -> 'online_orders', '{}'::jsonb) || jsonb_build_object('menu_only', p_value))
   WHERE id = 'f1000000-0000-4000-8000-000000000001'
$$;

-- ── Без ключа — заказ, как до 183 ───────────────────────────
SELECT lives_ok($$
  SELECT pg_temp.submit('f9000000-0000-4000-8000-000000000001')
$$, 'без menu_only заявка принимается (прежнее поведение)');

-- ── menu_only = TRUE — заявка отклоняется ────────────────────
SELECT pg_temp.set_menu_only('true'::jsonb);

SELECT throws_ok($$
  SELECT pg_temp.submit('f9000000-0000-4000-8000-000000000002')
$$, 'disabled',
   'в режиме «Только меню» новая заявка отклонена кодом disabled');

SELECT is(
  (SELECT COUNT(*)::INTEGER FROM online_orders
    WHERE client_uuid = 'f9000000-0000-4000-8000-000000000002'),
  0,
  'отклонённая заявка не оставила строки'
);

SELECT is(
  (pg_temp.submit('f9000000-0000-4000-8000-000000000001') ->> 'duplicate')::BOOLEAN,
  TRUE,
  'повтор уже принятой заявки возвращает её и в режиме «Только меню»'
);

-- ── menu_only = FALSE — снова заказ ─────────────────────────
SELECT pg_temp.set_menu_only('false'::jsonb);

SELECT lives_ok($$
  SELECT pg_temp.submit('f9000000-0000-4000-8000-000000000003')
$$, 'menu_only = false возвращает приём заявок');

-- Режим не подменяет выключенный приём: enabled = false по-прежнему отказ.
UPDATE locations
   SET settings = jsonb_set(settings, '{online_orders,enabled}', 'false'::jsonb)
 WHERE id = 'f1000000-0000-4000-8000-000000000001';

SELECT throws_ok($$
  SELECT pg_temp.submit('f9000000-0000-4000-8000-000000000004')
$$, 'disabled',
   'выключенный приём (enabled = false) отклоняет заявку как раньше');

SELECT * FROM finish();
ROLLBACK;
