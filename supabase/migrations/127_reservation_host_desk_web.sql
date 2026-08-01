-- ============================================================
-- 127. Стол хостес: ручная бронь, walk-in и правка визита из кабинета
--
-- До неё веб-стол умел только реагировать: подтвердить, посадить,
-- закрыть. Гость, позвонивший по телефону, и гость, вошедший с улицы,
-- заводились ТОЛЬКО на кассе — standalone-точке (ANGLE Reserve без POS)
-- записать их было негде вообще.
--
-- Правила доступности не переизобретаются: и создание, и перенос идут
-- через тот же `_pick_tables` (063/072) и тот же exclusion-constraint,
-- что и гостевая страница. Клиент не выбирает, свободен ли стол, — это
-- решает сервер, иначе два хостес за разными экранами посадят на один
-- стол двоих.
--
-- ⚠️ ТРЕБУЕТ 120 (_reservation_web_member) и 126 (_pick_tables-вызов).
-- ============================================================

-- ── 1. Ручная бронь и walk-in ────────────────────────────────
/**
 * Завести визит из кабинета.
 *
 * `p_walk_in` = TRUE — гость уже в зале: время «сейчас», статус
 * confirmed и arrived_at сразу, чтобы стол считался занятым, а не
 * ждал отдельного «посадить».
 *
 * `p_table_ids` пустой — стол подбирает сервер (тот же алгоритм, что
 * гостю). Явный список проверяется на принадлежность точке и занятость:
 * хостес имеет право посадить куда решил, но не поверх чужого визита.
 *
 * source='backoffice' — в воронке (124) ручные визиты обязаны быть
 * отличимы от гостевых, иначе конверсия страницы считается по ним же.
 */
CREATE OR REPLACE FUNCTION create_reservation_web(
  p_location_id UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_at          TIMESTAMPTZ DEFAULT NULL,
  p_note        TEXT DEFAULT NULL,
  p_table_ids   UUID[] DEFAULT NULL,
  p_walk_in     BOOLEAN DEFAULT FALSE
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member  UUID := _reservation_web_member(p_location_id);
  v_org     UUID := auth_org_id();
  v_rsv     JSONB;
  v_at      TIMESTAMPTZ;
  v_party   INTEGER := GREATEST(1, LEAST(COALESCE(p_party_size, 2), 50));
  v_name    TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_phone   TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note    TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_dur     INTEGER;
  v_buffer  INTEGER;
  v_combine BOOLEAN;
  v_tables  UUID[] := COALESCE(p_table_ids, '{}');
  v_table   UUID;
  v_id      UUID;
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'name_required';
  END IF;

  SELECT COALESCE(settings -> 'reservations', '{}'::jsonb) INTO v_rsv
  FROM locations WHERE id = p_location_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  v_dur     := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buffer  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);
  v_combine := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_at      := CASE WHEN p_walk_in THEN NOW() ELSE COALESCE(p_at, NOW()) END;

  IF array_length(v_tables, 1) IS NULL THEN
    -- Стола не назвали — подбираем сам. Пусто = сажать некуда.
    v_tables := _pick_tables(p_location_id, v_party, v_at, v_dur, v_buffer,
                             v_combine, NULL, NULL);
    IF array_length(v_tables, 1) IS NULL THEN
      RAISE EXCEPTION 'full_slot';
    END IF;
  ELSE
    FOREACH v_table IN ARRAY v_tables LOOP
      IF NOT EXISTS (
        SELECT 1 FROM tables
        WHERE id = v_table AND org_id = v_org
          AND location_id = p_location_id AND is_active
      ) THEN
        RAISE EXCEPTION 'invalid table';
      END IF;
      IF NOT _table_free(v_table, v_at, v_dur, v_buffer, NULL) THEN
        RAISE EXCEPTION 'table_busy';
      END IF;
    END LOOP;
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, duration_min, table_id, hold_table_ids,
      status, auto, decided_at, decided_by_member, note, source, arrived_at)
    VALUES (
      v_org, p_location_id, gen_random_uuid(), v_name,
      COALESCE(NULLIF(v_phone, ''), ''),
      v_party, v_at, v_dur, v_tables[1],
      COALESCE(v_tables[2:array_length(v_tables, 1)], '{}'::UUID[]),
      'confirmed', FALSE, NOW(), v_member, v_note, 'backoffice',
      CASE WHEN p_walk_in THEN NOW() ELSE NULL END)
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  RETURN json_build_object(
    'reservation_id', v_id, 'reserved_at', v_at,
    'table_id', v_tables[1], 'duration_min', v_dur);
END $$;

REVOKE ALL ON FUNCTION create_reservation_web(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID[], BOOLEAN)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_reservation_web(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID[], BOOLEAN)
  TO authenticated;

COMMENT ON FUNCTION create_reservation_web(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID[], BOOLEAN) IS
  'Ручная бронь и walk-in из веб-кабинета (127): доступность считает сервер тем же _pick_tables, что и гостевая страница; source=backoffice отделяет их от гостевых в воронке.';

-- ── 2. Контакты гостя ────────────────────────────────────────
/**
 * Имя и телефон визита.
 *
 * Время, компанию, зону, длительность и заметку правит
 * `update_reservation_web` (120) — там же живёт пересчёт доступности.
 * Контакты занятость не меняют, поэтому им отдельная маленькая функция,
 * а не расширение чужой сигнатуры: перегрузка сделала бы вызов
 * неоднозначным для уже выложенных клиентов.
 *
 * Телефон нормализуется до цифр — по нему ищут гостя и звонят.
 */
CREATE OR REPLACE FUNCTION update_reservation_guest_web(
  p_location_id UUID,
  p_id          UUID,
  p_name        TEXT DEFAULT NULL,
  p_phone       TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_r      reservations%ROWTYPE;
  v_name   TEXT;
  v_phone  TEXT;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE id = p_id AND org_id = auth_org_id() AND location_id = p_location_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.status NOT IN ('new', 'confirmed') THEN
    RAISE EXCEPTION 'not_active';
  END IF;
  IF v_r.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_mode';
  END IF;

  v_name  := COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), v_r.customer_name);
  v_phone := COALESCE(
    NULLIF(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), ''),
    v_r.customer_phone);

  UPDATE reservations
  SET customer_name   = LEFT(v_name, 120),
      customer_phone  = LEFT(v_phone, 20),
      decided_by_member = v_member
  WHERE id = p_id;

  RETURN json_build_object('reservation_id', p_id,
                           'customer_name', LEFT(v_name, 120),
                           'customer_phone', LEFT(v_phone, 20));
END $$;

REVOKE ALL ON FUNCTION update_reservation_guest_web(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_reservation_guest_web(UUID, UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION update_reservation_guest_web(UUID, UUID, TEXT, TEXT) IS
  'Имя и телефон визита из веб-кабинета (127). Время/компанию/зону правит update_reservation_web (120); визит, посаженный в POS-заказ, не редактируется.';

-- ============================================================
-- ОТКАТ
--
-- Forward-only, схему не меняет — только функции. Функциональный откат:
-- отозвать EXECUTE у `authenticated`, стол хостес вернётся к работе
-- «только реагировать» (кассовый путь не затрагивается).
--
-- ПРОВЕРКА: под веб-владельцем без POS
--   SELECT create_reservation_web('<loc>', 'Гость', '0500000000', 2);
--   SELECT create_reservation_web('<loc>', 'Улица', '', 2, NULL, NULL, NULL, TRUE);
--   SELECT update_reservation_guest_web('<loc>', '<res>', 'Новое имя', '0521234567');
-- ============================================================
