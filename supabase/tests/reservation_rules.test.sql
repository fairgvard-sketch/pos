-- pgTAP: правила брони и согласие гостя (145).
--
-- Проверяется то, ради чего правила и заводились: обязательный пункт
-- нельзя обойти мимо страницы (галочку проверяет сервер, а не браузер),
-- а снимок согласия остаётся тем, что гость видел в день заявки, — даже
-- когда владелец переписал правила на следующей неделе.
--
-- Отдельно закреплено, что правила ограничивают ГОСТЯ, а не сотрудника:
-- ручная бронь кассы проходит без единой отметки — то же решение, что
-- принято для часов работы (060/117).

BEGIN;
SELECT plan(17);

-- ── Фикстура ─────────────────────────────────────────────────
INSERT INTO orgs (id, name) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'pgTAP reservation rules');

INSERT INTO organization_products (org_id, product) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'reservations'),
  ('b1000000-0000-4000-8000-000000000001', 'pos');

INSERT INTO locations (id, org_id, name, timezone) VALUES
  ('b1100000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
   'Rules loc', 'Asia/Jerusalem'),
  -- Вторая точка без правил: у неё согласия быть не должно вовсе
  ('b1100000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001',
   'Plain loc', 'Asia/Jerusalem');

INSERT INTO staff (id, org_id, location_id, name, role, pin_hash) VALUES
  ('b1300000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
   'b1100000-0000-4000-8000-000000000001', 'Хостес', 'manager', 'x');

-- Круглосуточно: тест про правила, а не про часы приёма
CREATE FUNCTION pg_temp.open_always() RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'weekly', (SELECT jsonb_object_agg(i::TEXT, '[["00:00","23:59"]]'::jsonb)
               FROM generate_series(0, 6) i),
    'exceptions', '{}'::jsonb, 'lead_min', 0, 'horizon_days', 365)
$$;

UPDATE locations SET settings = jsonb_build_object('reservations', jsonb_build_object(
  'enabled', TRUE,
  'schedule', pg_temp.open_always(),
  'rules', jsonb_build_array(
    jsonb_build_object('id', 'price', 'text', 'עלות המופע 289 ש"ח לסועד',
                       'level', 'important'),
    jsonb_build_object('id', 'shared', 'text', 'הישיבה במסעדה הינה שיתופית',
                       'ack', TRUE))))
WHERE id = 'b1100000-0000-4000-8000-000000000001';

UPDATE locations SET settings = jsonb_build_object('reservations', jsonb_build_object(
  'enabled', TRUE, 'schedule', pg_temp.open_always()))
WHERE id = 'b1100000-0000-4000-8000-000000000002';

CREATE FUNCTION pg_temp.at_in(p_i INTERVAL) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$ SELECT date_trunc('hour', NOW() + p_i) $$;

CREATE FUNCTION pg_temp.ack_of(p_name TEXT) RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT rules_ack FROM reservations WHERE customer_name = p_name
$$;

-- ── 1. Нормализация правил ───────────────────────────────────

SELECT is(
  reservation_rules('{}'::JSONB),
  '[]'::JSONB,
  'точка без правил отдаёт пустой список, а не NULL'
);

SELECT is(
  reservation_rules('{"reservations":{"rules":[{"text":"без id"}]}}'::JSONB) -> 0 ->> 'id',
  'r1',
  'пункт без id получает устойчивый номер позиции'
);

SELECT is(
  reservation_rules('{"reservations":{"rules":[{"text":"x","level":"critical"}]}}'::JSONB)
    -> 0 ->> 'level',
  'normal',
  'незнакомая важность читается как обычная, а не теряет пункт'
);

-- ack — только настоящий JSON-true. Строка «yes» в настройках не должна
-- ни делать пункт обязательным, ни ронять страницу приведением типа.
SELECT is(
  reservation_rules('{"reservations":{"rules":[{"text":"x","ack":"yes"}]}}'::JSONB)
    -> 0 -> 'ack',
  'false'::JSONB,
  'обязательным пункт делает только ack:true'
);

SELECT is(
  jsonb_array_length(
    reservation_rules('{"reservations":{"rules":[{"text":"  "},{"text":"есть"}]}}'::JSONB)),
  1,
  'пункт без текста гостю не показывается'
);

SELECT is(
  length(reservation_rules(
    jsonb_build_object('reservations', jsonb_build_object('rules',
      jsonb_build_array(jsonb_build_object('text', repeat('я', 400)))))) -> 0 ->> 'text'),
  300,
  'слишком длинный текст обрезается, а не уходит гостю целиком'
);

-- ── 2. Обязательный пункт проверяет сервер ───────────────────

SELECT throws_ok(
  $$ SELECT submit_reservation(
       'b1100000-0000-4000-8000-000000000001',
       'b1a00000-0000-4000-8000-000000000001',
       'Без согласия', '0501111111', 2, date_trunc('hour', NOW() + INTERVAL '3 hours')) $$,
  'rules_not_accepted',
  'заявка без отметки обязательного пункта отклонена'
);

SELECT throws_ok(
  $$ SELECT submit_reservation(
       'b1100000-0000-4000-8000-000000000001',
       'b1a00000-0000-4000-8000-000000000002',
       'Чужая отметка', '0502222222', 2, date_trunc('hour', NOW() + INTERVAL '3 hours'),
       NULL, NULL, '["price"]'::JSONB) $$,
  'rules_not_accepted',
  'отметка необязательного пункта не заменяет обязательный'
);

SELECT lives_ok(
  $$ SELECT submit_reservation(
       'b1100000-0000-4000-8000-000000000001',
       'b1a00000-0000-4000-8000-000000000003',
       'С согласием', '0503333333', 2, date_trunc('hour', NOW() + INTERVAL '3 hours'),
       NULL, NULL, '["shared"]'::JSONB) $$,
  'заявка с отмеченным обязательным пунктом принимается'
);

-- ── 3. Снимок согласия ───────────────────────────────────────

SELECT ok(
  pg_temp.ack_of('С согласием') ->> 'accepted_at' IS NOT NULL,
  'момент согласия записан'
);

SELECT is(
  jsonb_array_length(pg_temp.ack_of('С согласием') -> 'rules'),
  2,
  'в снимке ВСЕ показанные правила, не только отмеченные'
);

SELECT ok(
  (SELECT (r -> 'accepted') = 'true'::JSONB AND (r -> 'required') = 'true'::JSONB
   FROM jsonb_array_elements(pg_temp.ack_of('С согласием') -> 'rules') r
   WHERE r ->> 'id' = 'shared'),
  'обязательный пункт помечен принятым'
);

SELECT ok(
  (SELECT (r -> 'accepted') = 'false'::JSONB
   FROM jsonb_array_elements(pg_temp.ack_of('С согласием') -> 'rules') r
   WHERE r ->> 'id' = 'price'),
  'пункт без галочки не выдаётся за принятый'
);

-- Владелец переписал правила ПОСЛЕ брони: снимок отвечает за то, что
-- видел гость, и меняться задним числом не имеет права.
UPDATE locations SET settings = jsonb_set(
  settings, '{reservations,rules}',
  jsonb_build_array(jsonb_build_object('id', 'shared', 'text', 'ПЕРЕПИСАНО', 'ack', TRUE)))
WHERE id = 'b1100000-0000-4000-8000-000000000001';

SELECT ok(
  (SELECT bool_and(r ->> 'text' <> 'ПЕРЕПИСАНО')
   FROM jsonb_array_elements(pg_temp.ack_of('С согласием') -> 'rules') r),
  'правка правил не переписывает уже данное согласие'
);

-- ── 4. Точка без правил ──────────────────────────────────────

SELECT lives_ok(
  $$ SELECT submit_reservation(
       'b1100000-0000-4000-8000-000000000002',
       'b1a00000-0000-4000-8000-000000000004',
       'Без правил', '0504444444', 2, date_trunc('hour', NOW() + INTERVAL '3 hours')) $$,
  'точка без правил принимает заявку как раньше'
);

SELECT ok(
  pg_temp.ack_of('Без правил') IS NULL,
  'без правил согласие не выдумывается'
);

-- ── 5. Правило ограничивает гостя, а не сотрудника ───────────

-- Контекст кассы выставляется ВНУТРИ проверки: отдельным оператором он
-- дал бы лишнюю строку вывода, и TAP счёл бы её семнадцатым тестом.
SELECT lives_ok(
  $$ SELECT set_config('request.jwt.claims',
       json_build_object('app_metadata', json_build_object(
         'org_id', 'b1000000-0000-4000-8000-000000000001',
         'location_id', 'b1100000-0000-4000-8000-000000000001'))::text, TRUE);
     SELECT create_reservation(
       'b1100000-0000-4000-8000-000000000001',
       'b1300000-0000-4000-8000-000000000001',
       'Звонок хостес', '0505555555', 2, date_trunc('hour', NOW() + INTERVAL '5 hours')) $$,
  'ручная бронь кассы правила не проверяет'
);

SELECT * FROM finish();
ROLLBACK;
