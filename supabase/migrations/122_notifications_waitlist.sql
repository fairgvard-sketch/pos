-- ============================================================
-- 122 NOTIFICATIONS + WAITLIST — очередь уведомлений без провайдера
-- и лист ожидания для освободившихся столов.
--
-- ПРОВАЙДЕРА ПОЧТЫ В ПРОЕКТЕ НЕТ. Проверено: ни Resend/SendGrid/SMTP,
-- ни функции отправки. Поэтому здесь строится ТОЛЬКО очередь и доменные
-- события, а адаптер доставки остаётся явно выключенным: запись уходит в
-- статус `skipped` с причиной `no_provider`. Делать вид, что письмо
-- отправлено, нельзя — заведение будет считать, что гостя предупредили.
-- Когда провайдер появится, включается ОДНА функция-диспетчер, а события
-- и шаблоны уже накоплены и протестированы.
--
-- КРОНА НЕТ — по соглашению 103: просрочка оценивается в момент запроса.
-- Поэтому «пора напомнить» и «предложение истекло» считаются функциями,
-- которые зовёт стол хостес, а не фоновым процессом, которого некому
-- чинить в три часа ночи.
--
-- ЛИСТ ОЖИДАНИЯ. Гость, которому не нашлось слота, оставляет пожелание
-- (дата, диапазон времени, гости, зоны). Освободился стол — хостес видит
-- подходящие записи и отправляет предложение с ограниченным сроком.
-- Предложение не бронирует стол: бронь создаётся ТОЛЬКО когда гость
-- согласился, и слот перепроверяется в этот момент. Иначе лист ожидания
-- сам стал бы источником фантомной занятости.
--
-- ⚠️ ТРЕБУЕТ 117 (reservation_bookable_at), 119 (_table_free v3),
--    121 (upsert_guest_by_phone-связка).
-- ============================================================

-- ── 1. Очередь уведомлений ───────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id  UUID REFERENCES locations(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'reservation_confirmed', 'reservation_reminder',
                 'reservation_cancelled', 'waitlist_offer')),
  channel      TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'sms')),
  recipient    TEXT,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Идемпотентность: одно событие = одна запись. Повторный вызов
  -- (ретрай, двойное нажатие, replay) не создаёт второе сообщение.
  dedupe_key   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON notification_outbox(org_id, created_at) WHERE status = 'pending';

ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_outbox_select ON notification_outbox
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

REVOKE ALL ON notification_outbox FROM anon;
REVOKE INSERT, UPDATE, DELETE ON notification_outbox FROM authenticated;
GRANT SELECT ON notification_outbox TO authenticated, service_role;

COMMENT ON TABLE notification_outbox IS
  'Очередь уведомлений (122), нейтральная к провайдеру. Пока провайдера нет, записи получают статус skipped с причиной no_provider — отправка не имитируется.';

/**
 * Настроен ли канал доставки. Сейчас всегда FALSE: провайдера в проекте
 * нет. Функция существует, чтобы включение было ОДНОЙ правкой, а не
 * поиском по коду; и чтобы тесты могли зафиксировать текущее состояние.
 */
CREATE OR REPLACE FUNCTION notification_provider_ready(p_channel TEXT DEFAULT 'email')
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT FALSE
$$;

COMMENT ON FUNCTION notification_provider_ready(TEXT) IS
  'Есть ли рабочий адаптер доставки. FALSE, пока провайдер не подключён: см. шапку миграции 122.';

REVOKE ALL ON FUNCTION notification_provider_ready(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION notification_provider_ready(TEXT) TO authenticated, service_role;

/**
 * Поставить событие в очередь. Идемпотентно по `dedupe_key`: повтор
 * возвращает id уже существующей записи, а не создаёт вторую.
 *
 * Без провайдера запись сразу получает `skipped` — очередь не копит
 * «pending», который никто не разберёт, и по ней видно ровно то, что
 * произошло: событие случилось, отправить было нечем.
 */
CREATE OR REPLACE FUNCTION enqueue_notification(
  p_org_id      UUID,
  p_location_id UUID,
  p_kind        TEXT,
  p_recipient   TEXT,
  p_payload     JSONB,
  p_dedupe_key  TEXT,
  p_channel     TEXT DEFAULT 'email'
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id    UUID;
  v_ready BOOLEAN := notification_provider_ready(p_channel);
BEGIN
  INSERT INTO notification_outbox (
    org_id, location_id, kind, channel, recipient, payload, dedupe_key,
    status, last_error)
  VALUES (
    p_org_id, p_location_id, p_kind, p_channel,
    NULLIF(TRIM(COALESCE(p_recipient, '')), ''),
    COALESCE(p_payload, '{}'::jsonb), p_dedupe_key,
    CASE WHEN v_ready THEN 'pending' ELSE 'skipped' END,
    CASE WHEN v_ready THEN NULL ELSE 'no_provider' END)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM notification_outbox WHERE dedupe_key = p_dedupe_key;
  END IF;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION enqueue_notification(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION enqueue_notification(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT)
  TO authenticated, service_role;

-- Событие «бронь подтверждена» — триггером, а не телом RPC: подтвердить
-- бронь можно из кассы, из кабинета и мгновенным режимом, и событие
-- должно возникать во всех трёх случаях одинаково.
CREATE OR REPLACE FUNCTION _notify_reservation_confirmed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed') THEN
    PERFORM enqueue_notification(
      NEW.org_id, NEW.location_id, 'reservation_confirmed',
      NEW.customer_phone,
      jsonb_build_object(
        'reservation_id', NEW.id,
        'public_token',   NEW.public_token,
        'reserved_at',    NEW.reserved_at,
        'party_size',     NEW.party_size,
        'guest_name',     NEW.customer_name),
      -- Ключ включает время визита: перенесённая бронь — новое событие,
      -- а повторное подтверждение того же времени — нет.
      'rsv_confirmed:' || NEW.id::TEXT || ':'
        || EXTRACT(EPOCH FROM NEW.reserved_at)::BIGINT::TEXT);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_notify_reservation_confirmed ON reservations;
CREATE TRIGGER trg_notify_reservation_confirmed
  AFTER INSERT OR UPDATE OF status, reserved_at ON reservations
  FOR EACH ROW EXECUTE FUNCTION _notify_reservation_confirmed();

-- ── 2. Просьба подтвердить приход ────────────────────────────
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirm_requested_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN reservations.guest_confirmed_at IS
  'Гость подтвердил, что придёт (122). Ставится с его страницы брони; хостес видит статус на таймлайне.';

/**
 * Поставить в очередь просьбы подтвердить приход по всем броням, до
 * которых осталось меньше окна `confirm_window_h` (настройка точки,
 * дефолт 24 часа). Зовётся столом хостес при открытии дня — крона нет.
 * Идемпотентна: у брони проставляется `confirm_requested_at`, повторный
 * вызов её не трогает, а dedupe-ключ страхует со стороны очереди.
 */
CREATE OR REPLACE FUNCTION request_reservation_confirmations(p_location_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID := auth_org_id();
  v_window INTEGER;
  v_r      RECORD;
  v_count  INTEGER := 0;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT GREATEST(1, LEAST(168,
           COALESCE((settings -> 'reservations' ->> 'confirm_window_h')::INTEGER, 24)))
  INTO v_window
  FROM locations WHERE id = p_location_id AND org_id = v_org;
  IF v_window IS NULL THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  FOR v_r IN
    SELECT * FROM reservations
    WHERE location_id = p_location_id
      AND org_id = v_org
      AND status = 'confirmed'
      AND confirm_requested_at IS NULL
      AND guest_confirmed_at IS NULL
      AND reserved_at > NOW()
      AND reserved_at <= NOW() + make_interval(hours => v_window)
      AND LENGTH(COALESCE(customer_phone, '')) >= 6
  LOOP
    PERFORM enqueue_notification(
      v_r.org_id, v_r.location_id, 'reservation_reminder',
      v_r.customer_phone,
      jsonb_build_object(
        'reservation_id', v_r.id,
        'public_token',   v_r.public_token,
        'reserved_at',    v_r.reserved_at,
        'guest_name',     v_r.customer_name),
      'rsv_reminder:' || v_r.id::TEXT || ':'
        || EXTRACT(EPOCH FROM v_r.reserved_at)::BIGINT::TEXT);

    UPDATE reservations SET confirm_requested_at = NOW() WHERE id = v_r.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION request_reservation_confirmations(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_reservation_confirmations(UUID)
  TO authenticated, service_role;

/**
 * Гость подтверждает приход со своей страницы брони. Ключ — тот же
 * секрет ссылки (118). Идемпотентно.
 */
CREATE OR REPLACE FUNCTION confirm_reservation_attendance(p_key UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_r FROM reservations
  WHERE public_token = p_key OR client_uuid = p_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT org_has_capability(v_r.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  IF v_r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'not_active';
  END IF;

  IF v_r.guest_confirmed_at IS NULL THEN
    UPDATE reservations SET guest_confirmed_at = NOW() WHERE id = v_r.id;
  END IF;

  RETURN json_build_object('confirmed', TRUE);
END $$;

REVOKE ALL ON FUNCTION confirm_reservation_attendance(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION confirm_reservation_attendance(UUID) TO service_role;

-- ── 3. Лист ожидания ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  client_uuid    UUID NOT NULL UNIQUE,
  guest_id       UUID REFERENCES guests(id),
  customer_name  TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  party_size     INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 200),
  -- Пожелание: дата и приемлемый диапазон времени в зоне точки
  wanted_date    DATE NOT NULL,
  time_from      TIME NOT NULL,
  time_to        TIME NOT NULL,
  -- Приемлемые зоны; пусто = любая
  zone_ids       UUID[] NOT NULL DEFAULT '{}',
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'waiting'
                   CHECK (status IN ('waiting', 'offered', 'converted', 'expired', 'cancelled')),
  -- Предложение: секрет ссылки и срок. Стол НЕ держится — бронь
  -- создаётся только при согласии гостя.
  offer_token    UUID,
  offer_at       TIMESTAMPTZ,
  offer_expires  TIMESTAMPTZ,
  reservation_id UUID REFERENCES reservations(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_offer_token_key
  ON waitlist_entries(offer_token) WHERE offer_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_waitlist_open
  ON waitlist_entries(location_id, wanted_date) WHERE status IN ('waiting', 'offered');

ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY waitlist_select ON waitlist_entries
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

REVOKE ALL ON waitlist_entries FROM anon;
REVOKE INSERT, UPDATE, DELETE ON waitlist_entries FROM authenticated;
GRANT SELECT ON waitlist_entries TO authenticated, service_role;

COMMENT ON TABLE waitlist_entries IS
  'Лист ожидания (122): пожелание гостя, которому не нашлось слота. Предложение стола не держит — бронь создаётся только при согласии, слот перепроверяется в этот момент.';

/**
 * Просрочка листа считается в момент чтения, крона нет (соглашение 103).
 * Предложение, на которое гость не ответил, возвращает запись в
 * ожидание — гость не виноват, что не успел, и терять его нельзя.
 */
CREATE OR REPLACE FUNCTION _expire_waitlist_offers(p_location_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE waitlist_entries
  SET status = 'waiting', offer_token = NULL, offer_at = NULL, offer_expires = NULL
  WHERE location_id = p_location_id
    AND status = 'offered'
    AND offer_expires < NOW();
$$;

-- ── 4. Гость встаёт в лист ожидания ──────────────────────────
CREATE OR REPLACE FUNCTION submit_waitlist(
  p_location_id UUID,
  p_client_uuid UUID,
  p_name        TEXT,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_date        DATE,
  p_from        TIME,
  p_to          TIME,
  p_zone_ids    UUID[] DEFAULT '{}',
  p_note        TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_existing waitlist_entries%ROWTYPE;
  v_name     TEXT := LEFT(TRIM(COALESCE(p_name, '')), 60);
  v_phone    TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_note     TEXT := NULLIF(LEFT(TRIM(COALESCE(p_note, '')), 200), '');
  v_sch      JSONB;
  v_zone     UUID;
  v_id       UUID;
BEGIN
  SELECT * INTO v_existing FROM waitlist_entries WHERE client_uuid = p_client_uuid;
  IF FOUND THEN
    RETURN json_build_object('waitlist_id', v_existing.id, 'duplicate', TRUE,
                             'status', v_existing.status);
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;
  IF NOT org_has_capability(v_loc.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  IF NOT COALESCE((v_loc.settings -> 'reservations' ->> 'enabled')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'disabled';
  END IF;
  -- Лист ожидания включается отдельно: заведение, которое не собирается
  -- перезванивать, не должно копить обещания.
  IF NOT COALESCE((v_loc.settings -> 'reservations' ->> 'waitlist')::BOOLEAN, FALSE) THEN
    RAISE EXCEPTION 'waitlist_disabled';
  END IF;

  IF LENGTH(v_name) < 1 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  IF LENGTH(v_phone) < 9 OR LENGTH(v_phone) > 15 THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;
  IF p_party_size IS NULL OR p_party_size < 1 OR p_party_size > 200 THEN
    RAISE EXCEPTION 'invalid_party';
  END IF;
  IF p_date IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;

  -- Дата должна лежать в горизонте записи: обещать «когда-нибудь» нельзя.
  v_sch := reservation_schedule(v_loc.settings);
  IF p_date > (NOW() + make_interval(days => (v_sch ->> 'horizon_days')::INTEGER))::DATE THEN
    RAISE EXCEPTION 'invalid_time';
  END IF;

  FOREACH v_zone IN ARRAY COALESCE(p_zone_ids, '{}') LOOP
    IF NOT EXISTS (
      SELECT 1 FROM table_zones
      WHERE id = v_zone AND location_id = p_location_id AND is_active
    ) THEN
      RAISE EXCEPTION 'invalid_zone';
    END IF;
  END LOOP;

  -- Анти-спам как у брони (053): та же логика, тот же порядок величин.
  IF (SELECT COUNT(*) FROM waitlist_entries
      WHERE customer_phone = v_phone AND created_at > NOW() - INTERVAL '15 minutes') >= 3 THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT COUNT(*) FROM waitlist_entries
      WHERE location_id = p_location_id AND status = 'waiting') >= 100 THEN
    RAISE EXCEPTION 'busy';
  END IF;

  INSERT INTO waitlist_entries (
    org_id, location_id, client_uuid, guest_id, customer_name, customer_phone,
    party_size, wanted_date, time_from, time_to, zone_ids, note)
  VALUES (
    v_loc.org_id, p_location_id, p_client_uuid,
    upsert_guest_by_phone(v_loc.org_id, v_phone, v_name),
    v_name, v_phone, p_party_size, p_date, p_from, p_to,
    COALESCE(p_zone_ids, '{}'), v_note)
  RETURNING id INTO v_id;

  RETURN json_build_object('waitlist_id', v_id, 'duplicate', FALSE, 'status', 'waiting');
END $$;

REVOKE ALL ON FUNCTION submit_waitlist(UUID, UUID, TEXT, TEXT, INTEGER, DATE, TIME, TIME, UUID[], TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_waitlist(UUID, UUID, TEXT, TEXT, INTEGER, DATE, TIME, TIME, UUID[], TEXT)
  TO service_role;

-- ── 5. Подбор под освободившийся слот ────────────────────────
/**
 * Кого можно позвать на освободившееся время. Совпадение по дате,
 * диапазону, вместимости и зоне; порядок — по очереди (кто раньше встал).
 * Проверяется и реальная возможность посадить: предлагать слот, на
 * который нет свободного стола, значит обманывать дважды.
 */
CREATE OR REPLACE FUNCTION waitlist_matches(
  p_location_id UUID,
  p_at          TIMESTAMPTZ,
  p_limit       INTEGER DEFAULT 10
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_loc   locations%ROWTYPE;
  v_local TIMESTAMP;
  v_dur   INTEGER;
  v_buf   INTEGER;
  v_comb  BOOLEAN;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  SELECT * INTO v_loc FROM locations WHERE id = p_location_id AND org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  PERFORM _expire_waitlist_offers(p_location_id);

  v_local := p_at AT TIME ZONE COALESCE(NULLIF(v_loc.timezone, ''), 'Asia/Jerusalem');
  v_dur   := COALESCE((v_loc.settings -> 'reservations' ->> 'duration_min')::INTEGER, 90);
  v_buf   := COALESCE((v_loc.settings -> 'reservations' ->> 'buffer_min')::INTEGER, 0);
  v_comb  := COALESCE((v_loc.settings -> 'reservations' ->> 'combine')::BOOLEAN, FALSE);

  RETURN COALESCE((
    SELECT jsonb_agg(m ORDER BY m.created_at)
    FROM (
      SELECT w.id, w.customer_name, w.customer_phone, w.party_size,
             w.note, w.created_at, w.status, w.zone_ids
      FROM waitlist_entries w
      WHERE w.location_id = p_location_id
        AND w.status = 'waiting'
        AND w.wanted_date = v_local::DATE
        AND v_local::TIME >= w.time_from
        AND v_local::TIME <= w.time_to
        -- Есть ли куда посадить именно эту компанию
        AND array_length(
              _pick_tables(p_location_id, w.party_size, p_at, v_dur, v_buf, v_comb,
                           NULL,
                           CASE WHEN cardinality(w.zone_ids) = 1 THEN w.zone_ids[1] END),
              1) IS NOT NULL
      ORDER BY w.created_at
      LIMIT GREATEST(1, LEAST(50, COALESCE(p_limit, 10)))
    ) m
  ), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION waitlist_matches(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION waitlist_matches(UUID, TIMESTAMPTZ, INTEGER)
  TO authenticated, service_role;

-- ── 6. Предложение гостю ─────────────────────────────────────
/**
 * Отправить предложение на конкретное время. Стол НЕ резервируется:
 * предложение — это приглашение, а не бронь. Срок ограничен
 * (`p_ttl_min`, дефолт 30 минут), после чего запись возвращается в
 * очередь сама.
 */
CREATE OR REPLACE FUNCTION offer_waitlist_slot(
  p_id      UUID,
  p_at      TIMESTAMPTZ,
  p_ttl_min INTEGER DEFAULT 30
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   UUID := auth_org_id();
  v_w     waitlist_entries%ROWTYPE;
  v_loc   locations%ROWTYPE;
  v_token UUID := gen_random_uuid();
  v_ttl   INTEGER := GREATEST(5, LEAST(1440, COALESCE(p_ttl_min, 30)));
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  SELECT * INTO v_w FROM waitlist_entries
  WHERE id = p_id AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_w.status NOT IN ('waiting', 'offered') THEN
    RAISE EXCEPTION 'not_active';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = v_w.location_id;
  IF NOT reservation_bookable_at(v_loc.settings, v_loc.timezone, p_at) THEN
    RAISE EXCEPTION 'outside_hours';
  END IF;

  UPDATE waitlist_entries
  SET status = 'offered', offer_token = v_token, offer_at = p_at,
      offer_expires = NOW() + make_interval(mins => v_ttl)
  WHERE id = p_id;

  PERFORM enqueue_notification(
    v_w.org_id, v_w.location_id, 'waitlist_offer', v_w.customer_phone,
    jsonb_build_object(
      'waitlist_id', v_w.id,
      'offer_token', v_token,
      'offer_at',    p_at,
      'expires_at',  NOW() + make_interval(mins => v_ttl),
      'guest_name',  v_w.customer_name),
    'wl_offer:' || v_w.id::TEXT || ':' || v_token::TEXT);

  RETURN json_build_object(
    'waitlist_id', p_id, 'offer_token', v_token,
    'expires_at', NOW() + make_interval(mins => v_ttl));
END $$;

REVOKE ALL ON FUNCTION offer_waitlist_slot(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION offer_waitlist_slot(UUID, TIMESTAMPTZ, INTEGER)
  TO authenticated, service_role;

-- ── 7. Гость принимает предложение ───────────────────────────
/**
 * Согласие гостя превращает предложение в бронь. Слот перепроверяется
 * ЗДЕСЬ: между отправкой и ответом стол мог занять кто угодно, и
 * предложение не даёт на него никаких прав. Истёкшее предложение
 * не действует.
 */
CREATE OR REPLACE FUNCTION accept_waitlist_offer(p_token UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_w      waitlist_entries%ROWTYPE;
  v_loc    locations%ROWTYPE;
  v_rsv    JSONB;
  v_dur    INTEGER;
  v_buf    INTEGER;
  v_comb   BOOLEAN;
  v_inst   BOOLEAN;
  v_zone   UUID;
  v_tables UUID[];
  v_table  UUID := NULL;
  v_hold   UUID[] := '{}';
  v_status TEXT := 'new';
  v_id     UUID;
  v_token  UUID;
BEGIN
  SELECT * INTO v_w FROM waitlist_entries WHERE offer_token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT org_has_capability(v_w.org_id, 'public_reservations') THEN
    RAISE EXCEPTION 'module_disabled';
  END IF;
  IF v_w.status <> 'offered' OR v_w.offer_expires < NOW() THEN
    RAISE EXCEPTION 'offer_expired';
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = v_w.location_id;
  v_rsv  := v_loc.settings -> 'reservations';
  v_dur  := COALESCE((v_rsv ->> 'duration_min')::INTEGER, 90);
  v_buf  := COALESCE((v_rsv ->> 'buffer_min')::INTEGER, 0);
  v_comb := COALESCE((v_rsv ->> 'combine')::BOOLEAN, FALSE);
  v_inst := COALESCE((v_rsv ->> 'instant')::BOOLEAN, FALSE);
  v_zone := CASE WHEN cardinality(v_w.zone_ids) = 1 THEN v_w.zone_ids[1] END;

  -- Время всё ещё в часах работы?
  IF NOT reservation_bookable_at(v_loc.settings, v_loc.timezone, v_w.offer_at) THEN
    RAISE EXCEPTION 'outside_hours';
  END IF;

  IF v_inst THEN
    v_tables := _pick_tables(v_w.location_id, v_w.party_size, v_w.offer_at,
                             v_dur, v_buf, v_comb, NULL, v_zone);
    IF array_length(v_tables, 1) IS NULL THEN
      -- Слот увели, пока гость думал. Запись возвращается в очередь:
      -- человек не виноват и место в ней не теряет.
      UPDATE waitlist_entries
      SET status = 'waiting', offer_token = NULL, offer_at = NULL, offer_expires = NULL
      WHERE id = v_w.id;
      RAISE EXCEPTION 'full_slot';
    END IF;
    v_table  := v_tables[1];
    v_hold   := v_tables[2:array_length(v_tables, 1)];
    v_status := 'confirmed';
  END IF;

  BEGIN
    INSERT INTO reservations (
      org_id, location_id, client_uuid, customer_name, customer_phone,
      party_size, reserved_at, note, duration_min, table_id, hold_table_ids,
      auto, status, decided_at, zone_id)
    VALUES (
      v_w.org_id, v_w.location_id, gen_random_uuid(), v_w.customer_name,
      v_w.customer_phone, v_w.party_size, v_w.offer_at, v_w.note, v_dur,
      v_table, COALESCE(v_hold, '{}'), v_inst, v_status,
      CASE WHEN v_inst THEN NOW() END, v_zone)
    RETURNING id, public_token INTO v_id, v_token;
  EXCEPTION WHEN exclusion_violation THEN
    UPDATE waitlist_entries
    SET status = 'waiting', offer_token = NULL, offer_at = NULL, offer_expires = NULL
    WHERE id = v_w.id;
    RAISE EXCEPTION 'full_slot';
  END;

  UPDATE waitlist_entries
  SET status = 'converted', reservation_id = v_id, offer_token = NULL
  WHERE id = v_w.id;

  RETURN json_build_object(
    'reservation_id', v_id, 'public_token', v_token, 'status', v_status);
END $$;

REVOKE ALL ON FUNCTION accept_waitlist_offer(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accept_waitlist_offer(UUID) TO service_role;

-- ============================================================
-- ОТКАТ / ВОССТАНОВЛЕНИЕ
--
-- Forward-only. Функциональный откат:
--   * лист ожидания выключается тумблером точки:
--       settings.reservations.waitlist = false (это и есть дефолт);
--   * события уведомлений перестают ставиться:
--       DROP TRIGGER trg_notify_reservation_confirmed ON reservations;
--   * очередь и записи листа при этом сохраняются.
--
-- ВКЛЮЧЕНИЕ ДОСТАВКИ, когда появится провайдер: переписать
-- `notification_provider_ready` (одна функция) и добавить Edge Function,
-- разбирающую `notification_outbox` со статусом `pending`. До тех пор
-- записи честно лежат в `skipped` / `no_provider`.
--
-- ПРОВЕРОЧНЫЕ ЗАПРОСЫ:
--   SELECT kind, status, last_error, COUNT(*) FROM notification_outbox
--   GROUP BY 1, 2, 3;
--   SELECT status, COUNT(*) FROM waitlist_entries GROUP BY 1;
-- ============================================================
