-- ============================================================
-- 158: жизненный цикл уведомления виден владельцу
--
-- ЗАЧЕМ.
--
-- Очередь (122, ужесточена 147) копит доменные события с июля, и в ней
-- есть статус, число попыток и последняя ошибка. Владелец не видел
-- НИЧЕГО из этого: в кабинете нет ни одного упоминания очереди. На
-- вопрос «гостю ушло подтверждение?» ответить было нельзя — ни «да»,
-- ни «нет», ни «нам нечем отправлять».
--
-- Последнее и есть правда: провайдера доставки в проекте нет,
-- `notification_provider_ready()` возвращает FALSE, и записи сразу
-- получают `skipped` с причиной `no_provider`. Это состояние обязано
-- быть НАЗВАНО в интерфейсе. Молчащая очередь и очередь, которой нечем
-- отправлять, выглядят одинаково, а означают разное.
--
-- ЧТО ДОБАВЛЕНО.
--
--   * снимок условий отправки: язык и часовой пояс точки на момент
--     постановки. Владелец правит и то, и другое; через месяц по
--     текущим настройкам не восстановить, на каком языке ушло письмо —
--     тот же инвариант, что у цен в заказе и правил визита (145);
--   * `provider_message_id` — идентификатор у провайдера. Без него
--     поддержка не может связать жалобу гостя с записью очереди;
--   * ограниченный повтор: `max_attempts` и `next_attempt_at`, чтобы
--     ретрай не крутился вечно;
--   * `consent` — что мы знаем о согласии на момент постановки.
--
-- ПРО СОГЛАСИЕ ЧЕСТНО.
--
-- Продукт согласия на рассылку НЕ СОБИРАЕТ ни в одном потоке. Поэтому
-- в снимок пишется `not_collected`, а не выдуманное `granted`: все
-- накопленные события транзакционные (подтверждение брони, напоминание
-- о визите), и граница «транзакционное / рекламное» определяется
-- israel-compliance.md и внешним консультантом, а не этой миграцией.
-- Поле заведено сейчас, чтобы в день подключения провайдера не
-- оказалось, что согласие негде хранить.
--
-- ⚠️ ТРЕБУЕТ 122 (notification_outbox), 147 (org-scope), 120
--    (_reservation_web_member).
-- ============================================================

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS lang                TEXT,
  ADD COLUMN IF NOT EXISTS timezone            TEXT,
  ADD COLUMN IF NOT EXISTS consent             TEXT NOT NULL DEFAULT 'not_collected',
  ADD COLUMN IF NOT EXISTS max_attempts        INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_attempt_at     TIMESTAMPTZ;

COMMENT ON COLUMN notification_outbox.lang IS
  'Язык точки на момент постановки (158). Снимок: владелец правит настройки, и по текущим не восстановить, на каком языке ушло сообщение.';
COMMENT ON COLUMN notification_outbox.consent IS
  'Что известно о согласии на момент постановки (158). not_collected — продукт согласия не собирает; все накопленные события транзакционные.';
COMMENT ON COLUMN notification_outbox.provider_message_id IS
  'Идентификатор сообщения у провайдера (158). Без него поддержка не свяжет жалобу гостя с записью очереди.';

CREATE INDEX IF NOT EXISTS idx_notification_outbox_org_created
  ON notification_outbox(org_id, created_at DESC);

/**
 * Постановка в очередь v2: та же идемпотентность, плюс снимок условий.
 *
 * Тело 122/147 сохранено дословно — меняется только то, что
 * записывается вместе с событием. Права не трогаются: функция
 * по-прежнему НЕ выдана роли `authenticated` (147), ставить в очередь
 * могут лишь триггеры, SECURITY DEFINER-функции и service_role.
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
  v_auth  UUID    := auth_org_id();
  v_lang  TEXT;
  v_tz    TEXT;
BEGIN
  -- Вторая линия обороны 147: организация из параметра обязана совпасть
  -- с организацией токена, когда та известна. Мягко по NULL — под
  -- service_role организации в токене нет, её подставляет доверенный
  -- сервер, а не браузер. Текст исключения прежний (147): его проверяет
  -- существующий тест, и менять контракт заодно с расширением нельзя.
  IF v_auth IS NOT NULL AND p_org_id IS DISTINCT FROM v_auth THEN
    RAISE EXCEPTION 'org mismatch';
  END IF;

  SELECT COALESCE(NULLIF(l.settings ->> 'lang', ''), 'he'),
         COALESCE(NULLIF(l.timezone, ''), 'Asia/Jerusalem')
  INTO v_lang, v_tz
  FROM locations l WHERE l.id = p_location_id;

  INSERT INTO notification_outbox (
    org_id, location_id, kind, channel, recipient, payload, dedupe_key,
    status, last_error, lang, timezone, next_attempt_at)
  VALUES (
    p_org_id, p_location_id, p_kind, p_channel,
    NULLIF(TRIM(COALESCE(p_recipient, '')), ''),
    COALESCE(p_payload, '{}'::jsonb), p_dedupe_key,
    CASE WHEN v_ready THEN 'pending' ELSE 'skipped' END,
    CASE WHEN v_ready THEN NULL ELSE 'no_provider' END,
    v_lang, v_tz,
    CASE WHEN v_ready THEN NOW() ELSE NULL END)
  ON CONFLICT (org_id, dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM notification_outbox
    WHERE org_id = p_org_id AND dedupe_key = p_dedupe_key;
  END IF;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION enqueue_notification(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION enqueue_notification(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT)
  TO service_role;

-- ── Что владелец видит ───────────────────────────────────────
/**
 * Очередь уведомлений для кабинета.
 *
 * Отдаёт и СВОДКУ, и записи. Сводка отвечает на вопрос «работает ли
 * вообще», записи — на «что с этим конкретным гостем».
 *
 * `provider_ready` в ответе не косметика: без него интерфейс не
 * отличит «нечего отправлять» от «нечем отправлять» и покажет пустой
 * список как норму.
 *
 * Получатель обрезается: очередь — это операционный экран, а не
 * выгрузка телефонов клиентов.
 */
CREATE OR REPLACE FUNCTION get_notification_outbox_web(
  p_location_id UUID,
  p_status      TEXT    DEFAULT NULL,
  p_limit       INTEGER DEFAULT 50,
  p_offset      INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_status TEXT := NULLIF(TRIM(COALESCE(p_status, '')), '');
BEGIN
  RETURN jsonb_build_object(
    -- Провайдера нет — и это состояние обязано быть названо, а не
    -- показано пустым списком.
    'provider_ready', notification_provider_ready('email')
                      OR notification_provider_ready('sms'),
    'summary', COALESCE((
      SELECT jsonb_object_agg(s.status, s.n)
      FROM (
        SELECT status, COUNT(*)::INTEGER AS n
        FROM notification_outbox
        WHERE org_id = v_org AND location_id = p_location_id
        GROUP BY status
      ) s), '{}'::jsonb),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',         n.id,
               'kind',       n.kind,
               'channel',    n.channel,
               'status',     n.status,
               'attempts',   n.attempts,
               'max_attempts', n.max_attempts,
               'last_error', n.last_error,
               'lang',       n.lang,
               'consent',    n.consent,
               'provider_message_id', n.provider_message_id,
               'created_at', n.created_at,
               'sent_at',    n.sent_at,
               'next_attempt_at', n.next_attempt_at,
               -- Хвост номера узнаёт запись, но не выдаёт контакт
               'recipient_tail', RIGHT(COALESCE(n.recipient, ''), 4),
               'guest_name', n.payload ->> 'guest_name')
             ORDER BY n.created_at DESC)
      FROM (
        SELECT * FROM notification_outbox
        WHERE org_id = v_org AND location_id = p_location_id
          AND (v_status IS NULL OR status = v_status)
        ORDER BY created_at DESC
        OFFSET v_offset LIMIT v_limit
      ) n), '[]'::jsonb)
  );
END $$;

REVOKE ALL ON FUNCTION get_notification_outbox_web(UUID, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_notification_outbox_web(UUID, TEXT, INTEGER, INTEGER)
  TO authenticated, service_role;

/**
 * Повтор одной записи — ограниченный и идемпотентный.
 *
 * Без провайдера отказывает ЧЕСТНО (`no_provider`), а не переводит
 * запись в `pending`: очередь, полная вечно ждущих сообщений, врёт
 * владельцу ровно так же, как фальшивое «отправлено».
 *
 * Исчерпанные попытки не сбрасываются: три неудачи подряд означают
 * системную причину, и четвёртая её не изменит.
 */
CREATE OR REPLACE FUNCTION retry_notification_web(
  p_location_id UUID,
  p_id          UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member UUID := _reservation_web_member(p_location_id);
  v_org    UUID := auth_org_id();
  v_row    notification_outbox%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM notification_outbox
  WHERE id = p_id AND org_id = v_org AND location_id = p_location_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT notification_provider_ready(v_row.channel) THEN
    RAISE EXCEPTION 'no_provider';
  END IF;
  IF v_row.status = 'sent' THEN
    -- Уже отправлено: повтор создал бы второе сообщение гостю
    RETURN jsonb_build_object('id', v_row.id, 'status', 'sent', 'retried', FALSE);
  END IF;
  IF v_row.attempts >= v_row.max_attempts THEN
    RAISE EXCEPTION 'attempts_exhausted';
  END IF;

  UPDATE notification_outbox
  SET status = 'pending', next_attempt_at = NOW(), last_error = NULL
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'status', 'pending', 'retried', TRUE);
END $$;

REVOKE ALL ON FUNCTION retry_notification_web(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION retry_notification_web(UUID, UUID)
  TO authenticated, service_role;

-- ============================================================
-- ОТКАТ
--
-- Forward-only. Новые колонки необязательны и имеют умолчания, поэтому
-- прежний путь постановки продолжает работать. Функциональный откат —
-- отозвать EXECUTE у read/retry: кабинет перестанет показывать очередь,
-- сама очередь продолжит копить события.
--
-- ПРОВЕРКА под веб-владельцем:
--   SELECT get_notification_outbox_web('<loc>') -> 'provider_ready';  -- false
--   SELECT get_notification_outbox_web('<loc>') -> 'summary';
-- ============================================================
