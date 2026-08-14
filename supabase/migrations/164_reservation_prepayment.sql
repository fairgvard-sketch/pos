-- ============================================================
-- 164 ПРЕДОПЛАТА БРОНИ — контракт, состояние и удержание стола
--
-- ⚠️ ФУНКЦИЯ ВЫКЛЮЧЕНА И ВКЛЮЧИТЬСЯ НЕ МОЖЕТ. В проекте нет ни одного
--    работающего платёжного провайдера: `supabase/functions/cardcom-payment`
--    остаётся карантинной заглушкой (503/501), учётных данных нет, вебхука
--    нет, подпись проверять нечем. Здесь строится ТОЛЬКО серверный контракт,
--    и он намеренно устроен так, что без здорового провайдера политика
--    предоплаты наружу не выходит, а значит гость никогда не увидит экран
--    оплаты. Включение — отдельная задача вместе с реальной интеграцией.
--
-- МОТИВ. Плейсхолдеры депозита живут с 063: `deposit_required`,
-- `deposit_amount`, `deposit_from_party` в настройках и `deposit_status`
-- в брони. Они никогда ничего не списывали — бронь просто помечалась
-- «требуется депозит». Кабинет прятал тумблер (комментарий в
-- `QrChannels.jsx`), потому что владелец принимал его за работающую
-- предоплату. Это и есть та ложь, которую нужно убрать: либо оплата
-- настоящая и проверенная, либо её нельзя включить.
--
-- ЧТО ЗДЕСЬ ЕСТЬ:
--   1. `payment_providers` — реестр провайдеров с ЯВНЫМ здоровьем.
--      Секретов не хранит: только ИМЯ секрета Edge Function. Пока строки
--      со статусом `healthy` нет, предоплата невозможна;
--   2. `reservation_payments` — попытки оплаты как состояние, а не флаг.
--      Ключ идемпотентности создаётся ДО первой попытки, повтор вебхука
--      и двойной тап не создают ни второго платежа, ни второй брони;
--   3. удержание стола: бронь заводится сразу со `status='new'` и
--      `deposit_status='awaiting'`. Стол занят настоящим EXCLUDE-констрейнтом
--      (063) — ничего нового в горячий путь доступности не добавляется, —
--      а `hold_expires_at` возвращает его, если гость не заплатил;
--   4. `reservation_prepay_policy` — то, и ТОЛЬКО то, что можно показать
--      гостю: сумма с человека, итог, валюта, срок бесплатной отмены.
--
-- ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО: подтверждения оплаты по редиректу или
-- по слову клиента. `confirm_reservation_prepayment` вызывается только
-- service_role из проверенного вебхука и сверяет сумму с той, которую
-- посчитал сервер.
-- ============================================================

-- ── 1. Реестр провайдеров ────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_providers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id   UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  -- unconfigured — строка заведена, но платить нечем;
  -- configured   — реквизиты прописаны, живой проверки ещё не было;
  -- healthy      — провайдер ответил на проверку связи. ТОЛЬКО в этом
  --                статусе предоплату разрешено показывать гостю.
  status        TEXT NOT NULL DEFAULT 'unconfigured'
                  CHECK (status IN ('unconfigured', 'configured', 'healthy')),
  -- ИМЯ секрета Edge Function, а не сам секрет. Ключи в базе не лежат:
  -- она реплицируется в дампы, которые видит больше людей, чем секреты.
  credential_ref TEXT,
  last_health_at TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, provider)
);

COMMENT ON TABLE payment_providers IS
  'Платёжные провайдеры точки (164). Секретов НЕ хранит — только имя секрета Edge Function. Предоплата возможна лишь при status=healthy.';

CREATE INDEX IF NOT EXISTS idx_payment_providers_healthy
  ON payment_providers(location_id) WHERE status = 'healthy';

ALTER TABLE payment_providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_providers_org ON payment_providers;
CREATE POLICY payment_providers_org ON payment_providers
  FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

-- ── 2. Попытки оплаты ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reservation_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Ключ попытки гостя. Создаётся ДО первой попытки и переиспользуется
  -- при повторе — тот же инвариант идемпотентности, что и client_uuid
  -- у самой брони.
  attempt_key    UUID NOT NULL UNIQUE,
  reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL,
  provider       TEXT NOT NULL,
  -- Идентификатор транзакции у провайдера. Пара (провайдер, ссылка)
  -- уникальна: повторная доставка вебхука не создаёт второй платёж.
  provider_ref   TEXT,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency       TEXT NOT NULL DEFAULT 'ILS',
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'paid', 'failed', 'cancelled',
                                     'expired', 'refunded', 'forfeited')),
  -- До какого момента стол держится неоплаченным
  expires_at     TIMESTAMPTZ,
  -- Проставляется ТОЛЬКО из проверенного ответа провайдера. Пустое поле
  -- при status='paid' невозможно — см. confirm_reservation_prepayment.
  verified_at    TIMESTAMPTZ,
  failure_code   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE reservation_payments IS
  'Попытки предоплаты брони (164) как состояние. Идемпотентность: attempt_key от гостя и (provider, provider_ref) от провайдера.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservation_payments_provider_ref
  ON reservation_payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservation_payments_reservation
  ON reservation_payments(reservation_id);

ALTER TABLE reservation_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservation_payments_org ON reservation_payments;
CREATE POLICY reservation_payments_org ON reservation_payments
  FOR SELECT TO authenticated
  USING (org_id = auth_org_id());

-- ── 3. Удержание стола ───────────────────────────────────────

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN reservations.hold_expires_at IS
  'До какого момента неоплаченная бронь держит стол (164). NULL = удержания нет. Истёкшие снимает expire_reservation_holds().';

CREATE INDEX IF NOT EXISTS idx_reservations_hold_expiry
  ON reservations(hold_expires_at)
  WHERE hold_expires_at IS NOT NULL AND status = 'new';

-- Состояния депозита расширяются: прежних пяти не хватает, чтобы
-- отличить «ждём оплату» от «оплата не прошла» и от «время вышло».
-- Расширение, а не сужение: ни одно существующее значение не запрещено.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_deposit_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_deposit_status_check
  CHECK (deposit_status IN ('none', 'required', 'awaiting', 'paid',
                            'failed', 'cancelled', 'expired',
                            'refunded', 'forfeited'));

-- ── 4. Политика предоплаты для гостя ─────────────────────────

/**
 * Что можно показать гостю про предоплату — или NULL, если её нет.
 *
 * Ключевая проверка здесь одна: живой провайдер. Пока в
 * `payment_providers` нет строки со `status='healthy'`, функция вернёт
 * NULL, даже если владелец выставил и сумму, и флаг. Именно это делает
 * предоплату невозможной к включению без настоящей интеграции —
 * гостевая страница просто не получит политику и не покажет шаг оплаты.
 *
 * Сумма считается ЗДЕСЬ и только здесь: браузер не имеет права влиять на
 * то, сколько с человека спишут.
 */
CREATE OR REPLACE FUNCTION reservation_prepay_policy(
  p_location_id UUID,
  p_party_size  INTEGER
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_per      INTEGER;
  v_from     INTEGER;
  v_cutoff   INTEGER;
  v_provider TEXT;
BEGIN
  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_rsv := v_loc.settings -> 'reservations';
  IF NOT COALESCE((v_rsv ->> 'deposit_required')::BOOLEAN, FALSE) THEN
    RETURN NULL;
  END IF;

  v_per := GREATEST(0, COALESCE((v_rsv ->> 'deposit_amount')::INTEGER, 0));
  IF v_per = 0 THEN RETURN NULL; END IF;

  -- Порог по размеру компании (063): двоих можно пускать без предоплаты,
  -- а компанию на двенадцать — нет.
  v_from := GREATEST(1, COALESCE((v_rsv ->> 'deposit_from_party')::INTEGER, 1));
  IF COALESCE(p_party_size, 0) < v_from THEN RETURN NULL; END IF;

  -- Живой провайдер. Нет его — нет и предоплаты, чем бы ни было
  -- заполнено в настройках. Обещать оплату, которую некому принять,
  -- хуже, чем не предлагать её вовсе.
  SELECT provider INTO v_provider
  FROM payment_providers
  WHERE location_id = p_location_id AND status = 'healthy'
  ORDER BY updated_at DESC
  LIMIT 1;
  IF v_provider IS NULL THEN RETURN NULL; END IF;

  v_cutoff := GREATEST(0, COALESCE((v_rsv ->> 'deposit_refund_hours')::INTEGER, 24));

  RETURN jsonb_build_object(
    'required', TRUE,
    'amount_per_guest', v_per,
    'total', v_per * p_party_size,
    'currency', COALESCE(v_rsv ->> 'currency', 'ILS'),
    'refund_cutoff_hours', v_cutoff
  );
END $$;

COMMENT ON FUNCTION reservation_prepay_policy(UUID, INTEGER) IS
  'Гостевая политика предоплаты (164) или NULL. NULL всегда, пока у точки нет провайдера со status=healthy — секретов и сумм клиенту не отдаёт.';

REVOKE ALL ON FUNCTION reservation_prepay_policy(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reservation_prepay_policy(UUID, INTEGER) TO service_role;

/**
 * ПРАВИЛО предоплаты точки для гостевой страницы — или NULL.
 *
 * Отличается от `reservation_prepay_policy` тем, что не зависит от
 * размера компании: страница получает его один раз вместе с остальной
 * информацией о точке и сама решает, показывать ли шаг оплаты выбранной
 * компании. Иначе ответ пришлось бы кэшировать по каждому числу гостей.
 *
 * Свойство безопасности то же самое: без здорового провайдера — NULL, и
 * гостевая страница про предоплату просто не узнаёт. Сумма к списанию
 * здесь ПРЕДВАРИТЕЛЬНАЯ (с человека); обязывающую считает
 * `begin_reservation_prepayment` в момент оплаты.
 */
CREATE OR REPLACE FUNCTION reservation_prepay_rule(p_location_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_loc      locations%ROWTYPE;
  v_rsv      JSONB;
  v_per      INTEGER;
BEGIN
  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_rsv := v_loc.settings -> 'reservations';
  IF NOT COALESCE((v_rsv ->> 'deposit_required')::BOOLEAN, FALSE) THEN
    RETURN NULL;
  END IF;

  v_per := GREATEST(0, COALESCE((v_rsv ->> 'deposit_amount')::INTEGER, 0));
  IF v_per = 0 THEN RETURN NULL; END IF;

  -- Тот же и единственный вентиль: нет живого провайдера — нет правила
  IF NOT EXISTS (
    SELECT 1 FROM payment_providers
    WHERE location_id = p_location_id AND status = 'healthy'
  ) THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'amount_per_guest', v_per,
    'from_party', GREATEST(1, COALESCE((v_rsv ->> 'deposit_from_party')::INTEGER, 1)),
    'currency', COALESCE(v_rsv ->> 'currency', 'ILS'),
    'refund_cutoff_hours', GREATEST(0, COALESCE((v_rsv ->> 'deposit_refund_hours')::INTEGER, 24))
  );
END $$;

COMMENT ON FUNCTION reservation_prepay_rule(UUID) IS
  'Правило предоплаты точки для гостевой страницы (164) или NULL. NULL всегда, пока нет провайдера со status=healthy.';

REVOKE ALL ON FUNCTION reservation_prepay_rule(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reservation_prepay_rule(UUID) TO service_role;

-- ── 5. Начало оплаты: бронь держит стол, но не подтверждена ──

/**
 * Гость согласился с условиями и идёт платить.
 *
 * Бронь создаётся СРАЗУ — иначе стол уедет, пока гость вводит карту, и
 * мы возьмём деньги за место, которого нет. Держит его существующий
 * EXCLUDE-констрейнт (063): ничего нового в расчёт доступности не
 * добавляется, а `hold_expires_at` вернёт стол, если оплаты не будет.
 *
 * Статус брони — `new` (заявка), депозит — `awaiting`. Подтверждённой она
 * станет только из проверенного вебхука.
 *
 * Повторный вызов с тем же `attempt_key` возвращает прежний расчёт и не
 * создаёт вторую бронь: гость мог нажать «оплатить» дважды.
 */
CREATE OR REPLACE FUNCTION begin_reservation_prepayment(
  p_location_id UUID,
  p_client_uuid UUID,
  p_attempt_key UUID,
  p_phone       TEXT,
  p_party_size  INTEGER,
  p_reserved_at TIMESTAMPTZ,
  p_note        TEXT DEFAULT NULL,
  p_zone_id     UUID DEFAULT NULL,
  p_rules_ack   JSONB DEFAULT NULL,
  p_first_name  TEXT DEFAULT NULL,
  p_last_name   TEXT DEFAULT NULL,
  p_email       TEXT DEFAULT NULL,
  p_hold_min    INTEGER DEFAULT 15
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing reservation_payments%ROWTYPE;
  v_policy   JSONB;
  v_loc      locations%ROWTYPE;
  v_provider TEXT;
  v_res      JSON;
  v_res_id   UUID;
  v_hold     TIMESTAMPTZ := NOW() + make_interval(mins => GREATEST(1, LEAST(60, p_hold_min)));
BEGIN
  -- Идемпотентность попытки: тот же ключ — тот же ответ
  SELECT * INTO v_existing FROM reservation_payments WHERE attempt_key = p_attempt_key;
  IF FOUND THEN
    RETURN json_build_object(
      'attempt_key', v_existing.attempt_key,
      'reservation_id', v_existing.reservation_id,
      'amount_minor', v_existing.amount_minor,
      'currency', v_existing.currency,
      'status', v_existing.status,
      'expires_at', v_existing.expires_at,
      'duplicate', TRUE
    );
  END IF;

  SELECT * INTO v_loc FROM locations WHERE id = p_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_location'; END IF;

  -- Сумма и сам факт предоплаты приходят от сервера, не из запроса
  v_policy := reservation_prepay_policy(p_location_id, p_party_size);
  IF v_policy IS NULL THEN
    RAISE EXCEPTION 'prepay_unavailable';
  END IF;

  SELECT provider INTO v_provider
  FROM payment_providers
  WHERE location_id = p_location_id AND status = 'healthy'
  ORDER BY updated_at DESC LIMIT 1;
  IF v_provider IS NULL THEN RAISE EXCEPTION 'prepay_unavailable'; END IF;

  -- Бронь создаётся обычным путём: все проверки расписания, зоны, правил
  -- и занятости живут в одном месте и не дублируются здесь.
  v_res := submit_reservation(
    p_location_id, p_client_uuid, NULL, p_phone, p_party_size, p_reserved_at,
    p_note, p_zone_id, p_rules_ack, p_first_name, p_last_name, p_email);
  v_res_id := (v_res ->> 'reservation_id')::UUID;

  -- Стол занят, но бронь ждёт денег
  UPDATE reservations
  SET deposit_status = 'awaiting',
      deposit_amount = (v_policy ->> 'total')::INTEGER,
      hold_expires_at = v_hold,
      -- Мгновенное подтверждение здесь неуместно: платить ещё не начали
      status = 'new',
      decided_at = NULL
  WHERE id = v_res_id;

  INSERT INTO reservation_payments (
    org_id, location_id, attempt_key, reservation_id, provider,
    amount_minor, currency, status, expires_at)
  VALUES (
    v_loc.org_id, p_location_id, p_attempt_key, v_res_id, v_provider,
    (v_policy ->> 'total')::INTEGER, v_policy ->> 'currency', 'pending', v_hold);

  RETURN json_build_object(
    'attempt_key', p_attempt_key,
    'reservation_id', v_res_id,
    'amount_minor', (v_policy ->> 'total')::INTEGER,
    'currency', v_policy ->> 'currency',
    'status', 'pending',
    'expires_at', v_hold,
    'duplicate', FALSE
  );
END $$;

COMMENT ON FUNCTION begin_reservation_prepayment IS
  'Начало предоплаты (164): держит стол бронью в статусе new/awaiting и заводит попытку оплаты. Сумму считает сервер. Идемпотентна по attempt_key.';

REVOKE ALL ON FUNCTION begin_reservation_prepayment(UUID, UUID, UUID, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, JSONB, TEXT, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION begin_reservation_prepayment(UUID, UUID, UUID, TEXT, INTEGER, TIMESTAMPTZ, TEXT, UUID, JSONB, TEXT, TEXT, TEXT, INTEGER)
  TO service_role;

-- ── 6. Подтверждение оплаты — только проверенное ─────────────

/**
 * Оплата подтверждена провайдером.
 *
 * Вызывается ТОЛЬКО из вебхука, у которого уже проверена подпись, и
 * только под service_role. Ни редирект гостя, ни его галочка сюда не
 * ведут: «вернулся на страницу успеха» и «деньги списаны» — разные
 * события, и первое подделывается адресной строкой.
 *
 * Сумма сверяется с посчитанной сервером. Расхождение — отказ, а не
 * «наверное, скидка»: платёж на другую сумму это чужой платёж.
 *
 * Повтор вебхука по той же (provider, provider_ref) ничего не меняет —
 * возвращается прежний результат.
 */
CREATE OR REPLACE FUNCTION confirm_reservation_prepayment(
  p_attempt_key  UUID,
  p_provider_ref TEXT,
  p_amount_minor INTEGER
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pay reservation_payments%ROWTYPE;
  v_rsv JSONB;
  v_loc locations%ROWTYPE;
BEGIN
  SELECT * INTO v_pay FROM reservation_payments
  WHERE attempt_key = p_attempt_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  -- Повторная доставка вебхука: тот же результат, без второго списания
  IF v_pay.status = 'paid' THEN
    RETURN json_build_object('status', 'paid', 'duplicate', TRUE,
                             'reservation_id', v_pay.reservation_id);
  END IF;

  IF v_pay.status IN ('expired', 'cancelled') THEN
    RAISE EXCEPTION 'hold_expired';
  END IF;

  IF p_amount_minor IS DISTINCT FROM v_pay.amount_minor THEN
    RAISE EXCEPTION 'amount_mismatch';
  END IF;

  UPDATE reservation_payments
  SET status = 'paid', provider_ref = p_provider_ref,
      verified_at = NOW(), updated_at = NOW()
  WHERE id = v_pay.id;

  SELECT * INTO v_loc FROM locations WHERE id = v_pay.location_id;
  v_rsv := v_loc.settings -> 'reservations';

  -- Деньги получены: удержание снимается, депозит помечен оплаченным.
  -- Подтверждать ли бронь сразу — решает прежняя настройка instant:
  -- заведение на ручном подтверждении остаётся на ручном.
  UPDATE reservations
  SET deposit_status = 'paid',
      hold_expires_at = NULL,
      status = CASE WHEN COALESCE((v_rsv ->> 'instant')::BOOLEAN, FALSE)
                    THEN 'confirmed' ELSE status END,
      decided_at = CASE WHEN COALESCE((v_rsv ->> 'instant')::BOOLEAN, FALSE)
                        THEN NOW() ELSE decided_at END
  WHERE id = v_pay.reservation_id;

  RETURN json_build_object('status', 'paid', 'duplicate', FALSE,
                           'reservation_id', v_pay.reservation_id);
END $$;

COMMENT ON FUNCTION confirm_reservation_prepayment(UUID, TEXT, INTEGER) IS
  'Подтверждение предоплаты из ПРОВЕРЕННОГО вебхука (164). Сверяет сумму, идемпотентна по повтору. Редирект гостя доказательством оплаты не является.';

REVOKE ALL ON FUNCTION confirm_reservation_prepayment(UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION confirm_reservation_prepayment(UUID, TEXT, INTEGER) TO service_role;

/**
 * Оплата не прошла или гость её отменил. Стол освобождается сразу:
 * держать его «на всякий случай» — значит терять посадку.
 * Контакты и сама попытка остаются — гость может повторить, и вторая
 * бронь при этом не появится (тот же client_uuid).
 */
CREATE OR REPLACE FUNCTION fail_reservation_prepayment(
  p_attempt_key UUID,
  p_reason      TEXT DEFAULT 'failed'
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pay reservation_payments%ROWTYPE;
BEGIN
  SELECT * INTO v_pay FROM reservation_payments
  WHERE attempt_key = p_attempt_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  -- Оплаченное не отменяем этой дорогой: возврат — отдельная операция
  IF v_pay.status = 'paid' THEN
    RETURN json_build_object('status', 'paid', 'changed', FALSE);
  END IF;

  UPDATE reservation_payments
  SET status = CASE WHEN p_reason = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
      failure_code = LEFT(COALESCE(p_reason, 'failed'), 64),
      updated_at = NOW()
  WHERE id = v_pay.id;

  UPDATE reservations
  SET status = 'cancelled',
      deposit_status = CASE WHEN p_reason = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
      hold_expires_at = NULL
  WHERE id = v_pay.reservation_id AND status = 'new';

  RETURN json_build_object('status', 'failed', 'changed', TRUE);
END $$;

REVOKE ALL ON FUNCTION fail_reservation_prepayment(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fail_reservation_prepayment(UUID, TEXT) TO service_role;

/**
 * Снятие истёкших удержаний. Гость ушёл платить и не вернулся — стол
 * обязан вернуться в продажу, иначе вечер простоит пустым из-за брони,
 * за которую никто не заплатил.
 *
 * Вызывается по расписанию (cron) и на всякий случай перед выдачей
 * доступности не вызывается намеренно: горячий путь не должен зависеть
 * от уборки.
 */
CREATE OR REPLACE FUNCTION expire_reservation_holds()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  WITH stale AS (
    SELECT id, reservation_id FROM reservation_payments
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE reservation_payments p
    SET status = 'expired', updated_at = NOW()
    FROM stale s WHERE p.id = s.id
    RETURNING s.reservation_id
  )
  UPDATE reservations r
  SET status = 'cancelled', deposit_status = 'expired', hold_expires_at = NULL
  FROM marked m
  WHERE r.id = m.reservation_id AND r.status = 'new';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

COMMENT ON FUNCTION expire_reservation_holds() IS
  'Снимает истёкшие удержания предоплаты (164): неоплаченная бронь отменяется, стол возвращается в продажу.';

REVOKE ALL ON FUNCTION expire_reservation_holds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION expire_reservation_holds() TO service_role;
