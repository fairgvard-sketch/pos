-- ============================================================
-- 163 СТРУКТУРНОЕ ИМЯ ГОСТЯ И ПОЧТА В ПУБЛИЧНОЙ БРОНИ
--
-- МОТИВ. Публичная страница собирала одно поле «имя» и телефон. Этого
-- мало сразу по трём причинам:
--   * хостес не может обратиться к гостю по имени, когда в поле лежит
--     «Вольд Анотов 4 чел» — разобрать такую строку задним числом нельзя;
--   * почта — единственный канал, по которому можно прислать
--     подтверждение и напоминание, не платя за SMS;
--   * будущая предоплата (см. 164) обязана иметь адрес для чека:
--     квитанцию по телефону не отправить.
--
-- Решать это на клиенте нельзя: расклеить «имя фамилия» обратно в браузере
-- — значит хранить в базе догадку. Поэтому колонки заводятся здесь.
--
-- СОВМЕСТИМОСТЬ — главное свойство этой миграции.
--   1. `customer_name` ОСТАЁТСЯ и продолжает заполняться всегда. По нему
--      живут касса, карточка гостя, выгрузки и любой клиент, выложенный
--      до этого релиза. Ни один потребитель не обязан знать о новых
--      колонках.
--   2. `p_name` остаётся параметром. Старый фронт шлёт только его —
--      бронь создаётся ровно как раньше.
--   3. Новый фронт шлёт `p_first_name`/`p_last_name`, а `customer_name`
--      сервер собирает сам. Обратная сборка, а не разбор: склеить два
--      известных поля можно достоверно, а разделить одну строку — нет.
--   4. Почта НЕ обязательна на уровне БД. Формат проверяется, когда она
--      пришла; пустая — принимается. Жёсткое требование включается
--      отдельной миграцией ПОСЛЕ раскатки клиентов — тем же порядком,
--      которым включались staff-сессии (044/045) и горячий поток (086).
--      Иначе первый же гость с закэшированным старым фронтом получил бы
--      отказ на кнопке «подтвердить».
--
-- ⚠️ Привязка к профилю гостя (121) НЕ меняется: триггер по-прежнему
--    ищет гостя по нормализованному телефону и передаёт `customer_name`.
--    Почта в ключ сопоставления не входит — объединение профилей по
--    адресу это отдельное решение с другими рисками.
--
-- ⚠️ Наружу почта и телефон НЕ отдаются: `reservation_public_view` (118)
--    их не выбирает, и эта миграция её не трогает.
-- ============================================================

-- ── 1. Колонки ───────────────────────────────────────────────

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS customer_first_name TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS customer_last_name  TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS customer_email      TEXT;

COMMENT ON COLUMN reservations.customer_first_name IS
  'Имя гостя (163). NULL у броней, созданных до 163, и у walk-in с кассы — читать вместе с customer_name, а не вместо него.';
COMMENT ON COLUMN reservations.customer_last_name IS
  'Фамилия гостя (163). NULL у броней до 163.';
COMMENT ON COLUMN reservations.customer_email IS
  'Почта гостя (163), нормализованная (trim + нижний регистр). Публичные эндпоинты её не отдают.';

-- ── 2. Нормализация почты ────────────────────────────────────

/**
 * Почта → канонический вид или NULL, если её не прислали.
 *
 * Проверка намеренно консервативная: одна собака, точка в домене, без
 * пробелов и не длиннее 254 символов (RFC 5321). Изобретать полный
 * разбор RFC 5322 в регулярном выражении бессмысленно — настоящую
 * валидность адреса показывает только доставленное письмо, а задача
 * этой функции — отсечь очевидный мусор и опечатки вида «две собаки».
 *
 * Пустая строка = адрес не указан (NULL), а не ошибка: см. пункт 4
 * шапки миграции.
 */
CREATE OR REPLACE FUNCTION normalize_guest_email(p_email TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_email TEXT := LOWER(TRIM(COALESCE(p_email, '')));
BEGIN
  IF v_email = '' THEN
    RETURN NULL;
  END IF;
  IF LENGTH(v_email) > 254 THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:].]+$' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;
  RETURN v_email;
END $$;

COMMENT ON FUNCTION normalize_guest_email(TEXT) IS
  'Почта гостя → нижний регистр без пробелов (163). Пустая = NULL; мусор = invalid_email.';

-- ── 3. Заявка гостя со структурным именем ────────────────────

CREATE OR REPLACE FUNCTION submit_reservation(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_reserved_at TIMESTAMPTZ,
  p_note        TEXT DEFAULT NULL,
  p_zone_id     UUID DEFAULT NULL,
  p_rules_ack   JSONB DEFAULT NULL,
  p_first_name  TEXT DEFAULT NULL,
  p_last_name   TEXT DEFAULT NULL,
  p_email       TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_sch      JSONB;
  v_existing reservations%ROWTYPE;
  v_first    TEXT := NULLIF(LEFT(TRIM(COALESCE(p_first_name, '')), 40), '');
  v_last     TEXT := NULLIF(LEFT(TRIM(COALESCE(p_last_name, '')), 40), '');
  -- Имя для кассы и выгрузок: либо присланное целиком (старый клиент),
  -- либо собранное из частей. Порядок «имя фамилия» — тот же, что гость
  -- видел в форме, поэтому в чеке и в списке смены строка совпадает.
  v_name     TEXT := LEFT(TRIM(COALESCE(
                       NULLIF(TRIM(COALESCE(p_name, '')), ''),
                       CONCAT_WS(' ', v_first, v_last)
                     )), 60);
  v_phone    TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_email    TEXT := normalize_guest_email(p_email);
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
      customer_first_name, customer_last_name, customer_email,
      party_size, reserved_at, note, duration_min, table_id, hold_table_ids,
      auto, status, decided_at, deposit_amount, deposit_status, zone_id, created_via,
      rules_ack)
    VALUES (
      v_loc.org_id, p_location_id, p_client_uuid, v_name, v_phone,
      v_first, v_last, v_email,
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

-- Прежняя девятиаргументная версия удаляется: оставленная рядом, она
-- сделала бы вызов по именованным аргументам неоднозначным (42725) —
-- та же грабля, что и в 145. Клиент, выложенный до 163, продолжает
-- работать: PostgREST подставит умолчания новых параметров, а имя
-- приедет прежним `p_name` (порядок релиза «миграция → функция → фронт»).
DROP FUNCTION IF EXISTS submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, JSONB);

REVOKE ALL ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, JSONB, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, JSONB, TEXT, TEXT, TEXT)
  TO service_role;

COMMENT ON FUNCTION submit_reservation(UUID, UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, JSONB, TEXT, TEXT, TEXT) IS
  'Заявка гостя с публичной страницы (053/118/136/145/163). Структурное имя p_first_name/p_last_name и p_email опциональны: без них customer_name берётся из p_name — старый клиент работает как раньше. Почта проверяется по формату, но пока не обязательна.';
