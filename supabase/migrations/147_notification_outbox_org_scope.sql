-- ============================================================
-- 147 ОЧЕРЕДЬ УВЕДОМЛЕНИЙ СКОУПИТСЯ ПО ОРГАНИЗАЦИИ
--
-- МОТИВ. `enqueue_notification` (122) — единственная функция с грантом
-- `authenticated`, которая пишет строку по `org_id` ИЗ ПАРАМЕТРА и
-- нигде его не проверяет. Схема `public` открыта наружу, значит любое
-- устройство своим JWT вызывало её напрямую через
-- `/rest/v1/rpc/enqueue_notification` и вставляло записи в чужую
-- организацию — в обход `REVOKE INSERT ... FROM authenticated` на самой
-- таблице, потому что функция SECURITY DEFINER.
--
-- Сегодня ущерб ограничен: провайдера нет, всё ложится в `skipped`,
-- очередь никто не читает. Но это ровно тот случай, когда дыру чинят
-- ДО подключения провайдера, а не после: в день, когда адаптер
-- доставки появится, эта функция становится открытым релеем.
--
-- Второе следствие того же корня — `dedupe_key` был уникален
-- ГЛОБАЛЬНО и приходил от клиента. Заранее вставленный ключ навсегда
-- гасил чужое уведомление через `ON CONFLICT DO NOTHING`, а откат по
-- ключу (строка 118 в 122) возвращал id чужой строки. Дедупликация —
-- понятие внутри арендатора, а не между ними.
--
-- ЧТО ЗДЕСЬ.
--   1) UNIQUE(dedupe_key) → UNIQUE(org_id, dedupe_key). Ключи двух
--      организаций больше не встречаются.
--   2) Тело `enqueue_notification`: сверка `p_org_id` с JWT, конфликт и
--      откат по паре (org_id, dedupe_key).
--   3) Грант `authenticated` снят. Все три вызова внутри 122
--      (`_notify_reservation_confirmed`, `request_reservation_confirmations`,
--      `offer_waitlist_slot`) — SECURITY DEFINER, права проверяются по
--      владельцу функции, не по вызывающему: внутренние пути не рвутся.
--      Парадные RPC (`request_reservation_confirmations`, `offer_waitlist_slot`)
--      грант сохраняют и сами скоупятся по `auth_org_id()`.
--
-- Сверка мягкая по NULL намеренно: под `service_role` (Edge Functions,
-- гостевая бронь) в JWT нет `app_metadata.org_id`, и `auth_org_id()`
-- возвращает NULL. Жёсткое равенство обрубило бы гостевой поток, где
-- организацию подставляет доверенный сервер, а не браузер.
--
-- ⚠️ ТРЕБУЕТ 122.
-- ============================================================

-- ── 1. Дедупликация внутри организации ───────────────────────
ALTER TABLE notification_outbox
  DROP CONSTRAINT IF EXISTS notification_outbox_dedupe_key_key;

-- Прежний ключ был уникален глобально, поэтому пара (org_id, dedupe_key)
-- уникальна на существующих строках заведомо: миграция не может упасть
-- на данных.
ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_org_dedupe_key
  UNIQUE (org_id, dedupe_key);

-- ── 2. Постановка в очередь только в свою организацию ────────
/**
 * Поставить событие в очередь. Идемпотентно по паре (org_id, dedupe_key):
 * повтор (ретрай, двойное нажатие, replay) возвращает id уже
 * существующей записи, а не создаёт вторую.
 *
 * Без провайдера запись сразу получает `skipped` — очередь не копит
 * «pending», который никто не разберёт, и по ней видно ровно то, что
 * произошло: событие случилось, отправить было нечем.
 *
 * `p_org_id` обязан совпасть с организацией из JWT, когда та известна.
 * Проверка живёт ЗДЕСЬ, а не только в гранте: она и делает снятие
 * гранта необратимым — вернуть его случайной строкой уже недостаточно,
 * чтобы дыра открылась заново.
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
  v_jwt   UUID := auth_org_id();
  v_ready BOOLEAN := notification_provider_ready(p_channel);
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org required';
  END IF;
  -- NULL = доверенный серверный контекст (service_role): организацию
  -- подставил не браузер. Непустой и несовпавший — попытка писать в
  -- чужую очередь.
  IF v_jwt IS NOT NULL AND p_org_id <> v_jwt THEN
    RAISE EXCEPTION 'org mismatch';
  END IF;

  INSERT INTO notification_outbox (
    org_id, location_id, kind, channel, recipient, payload, dedupe_key,
    status, last_error)
  VALUES (
    p_org_id, p_location_id, p_kind, p_channel,
    NULLIF(TRIM(COALESCE(p_recipient, '')), ''),
    COALESCE(p_payload, '{}'::jsonb), p_dedupe_key,
    CASE WHEN v_ready THEN 'pending' ELSE 'skipped' END,
    CASE WHEN v_ready THEN NULL ELSE 'no_provider' END)
  ON CONFLICT (org_id, dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM notification_outbox
    WHERE org_id = p_org_id AND dedupe_key = p_dedupe_key;
  END IF;
  RETURN v_id;
END $$;

-- ── 3. Наружу очередь не пополняют ───────────────────────────
-- Ставить в очередь могут только триггеры и RPC под SECURITY DEFINER
-- (права там проверяются по владельцу функции) и доверенный service_role.
REVOKE ALL ON FUNCTION enqueue_notification(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION enqueue_notification(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT)
  TO service_role;

COMMENT ON FUNCTION enqueue_notification(UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT) IS
  'Постановка события в очередь уведомлений (122, скоуп по org — 147). Идемпотентна по (org_id, dedupe_key). Наружу не выдаётся: только SECURITY DEFINER-вызовы и service_role.';

COMMENT ON CONSTRAINT notification_outbox_org_dedupe_key ON notification_outbox IS
  'Идемпотентность события внутри организации (147). Глобальный ключ позволял чужой строке погасить уведомление через ON CONFLICT DO NOTHING.';

-- Откат: ALTER TABLE notification_outbox DROP CONSTRAINT
--   notification_outbox_org_dedupe_key, ADD CONSTRAINT
--   notification_outbox_dedupe_key_key UNIQUE (dedupe_key);
--   плюс тело enqueue_notification и грант authenticated из 122.
