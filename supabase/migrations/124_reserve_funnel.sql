-- ============================================================
-- 124 RESERVE FUNNEL — воронка гостевой брони и атрибуция канала.
--
-- МОТИВ. Про бронь известно ровно одно: сколько заявок пришло. Сколько
-- человек открыли страницу и ушли, на каком шаге, какого времени им не
-- хватило и откуда они вообще пришли — не знает никто. Владелец не может
-- ответить ни на «работает ли QR на столах», ни на «стоит ли открываться
-- в понедельник»: данных нет, есть только результат.
--
-- Здесь появляется то, чего нет ни в одной таблице: ДОВРАЧЕБНАЯ часть
-- пути — открытие страницы, запрос доступности, пустая выдача, выбор
-- слота, начало формы. Всё, что ПОСЛЕ отправки (подтверждена, отменена,
-- не пришёл, завершена), уже авторитетно живёт в `reservations`, и
-- копировать его сюда нельзя: две копии статуса разойдутся, и отчёт
-- начнёт спорить сам с собой. Поэтому событий терминальных статусов тут
-- НЕТ — отчёт (125) соединит воронку с бронями по `reservation_id`.
--
-- Атрибуция хранится ДВАЖДЫ и намеренно:
--   * в событии — чтобы посчитать конверсию канала целиком, включая тех,
--     кто до брони не дошёл (иначе канал измерялся бы только победами);
--   * колонками в `reservations` — чтобы отчёт по источникам работал даже
--     после чистки событий и не зависел от того, дошло ли событие вообще.
--
-- Ключевое соглашение: трекинг НИКОГДА не влияет на бронь. Выключенный
-- продукт, превышенный лимит, битые параметры — всё это тихо возвращает
-- ноль, а не ошибку. Гость не должен потерять стол из-за аналитики.
--
-- Крона нет (соглашение 103): старые события подчищаются оппортунистически
-- внутри самого трекинга.
--
-- ⚠️ ТРЕБУЕТ 053 (reservations), 103/105 (capabilities).
-- ============================================================

-- ── 1. Атрибуция на самой броне ──────────────────────────────
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS utm JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN reservations.source IS
  'Нормализованный канал привода гостя (124): qr, table, site, link, instagram, facebook, google, direct…';
COMMENT ON COLUMN reservations.utm IS
  'Исходные utm-метки как пришли со страницы (124). source — их нормализация, utm — первоисточник для разбора кампаний.';

CREATE INDEX IF NOT EXISTS idx_reservations_source
  ON reservations(location_id, source, reserved_at) WHERE source IS NOT NULL;

-- ── 2. Нормализация канала ───────────────────────────────────
/**
 * Один канал из двух источников правды: явного `src` в ссылке (его ставим
 * мы — QR столов, печатные материалы, кнопка на сайте) и utm_source
 * (его ставит рекламная площадка).
 *
 * Явный `src` сильнее: ссылку с QR-стола заведение печатает само, и она
 * не должна теряться из-за того, что гость пришёл по ней из Instagram.
 * Результат чистится до [a-z0-9_-] и 24 символов: значение попадает в
 * группировку отчёта, а не в текст, и мусор из адреса там не нужен.
 */
CREATE OR REPLACE FUNCTION normalize_reserve_source(p_src TEXT, p_utm JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_raw TEXT;
BEGIN
  v_raw := NULLIF(btrim(COALESCE(p_src, '')), '');
  IF v_raw IS NULL AND jsonb_typeof(p_utm) = 'object' THEN
    v_raw := NULLIF(btrim(COALESCE(p_utm ->> 'source', '')), '');
  END IF;
  IF v_raw IS NULL THEN
    RETURN 'direct';
  END IF;

  v_raw := lower(regexp_replace(v_raw, '[^a-zA-Z0-9_-]', '', 'g'));
  IF v_raw = '' THEN
    RETURN 'direct';
  END IF;

  -- Синонимы площадок сводятся к одному имени: иначе отчёт покажет ig и
  -- instagram отдельными каналами и разделит их конверсию пополам.
  RETURN CASE
    WHEN v_raw IN ('ig', 'insta', 'instagram') THEN 'instagram'
    WHEN v_raw IN ('fb', 'facebook', 'meta')   THEN 'facebook'
    WHEN v_raw IN ('google', 'gmb', 'maps')    THEN 'google'
    WHEN v_raw IN ('wa', 'whatsapp')           THEN 'whatsapp'
    WHEN v_raw IN ('tg', 'telegram')           THEN 'telegram'
    ELSE left(v_raw, 24)
  END;
END $$;

REVOKE ALL ON FUNCTION normalize_reserve_source(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION normalize_reserve_source(TEXT, JSONB) TO authenticated, service_role;

-- ── 3. События воронки ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservation_funnel_events (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Вкладка гостя. Живёт от открытия страницы до отправки заявки —
  -- анонимна, к телефону и имени не привязана.
  session_id     UUID NOT NULL,
  step           TEXT NOT NULL CHECK (step IN (
                   'page_view',      -- страница брони открыта
                   'availability',   -- запрошена доступность даты и компании
                   'no_slots',       -- на дату и компанию свободного времени нет
                   'slot_selected',  -- время выбрано, гость идёт к контактам
                   'form_started',   -- начал заполнять контакты
                   'submitted',      -- заявка ушла на сервер
                   'waitlisted')),   -- слота не нашлось, встал в лист ожидания
  at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source         TEXT,
  utm            JSONB NOT NULL DEFAULT '{}'::jsonb,
  party_size     INTEGER,
  -- Дата и время, которые гость ХОТЕЛ. Для шага no_slots это и есть
  -- «самые спрашиваемые недоступные окна» из плана: спрос, который
  -- заведение сегодня не видит вообще.
  wanted_date    DATE,
  wanted_time    TIME,
  zone_id        UUID,
  reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL
);

COMMENT ON TABLE reservation_funnel_events IS
  'Воронка гостевой брони ДО отправки (124). Терминальных статусов здесь нет: они авторитетно живут в reservations, вторая копия разошлась бы.';

/**
 * Одна строка на осмысленный шаг, а не лог кликов.
 *
 * Ключ включает дату и компанию: page_view и form_started случаются раз
 * за сессию (там оба поля пусты), а availability и no_slots — по разу на
 * каждую пару «дата + число гостей». Именно это и нужно отчёту: гость,
 * перебравший пять дней и не нашедший стол, должен дать пять строк
 * неудовлетворённого спроса, а не одну и не пятьдесят.
 */
CREATE UNIQUE INDEX IF NOT EXISTS reservation_funnel_dedupe
  ON reservation_funnel_events (
    session_id, step,
    COALESCE(wanted_date, DATE 'epoch'),
    COALESCE(party_size, 0));

CREATE INDEX IF NOT EXISTS idx_funnel_location_at
  ON reservation_funnel_events (location_id, at);
CREATE INDEX IF NOT EXISTS idx_funnel_reservation
  ON reservation_funnel_events (reservation_id) WHERE reservation_id IS NOT NULL;

ALTER TABLE reservation_funnel_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY reservation_funnel_events_select ON reservation_funnel_events
  FOR SELECT TO authenticated USING (org_id = auth_org_id());

REVOKE ALL ON reservation_funnel_events FROM anon;
REVOKE INSERT, UPDATE, DELETE ON reservation_funnel_events FROM authenticated;
GRANT SELECT ON reservation_funnel_events TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE reservation_funnel_events_id_seq TO service_role;

-- ── 4. Приём события ─────────────────────────────────────────
/**
 * Записать шаг воронки. Вызывается Edge Function `public-reserve` под
 * service_role: у гостя прямого доступа к таблице нет.
 *
 * Возвращает 1, если строка добавлена, и 0 во всех остальных случаях —
 * включая отказы. Исключений НЕТ ни на одном пути: аналитика не имеет
 * права уронить бронирование, а гостю нечего сообщать про телеметрию.
 *
 * Шаг 'submitted' с `p_reservation_id` попутно проставляет атрибуцию на
 * саму бронь — тем же вызовом, чтобы не появился второй сетевой поход,
 * который может не дойти.
 */
CREATE OR REPLACE FUNCTION track_reserve_event(
  p_location_id    UUID,
  p_session_id     UUID,
  p_step           TEXT,
  p_src            TEXT DEFAULT NULL,
  p_utm            JSONB DEFAULT '{}'::jsonb,
  p_party_size     INTEGER DEFAULT NULL,
  p_wanted_date    DATE DEFAULT NULL,
  p_wanted_time    TIME DEFAULT NULL,
  p_zone_id        UUID DEFAULT NULL,
  p_reservation_id UUID DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org    UUID;
  v_source TEXT;
  v_utm    JSONB;
  v_added  INTEGER;
BEGIN
  IF p_location_id IS NULL OR p_session_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT org_id INTO v_org FROM locations WHERE id = p_location_id;
  IF v_org IS NULL THEN
    RETURN 0;
  END IF;

  -- Продукт не подключён — не собираем ничего. Страница гостя в этом
  -- случае и так закрыта гейтом 105.
  IF NOT org_has_capability(v_org, 'public_reservations') THEN
    RETURN 0;
  END IF;

  -- Потолок на сессию: вкладка гостя физически не может пройти воронку
  -- сорок раз. Всё сверху — либо скрипт, либо ошибка клиента.
  IF (SELECT COUNT(*) FROM reservation_funnel_events
      WHERE session_id = p_session_id) >= 40 THEN
    RETURN 0;
  END IF;

  -- Потолок на точку в час: публичный эндпоинт без авторизации, и
  -- набивать им таблицу должно быть невыгодно.
  IF (SELECT COUNT(*) FROM reservation_funnel_events
      WHERE location_id = p_location_id AND at > NOW() - INTERVAL '1 hour') >= 5000 THEN
    RETURN 0;
  END IF;

  v_utm := CASE WHEN jsonb_typeof(p_utm) = 'object' THEN p_utm ELSE '{}'::jsonb END;
  v_source := normalize_reserve_source(p_src, v_utm);

  INSERT INTO reservation_funnel_events (
    org_id, location_id, session_id, step, source, utm,
    party_size, wanted_date, wanted_time, zone_id, reservation_id)
  VALUES (
    v_org, p_location_id, p_session_id, p_step, v_source, v_utm,
    NULLIF(GREATEST(COALESCE(p_party_size, 0), 0), 0),
    p_wanted_date, p_wanted_time, p_zone_id, p_reservation_id)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_added = ROW_COUNT;

  -- Атрибуция брони проставляется один раз и только пустая: повторный
  -- трекинг того же submit не должен переписывать канал.
  IF p_step = 'submitted' AND p_reservation_id IS NOT NULL THEN
    UPDATE reservations
    SET source = v_source, utm = v_utm
    WHERE id = p_reservation_id
      AND location_id = p_location_id
      AND source IS NULL;
  END IF;

  -- Чистка без крона: раз примерно в сто вызовов сносим то, что старше
  -- полугода. Отчётный горизонт продукта — год по броням и полгода по
  -- воронке; хранить сырые шаги дольше незачем.
  IF random() < 0.01 THEN
    DELETE FROM reservation_funnel_events
    WHERE location_id = p_location_id AND at < NOW() - INTERVAL '180 days';
  END IF;

  RETURN v_added;
EXCEPTION WHEN OTHERS THEN
  -- Битый шаг, чужая зона, гонка индекса — что угодно. Бронь важнее
  -- события: молчим и отдаём ноль.
  RETURN 0;
END $$;

REVOKE ALL ON FUNCTION track_reserve_event(
  UUID, UUID, TEXT, TEXT, JSONB, INTEGER, DATE, TIME, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION track_reserve_event(
  UUID, UUID, TEXT, TEXT, JSONB, INTEGER, DATE, TIME, UUID, UUID) TO service_role;

COMMENT ON FUNCTION track_reserve_event(
  UUID, UUID, TEXT, TEXT, JSONB, INTEGER, DATE, TIME, UUID, UUID) IS
  'Шаг воронки брони (124). Никогда не бросает исключений: аналитика не может уронить бронирование. Возвращает 1, если строка добавлена.';

-- ── Проверка после применения ────────────────────────────────
--   SELECT track_reserve_event('<loc>', gen_random_uuid(), 'page_view', 'qr');   -- 1
--   SELECT track_reserve_event('<loc>', '<same session>', 'page_view', 'qr');    -- 0 (дубль)
--   SELECT step, source, COUNT(*) FROM reservation_funnel_events
--     WHERE location_id = '<loc>' GROUP BY 1, 2;
-- Откат: DROP TABLE reservation_funnel_events; DROP FUNCTION track_reserve_event,
-- normalize_reserve_source; колонки reservations.source/utm оставить —
-- они уже несут историю и ничего не ломают.
