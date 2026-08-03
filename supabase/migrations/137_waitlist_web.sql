-- ============================================================
-- 137 WAITLIST WEB — очередь ожидания как рабочий инструмент хостес.
--
-- МОТИВ. Лист ожидания (122) построен под гостя: тот оставляет заявку с
-- публичной страницы, сервер подбирает, кого позвать на освободившийся
-- слот, гость соглашается по ссылке. Всё, что мог кабинет, — посмотреть
-- список и отправить предложение.
--
-- Живая очередь у стойки так не работает. Люди приходят без заявки, им
-- называют примерное время ожидания, их зовут по имени, кого-то сажают
-- раньше (двоих посадить проще, чем шестерых), кто-то уходит не
-- дождавшись. Ничего из этого записать было нельзя:
--
--   * `submit_waitlist` выдан только service_role — завести гостя из
--     кабинета невозможно, только с публичной страницы;
--   * посадки из листа нет вовсе: бронь появляется, лишь когда гость
--     сам примет предложение по ссылке;
--   * очередь не переставляется — порядок жёстко по времени записи;
--   * обещанное время ожидания не хранится, поэтому «ждём 20 минут»
--     живёт в голове хостес и в памяти гостя, а через полчаса это
--     превращается в спор.
--
-- ЧТО ЗДЕСЬ. Две колонки и четыре веб-зеркала по модели 123: право даёт
-- членство owner/manager (`_reservation_web_member`), точка приходит
-- параметром, сверху capability-гейт `reservations_desk`. Кассовые и
-- гостевые пути 122 не тронуты.
--
-- ГРАНИЦА ОТВЕТСТВЕННОСТИ. Занятость столов по-прежнему решает сервер
-- общим `_pick_tables`, а не экран: два хостес за двумя ноутбуками не
-- должны посадить разных гостей за один стол. Посадка из очереди
-- проходит ту же проверку, что и обычная бронь, и так же падает с
-- `full_slot`, если места нет.
--
-- ⚠️ ТРЕБУЕТ 122 (лист ожидания), 120/127 (`_reservation_web_member`),
-- 063 (`_pick_tables`), 136 (`created_via`).
-- ============================================================

-- ── Место в очереди и обещанное ожидание ─────────────────────
-- position: NULL означает «по времени записи». Заполняется только при
-- ручной перестановке — иначе пришлось бы поддерживать нумерацию у
-- каждой заявки с публичной страницы, которая приходит своим потоком.
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS position INTEGER;

-- quoted_min: сколько ждать пообещали. Хранится отдельно от факта —
-- «обещали 20, ждёт 35» это разговор, который должен опираться на
-- запись, а не на память двоих.
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS quoted_min INTEGER;

ALTER TABLE waitlist_entries DROP CONSTRAINT IF EXISTS waitlist_quoted_min_check;
ALTER TABLE waitlist_entries ADD CONSTRAINT waitlist_quoted_min_check
  CHECK (quoted_min IS NULL OR (quoted_min >= 0 AND quoted_min <= 600));

COMMENT ON COLUMN waitlist_entries.position IS
  'Ручное место в очереди (137). NULL — порядок по created_at.';
COMMENT ON COLUMN waitlist_entries.quoted_min IS
  'Обещанное гостю ожидание в минутах (137). Факт считается от created_at.';

-- ── 1. Завести гостя в очередь из кабинета ───────────────────
/**
 * Гость подошёл к стойке, столов нет — его записывают здесь.
 *
 * `p_client_uuid` создаётся КЛИЕНТОМ до первой попытки: повтор после
 * таймаута вернёт ту же запись, а не заведёт второго Ивана в очередь
 * (инвариант идемпотентности проекта).
 *
 * Окно ожидания «сегодня с этой минуты и до конца дня»: очередь у
 * стойки — про сейчас, а не про дату. Гостю, который хочет конкретный
 * вечер, заводят бронь, а не запись в лист.
 */
CREATE OR REPLACE FUNCTION add_waitlist_entry_web(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_quoted_min  INTEGER DEFAULT NULL,
  p_zone_ids    UUID[] DEFAULT NULL,
  p_note        TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_loc    locations%ROWTYPE;
  v_name   TEXT := NULLIF(LEFT(btrim(COALESCE(p_name, '')), 60), '');
  v_phone  TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note   TEXT := NULLIF(LEFT(btrim(COALESCE(p_note, '')), 200), '');
  v_party  INTEGER := GREATEST(1, LEAST(COALESCE(p_party_size, 2), 200));
  v_zones  UUID[] := COALESCE(p_zone_ids, '{}');
  v_local  TIMESTAMP;
  v_id     UUID;
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'name_required';
  END IF;
  IF p_quoted_min IS NOT NULL AND (p_quoted_min < 0 OR p_quoted_min > 600) THEN
    RAISE EXCEPTION 'invalid_quote';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Зоны проверяем: пожелание «на веранду» не должно ссылаться на зал,
  -- которого в этой точке нет.
  IF cardinality(v_zones) > 0 AND EXISTS (
    SELECT 1 FROM unnest(v_zones) z
    WHERE NOT EXISTS (
      SELECT 1 FROM table_zones
      WHERE id = z AND location_id = p_location_id AND is_active
    )
  ) THEN
    RAISE EXCEPTION 'invalid_zone';
  END IF;

  v_local := NOW() AT TIME ZONE COALESCE(v_loc.timezone, 'Asia/Jerusalem');

  INSERT INTO waitlist_entries (
    org_id, location_id, client_uuid, customer_name, customer_phone,
    party_size, wanted_date, time_from, time_to, zone_ids, note,
    status, quoted_min)
  VALUES (
    v_org, p_location_id, p_client_uuid, v_name, v_phone,
    v_party, v_local::DATE, v_local::TIME, '23:59', v_zones, v_note,
    'waiting', p_quoted_min)
  ON CONFLICT (client_uuid) DO NOTHING
  RETURNING id INTO v_id;

  -- Повтор после таймаута: запись уже есть, и это успех, а не ошибка
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM waitlist_entries WHERE client_uuid = p_client_uuid;
  END IF;

  RETURN json_build_object('waitlist_id', v_id);
END $$;

REVOKE ALL ON FUNCTION add_waitlist_entry_web(UUID, UUID, TEXT, TEXT, INTEGER, INTEGER, UUID[], TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION add_waitlist_entry_web(UUID, UUID, TEXT, TEXT, INTEGER, INTEGER, UUID[], TEXT)
  TO authenticated;

COMMENT ON FUNCTION add_waitlist_entry_web(UUID, UUID, TEXT, TEXT, INTEGER, INTEGER, UUID[], TEXT) IS
  'Записать гостя в очередь из кабинета (137): идемпотентно по client_uuid, окно — «сегодня с этой минуты».';

-- ── 2. Посадить гостя из очереди ─────────────────────────────
/**
 * Стол освободился — гостя сажают. Бронь создаётся сразу посаженной
 * (`arrived_at = NOW()`), потому что человек уже здесь и стоит у стойки.
 *
 * Столы подбирает сервер тем же `_pick_tables`, что и гостевой путь.
 * Хостес может назвать столы сам — но занятость всё равно проверяется
 * здесь, а не на экране: сетка у соседа за ноутбуком может отставать на
 * минуту, и этой минуты хватает на двойную посадку.
 *
 * Запись закрывается статусом `converted` и ссылкой на визит: очередь
 * должна помнить, чем закончилось ожидание.
 */
CREATE OR REPLACE FUNCTION seat_waitlist_entry_web(
  p_location_id UUID,
  p_id          UUID,
  p_table_ids   UUID[] DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_w      waitlist_entries%ROWTYPE;
  v_loc    locations%ROWTYPE;
  v_rsv    JSONB;
  v_dur    INTEGER;
  v_buf    INTEGER;
  v_comb   BOOLEAN;
  v_zone   UUID;
  v_tables UUID[] := COALESCE(p_table_ids, '{}');
  v_table  UUID;
  v_at     TIMESTAMPTZ := NOW();
  v_id     UUID;
BEGIN
  SELECT * INTO v_w FROM waitlist_entries
  WHERE id = p_id AND location_id = p_location_id AND org_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  -- Уже посаженного не сажают дважды: вторая бронь заняла бы ещё стол
  IF v_w.status NOT IN ('waiting', 'offered') THEN
    RAISE EXCEPTION 'already_closed';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  v_rsv  := COALESCE(v_loc.settings -> 'reservations', '{}'::jsonb);
  v_dur  := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buf  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);
  v_comb := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_zone := CASE WHEN cardinality(v_w.zone_ids) = 1 THEN v_w.zone_ids[1] END;

  IF cardinality(v_tables) = 0 THEN
    v_tables := _pick_tables(p_location_id, v_w.party_size, v_at,
                             v_dur, v_buf, v_comb, NULL, v_zone);
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
      IF NOT _table_free(v_table, v_at, v_dur, v_buf, NULL) THEN
        RAISE EXCEPTION 'table_busy';
      END IF;
    END LOOP;
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, duration_min, table_id, hold_table_ids,
      status, auto, decided_at, decided_by_member, note, arrived_at, created_via)
    VALUES (
      v_org, p_location_id, gen_random_uuid(), v_w.customer_name,
      v_w.customer_phone, v_w.party_size, v_at, v_dur, v_tables[1],
      COALESCE(v_tables[2:array_length(v_tables, 1)], '{}'::UUID[]),
      'confirmed', FALSE, NOW(), v_member, v_w.note, NOW(), 'waitlist')
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'table_busy';
  END;

  UPDATE waitlist_entries
  SET status = 'converted', reservation_id = v_id, offer_token = NULL
  WHERE id = p_id;

  RETURN json_build_object('reservation_id', v_id, 'table_id', v_tables[1]);
END $$;

REVOKE ALL ON FUNCTION seat_waitlist_entry_web(UUID, UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION seat_waitlist_entry_web(UUID, UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION seat_waitlist_entry_web(UUID, UUID, UUID[]) IS
  'Посадить гостя из очереди (137): визит создаётся сразу посаженным, занятость проверяет сервер, запись закрывается converted.';

-- ── 3. Переставить очередь ───────────────────────────────────
/**
 * Порядок «кого зовём следующим» — решение хостес, а не арифметика:
 * двоих посадить проще, чем шестерых, а гость с ребёнком ждёт хуже.
 *
 * Перестановка затрагивает только тех, кто ещё ждёт. Посаженные и
 * ушедшие в порядке не участвуют: их место в истории уже определено.
 */
CREATE OR REPLACE FUNCTION reorder_waitlist_web(
  p_location_id UUID,
  p_ids         UUID[]
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_count  INTEGER := 0;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 200 THEN
    RAISE EXCEPTION 'too_many';
  END IF;

  UPDATE waitlist_entries w
  SET position = ord.n
  FROM (SELECT id, ROW_NUMBER() OVER () AS n FROM unnest(p_ids) AS id) ord
  WHERE w.id = ord.id
    AND w.org_id = v_org
    AND w.location_id = p_location_id
    AND w.status IN ('waiting', 'offered');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION reorder_waitlist_web(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reorder_waitlist_web(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION reorder_waitlist_web(UUID, UUID[]) IS
  'Переставить очередь ожидания (137): позиции 1..N по переданному порядку, только для ждущих.';

-- ── 4. Убрать из очереди и вернуть обратно ───────────────────
/**
 * Гость ушёл, не дождавшись, — запись закрывается. Это не удаление:
 * сколько людей ушло, не дождавшись, и есть главный вопрос к очереди, и
 * стирать эти строки значит стирать ответ на него.
 *
 * Обратный переход разрешён только из `cancelled`: вернуть в очередь
 * ошибочно убранного нужно, а «расконвертировать» посаженного визита
 * нельзя — за ним уже стоит бронь.
 */
CREATE OR REPLACE FUNCTION set_waitlist_status_web(
  p_location_id UUID,
  p_id          UUID,
  p_status      TEXT
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_w      waitlist_entries%ROWTYPE;
BEGIN
  IF p_status NOT IN ('cancelled', 'waiting') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  SELECT * INTO v_w FROM waitlist_entries
  WHERE id = p_id AND location_id = p_location_id AND org_id = v_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_status = 'cancelled' AND v_w.status NOT IN ('waiting', 'offered') THEN
    RAISE EXCEPTION 'already_closed';
  END IF;
  IF p_status = 'waiting' AND v_w.status <> 'cancelled' THEN
    RAISE EXCEPTION 'already_closed';
  END IF;

  UPDATE waitlist_entries
  SET status = p_status,
      -- Возврат в очередь снимает протухшее предложение: звать по нему
      -- уже нельзя, а ссылка у гостя не должна остаться рабочей.
      offer_token = CASE WHEN p_status = 'waiting' THEN NULL ELSE offer_token END,
      offer_at = CASE WHEN p_status = 'waiting' THEN NULL ELSE offer_at END,
      offer_expires = CASE WHEN p_status = 'waiting' THEN NULL ELSE offer_expires END
  WHERE id = p_id;

  RETURN json_build_object('waitlist_id', p_id, 'status', p_status);
END $$;

REVOKE ALL ON FUNCTION set_waitlist_status_web(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_waitlist_status_web(UUID, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION set_waitlist_status_web(UUID, UUID, TEXT) IS
  'Убрать гостя из очереди или вернуть обратно (137). Записи не удаляются: ушедшие без стола — ответ на главный вопрос к очереди.';

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only. Колонки и функции добавляются, ничего не удаляется;
-- гостевой путь 122 не изменён и продолжает работать сам по себе.
--
-- Проверка на целевой базе:
--   SELECT status, COUNT(*), COUNT(position) AS reordered,
--          COUNT(quoted_min) AS quoted
--   FROM waitlist_entries GROUP BY 1;
-- ============================================================
