-- ============================================================
-- 145 RESERVATION RULES — правила брони, которые гость видит ДО заявки
-- и подтверждает явной галочкой.
--
-- МОТИВ. Правило у брони было ровно одно — свободный текст
-- `settings.reservations.policy`, и его показывали ТОЛЬКО в карточке
-- уже созданной брони (118). То есть условия визита гость читал после
-- того, как согласился на них. Для «стоимость 289 ₪ с человека»,
-- «меню нет», «посадка общая» и «нужны данные карты» это не годится:
-- такие пункты либо показаны до отправки, либо не показаны вовсе.
--
-- ЧТО ЗДЕСЬ.
--   1. `settings.reservations.rules` — список пунктов, а не один абзац:
--      у каждого есть важность (обычный / выделенный) и признак
--      «требует галочки». Нормализуется ОДНОЙ функцией
--      `reservation_rules`, чтобы показанное гостю и проверяемое
--      сервером не разошлись — урок часов из 117.
--   2. `reservations.rules_ack` — снимок того, что гость видел и с чем
--      согласился, вместе с моментом согласия.
--   3. `submit_reservation` v3 — принимает список отмеченных пунктов и
--      ОТКАЗЫВАЕТ (`rules_not_accepted`), если хоть один обязательный
--      не отмечен. Галочка, которую проверяет только браузер, — это
--      украшение: заявку можно отправить и мимо страницы.
--
-- ПОЧЕМУ СНИМОК, А НЕ ССЫЛКА НА НАСТРОЙКИ. Владелец правит правила
-- когда угодно. Через месяц «с чем согласился гость» по текущим
-- настройкам восстановить нельзя — ровно как сумму заказа по текущему
-- прайсу (инвариант снапшота условий в момент операции).
--
-- ПОЧЕМУ ТЕКСТ БЕРЁТСЯ ИЗ НАСТРОЕК, А НЕ ОТ КЛИЕНТА. Клиент присылает
-- только идентификаторы отмеченных пунктов. Прими мы текст снаружи —
-- в «подписанном» снимке оказалось бы что угодно, и он перестал бы
-- быть доказательством.
--
-- РУЧНАЯ БРОНЬ (`create_reservation`, 119 и веб-зеркала) правила НЕ
-- проверяет: правило ограничивает гостя, а не сотрудника — то же
-- решение, что принято для часов работы (060/117).
--
-- ⚠️ ТРЕБУЕТ 118 (public_token), 136 (created_via).
-- ============================================================

-- ── Нормализация правил ──────────────────────────────────────
--
-- Единственное место, где решается «какие правила у точки и какие из
-- них обязательны». Её же результат уходит гостю через Edge Function,
-- поэтому вторая реализация здесь недопустима.
--
-- id может отсутствовать (правила правились руками в JSON) — тогда он
-- выводится из позиции. Кабинет всегда пишет свой.

CREATE OR REPLACE FUNCTION reservation_rules(p_settings JSONB)
RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(rule ORDER BY idx), '[]'::JSONB)
  FROM (
    SELECT
      idx,
      jsonb_build_object(
        'id',    COALESCE(NULLIF(btrim(item ->> 'id'), ''), 'r' || idx),
        'text',  LEFT(btrim(item ->> 'text'), 300),
        -- Выделенный пункт рисуется красным маркером. Перечень закрыт:
        -- незнакомое значение — обычный пункт, а не пропавший текст.
        'level', CASE WHEN item ->> 'level' = 'important' THEN 'important' ELSE 'normal' END,
        -- Обязательная галочка. Сравнение с jsonb-литералом, а не cast:
        -- строка «да» в настройках не должна ронять всю страницу брони.
        'ack',   COALESCE((item -> 'ack') = 'true'::JSONB, FALSE),
        'url',   NULLIF(btrim(COALESCE(item ->> 'url', '')), '')
      ) AS rule
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_settings #> '{reservations,rules}') = 'array'
           THEN p_settings #> '{reservations,rules}'
           ELSE '[]'::JSONB END
    ) WITH ORDINALITY AS t(item, idx)
    WHERE btrim(COALESCE(item ->> 'text', '')) <> ''
    ORDER BY idx
    LIMIT 20
  ) s;
$$;

COMMENT ON FUNCTION reservation_rules(JSONB) IS
  'Правила брони точки (145) в нормальном виде: [{id,text,level,ack,url}]. Единый источник для гостевой страницы и для проверки согласия в submit_reservation.';

REVOKE ALL ON FUNCTION reservation_rules(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reservation_rules(JSONB) TO service_role, authenticated;

-- ── Снимок согласия ──────────────────────────────────────────

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS rules_ack JSONB;

COMMENT ON COLUMN reservations.rules_ack IS
  'Что гость видел и с чем согласился в момент заявки (145): {accepted_at, rules:[{id,text,required,accepted}]}. NULL — правил у точки не было или бронь заведена сотрудником.';

-- ── Гостевая заявка v3 ───────────────────────────────────────
--
-- Тело скопировано из 136 дословно; добавлены ТОЛЬКО параметр
-- p_rules_ack, проверка обязательных пунктов и снимок согласия.
-- Так требует forward-only: частично изменить тело функции нельзя.

CREATE OR REPLACE FUNCTION submit_reservation(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_reserved_at TIMESTAMPTZ,
  p_note        TEXT DEFAULT NULL,
  p_zone_id     UUID DEFAULT NULL,
  p_rules_ack   JSONB DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_sch      JSONB;
  v_existing reservations%ROWTYPE;
  v_name     TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone    TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note     TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_max      INTEGER;
  v_instant  BOOLEAN;
  v_combine  BOOLEAN;
  v_dur      INTEGER;
  v_buffer   INTEGER;
  v_tables   UUID[];
  v_table    UUID := NULL;
  v_hold     UUID[] := '{}';
  v_status   TEXT := 'new';
  v_dep_amt  INTEGER := 0;
  v_dep_st   TEXT := 'none';
  v_id       UUID;
  v_token    UUID;
  v_rules    JSONB;
  v_checked  JSONB := CASE WHEN jsonb_typeof(p_rules_ack) = 'array'
                           THEN p_rules_ack ELSE '[]'::JSONB END;
  v_ack      JSONB := NULL;
BEGIN
  -- Идемпотентность
  SELECT * INTO v_existing FROM reservations WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('reservation_id', v_existing.id, 'duplicate', TRUE,
                             'status', v_existing.status,
                             'public_token', v_existing.public_token);
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  IF NOT org_has_capability(v_loc.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;

  v_rsv := v_loc.settings -> 'reservations';

  IF NOT COALESCE((v_rsv ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;
  v_max := GREATEST(1, LEAST(200, COALESCE((v_rsv ->> 'max_party')::INTEGER, 20)));
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > v_max THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;

  -- Правила точки (145). Проверяется ДО подбора стола: отказ по
  -- непринятому правилу не должен занимать и тут же освобождать стол.
  v_rules := reservation_rules(v_loc.settings);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_rules) AS r
    WHERE (r -> 'ack') = 'true'::JSONB
      AND NOT (v_checked ? (r ->> 'id'))
  ) THEN
    RAISE EXCEPTION 'rules_not_accepted';
  END IF;

  v_sch := reservation_schedule(v_loc.settings);
  IF p_reserved_at IS NULL
     OR p_reserved_at < NOW() + make_interval(mins => (v_sch ->> 'lead_min')::INTEGER)
     OR p_reserved_at > NOW() + make_interval(days => (v_sch ->> 'horizon_days')::INTEGER) THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM table_zones
    WHERE id = p_zone_id AND location_id = p_location_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  IF NOT reservation_bookable_at(v_loc.settings, v_loc.timezone, p_reserved_at) THEN
    RAISE EXCEPTION 'outside_hours';
  END IF;

  IF (SELECT COUNT(*) FROM reservations
      WHERE customer_phone = v_phone AND created_at > NOW() - INTERVAL '15 minutes') >= 3 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT COUNT(*) FROM reservations
      WHERE location_id = p_location_id AND status = 'new') >= 30 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  v_instant := COALESCE((v_rsv ->> 'instant')::BOOLEAN, FALSE);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_dur     := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);

  IF COALESCE((v_rsv ->> 'deposit_required')::BOOLEAN, FALSE)
     AND p_party_size >= COALESCE((v_rsv ->> 'deposit_from_party')::INTEGER, 1) THEN
    v_dep_amt := GREATEST(0, COALESCE((v_rsv ->> 'deposit_amount')::INTEGER, 0));
    IF v_dep_amt > 0 THEN
      v_dep_st := 'required';
    END IF;
  END IF;

  IF v_instant THEN
    v_tables := _pick_tables(p_location_id, p_party_size, p_reserved_at, v_dur,
                             v_buffer, v_combine, NULL, p_zone_id);
    IF array_length(v_tables, 1) IS NULL THEN
      RAISE EXCEPTION 'full_slot';
    END IF;
    v_table  := v_tables[1];
    v_hold   := v_tables[2:array_length(v_tables, 1)];
    v_status := 'confirmed';
  END IF;

  -- Снимок правил: не только отмеченные, а ВСЁ, что было показано.
  -- Условие «289 ₪ с человека» галочки не требует, но остаётся частью
  -- договорённости, и через месяц спор пойдёт именно о нём.
  IF jsonb_array_length(v_rules) > 0 THEN
    v_ack := jsonb_build_object(
      'accepted_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'rules', (
        SELECT jsonb_agg(jsonb_build_object(
          'id',       r ->> 'id',
          'text',     r ->> 'text',
          'required', (r -> 'ack') = 'true'::JSONB,
          'accepted', v_checked ? (r ->> 'id')
        ) ORDER BY ord)
        FROM jsonb_array_elements(v_rules) WITH ORDINALITY AS t(r, ord)
      )
    );
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, note, duration_min, table_id, hold_table_ids,
      auto, status, decided_at, deposit_amount, deposit_status, zone_id, created_via,
      rules_ack)
    VALUES (
      v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
      p_party_size, p_reserved_at, v_note, v_dur, v_table, COALESCE(v_hold, '{}'),
      v_instant, v_status, CASE WHEN v_instant THEN NOW() END, v_dep_amt, v_dep_st,
      p_zone_id, 'public', v_ack)
    RETURNING id, public_token INTO v_id, v_token;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'full_slot';
  END;

  RETURN json_build_object(
    'reservation_id', v_id,
    'duplicate', FALSE,
    'status', v_status,
    'public_token', v_token,
    'deposit_status', v_dep_st,
    'deposit_amount', v_dep_amt
  );
END $$;

-- Прежняя восьмиаргументная версия удаляется: оставленная рядом, она
-- сделала бы вызов по именованным аргументам неоднозначным (42725), и
-- гостевая страница начала бы падать на отправке. Клиент, выложенный
-- до 145, продолжает работать — PostgREST подставит умолчание нового
-- параметра (порядок релиза «миграция → функция → фронт»).
DROP FUNCTION IF EXISTS submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID);

REVOKE ALL ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, JSONB)
  TO service_role;

COMMENT ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, JSONB) IS
  'Заявка гостя с публичной страницы (053/118/136/145). p_rules_ack — идентификаторы отмеченных правил; обязательный пункт без отметки отклоняется кодом rules_not_accepted.';
