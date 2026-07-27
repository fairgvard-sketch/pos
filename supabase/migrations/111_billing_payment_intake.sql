-- ============================================================
-- 111 BILLING PAYMENT INTAKE — приём подтверждения оплаты от
-- платёжного провайдера (Phase 7, часть 3: автовыдача после оплаты).
--
-- Что закрывается:
--   109 сделал mark_invoice_paid идемпотентным и продлевающим подписки,
--   но вызывает его человек. Здесь появляется путь «провайдер подтвердил
--   платёж → доступ открылся сам», причём так, чтобы браузер клиента в
--   этой цепочке не участвовал.
--
-- Модель доверия (прямые уроки карантина cardcom-payment, P9):
--   * сумма НИКОГДА не приходит от клиента — только invoice_id, сумма
--     берётся из invoices;
--   * возврат пользователя на success-страницу НЕ является оплатой:
--     единственный источник истины — webhook провайдера с подписью;
--   * повтор webhook (провайдеры ретраят при таймауте) не должен
--     продлевать подписку дважды;
--   * запись платежа и продление подписки — одна транзакция, а не
--     цепочка клиентских вызовов (инвариант №7 CLAUDE.md).
--
-- Что здесь есть:
--   1) billing_payment_events — журнал сырых webhook'ов. UNIQUE по
--      (provider, event_id) — идемпотентность на уровне БД, а не
--      надежда на аккуратность Edge Function. Append-only.
--   2) record_provider_payment — единственная точка приёма платежа:
--      проверяет сумму и валюту против счёта, пишет событие, вызывает
--      mark_invoice_paid. service_role only.
--   3) invoice_payment_context — данные счёта для создания платёжной
--      сессии (сумма, валюта, организация). Нужен checkout-функции,
--      чтобы сумма бралась из БД, а не из тела запроса.
--
-- Провайдер здесь абстрактный: 'manual' | 'cardcom' | 'stripe'.
-- Конкретный ПС подключается адаптером в Edge Function; схема и
-- гарантии не меняются.
--
-- ⚠️ ТРЕБУЕТ 108/109.
-- ============================================================

-- ── Расширение списка провайдеров ────────────────────────────
-- 108 знал только manual/cardcom. Провайдер подписки ещё не выбран,
-- поэтому список открывается на stripe, не ломая существующие строки.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_provider_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_provider_check
  CHECK (provider IN ('manual', 'cardcom', 'stripe'));

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_provider_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_provider_check
  CHECK (provider IN ('manual', 'cardcom', 'stripe'));

-- ── Журнал webhook-событий ───────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_payment_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL CHECK (provider IN ('manual', 'cardcom', 'stripe')),
  -- Идентификатор события У ПРОВАЙДЕРА. Ретрай приходит с тем же id —
  -- UNIQUE ниже гасит повтор на уровне БД.
  event_id     TEXT NOT NULL,
  invoice_id   UUID REFERENCES invoices(id) ON DELETE SET NULL,
  org_id       UUID REFERENCES orgs(id) ON DELETE SET NULL,
  event_type   TEXT NOT NULL,
  amount_agorot INTEGER CHECK (amount_agorot >= 0),
  currency     TEXT,
  -- Результат обработки: applied — платёж принят и подписки продлены;
  -- duplicate — повтор уже обработанного; rejected — не сошлось.
  outcome      TEXT NOT NULL DEFAULT 'applied'
    CHECK (outcome IN ('applied', 'duplicate', 'rejected')),
  reject_reason TEXT,
  -- Сырое тело webhook'а для разбора инцидентов. Реквизиты карты сюда
  -- не попадают: провайдер их не присылает, а мы не запрашиваем.
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_payment_events_invoice
  ON billing_payment_events(invoice_id, created_at DESC);

ALTER TABLE billing_payment_events ENABLE ROW LEVEL SECURITY;

-- Журнал платежей — внутренний: клиенту он не нужен (у него есть счета
-- и subscription_events), а лишний доступ к сырым payload'ам вреден.
REVOKE ALL ON billing_payment_events FROM anon, authenticated, public;
GRANT ALL ON billing_payment_events TO service_role;

-- Журнал append-only: история платежей не переписывается (инвариант №2).
CREATE OR REPLACE FUNCTION protect_payment_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'billing_payment_events_append_only';
END $$;

DROP TRIGGER IF EXISTS billing_payment_events_append_only ON billing_payment_events;
CREATE TRIGGER billing_payment_events_append_only
  BEFORE UPDATE OR DELETE ON billing_payment_events
  FOR EACH ROW EXECUTE FUNCTION protect_payment_events_append_only();

-- ── Контекст счёта для создания платёжной сессии ─────────────
-- Checkout-функция получает от клиента ТОЛЬКО invoice_id; сумму,
-- валюту и организацию берёт отсюда. Клиентская сумма не участвует
-- в платеже ни на одном шаге.
CREATE OR REPLACE FUNCTION invoice_payment_context(p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inv invoices;
  v_org TEXT;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', FALSE, 'reason', 'invoice_not_found');
  END IF;

  IF v_inv.status NOT IN ('open', 'processing') THEN
    RETURN jsonb_build_object(
      'found', FALSE, 'reason', 'invoice_not_payable', 'status', v_inv.status
    );
  END IF;

  SELECT name INTO v_org FROM orgs WHERE id = v_inv.org_id;

  RETURN jsonb_build_object(
    'found',        TRUE,
    'invoice_id',   v_inv.id,
    'org_id',       v_inv.org_id,
    'org_name',     v_org,
    'number',       v_inv.number,
    'amount_agorot', v_inv.total_agorot,
    'currency',     v_inv.currency,
    'description',  'ANGLE ' || v_inv.number
  );
END $$;

REVOKE ALL ON FUNCTION invoice_payment_context(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION invoice_payment_context(UUID) TO service_role;

-- ── Приём подтверждённого платежа ────────────────────────────
-- Единственная точка, через которую внешний платёж превращается в
-- продлённую подписку. Вызывается ТОЛЬКО из webhook-функции под
-- service_role, после проверки подписи провайдера.
--
-- Гарантии:
--   * повтор с тем же (provider, event_id) → outcome='duplicate',
--     подписка НЕ продлевается второй раз;
--   * несовпадение суммы или валюты → outcome='rejected', счёт не
--     трогается (защита от подделанного/устаревшего уведомления);
--   * успех → mark_invoice_paid в той же транзакции.
CREATE OR REPLACE FUNCTION record_provider_payment(
  p_provider   TEXT,
  p_event_id   TEXT,
  p_invoice_id UUID,
  p_amount_agorot INTEGER,
  p_currency   TEXT DEFAULT 'ILS',
  p_event_type TEXT DEFAULT 'payment_succeeded',
  p_provider_ref TEXT DEFAULT NULL,
  p_payload    JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inv    invoices;
  v_reason TEXT;
BEGIN
  -- 1) Идемпотентность: повтор ретрая гасится до любых изменений.
  IF EXISTS (
    SELECT 1 FROM billing_payment_events
    WHERE provider = p_provider AND event_id = p_event_id
  ) THEN
    RETURN jsonb_build_object(
      'outcome', 'duplicate', 'invoice_id', p_invoice_id, 'changed', FALSE
    );
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;

  -- 2) Валидация против БД: сумма и валюта должны сойтись со счётом.
  IF NOT FOUND THEN
    v_reason := 'invoice_not_found';
  ELSIF v_inv.status IN ('void', 'uncollectible') THEN
    v_reason := 'invoice_closed';
  ELSIF v_inv.currency IS DISTINCT FROM p_currency THEN
    v_reason := 'currency_mismatch';
  ELSIF v_inv.total_agorot IS DISTINCT FROM p_amount_agorot THEN
    -- Оплачена сумма, отличная от выставленной: не додумываем за
    -- провайдера — фиксируем и разбираем вручную.
    v_reason := 'amount_mismatch';
  END IF;

  IF v_reason IS NOT NULL THEN
    -- invoice_id пишем только если счёт реально существует: webhook с
    -- мусорным идентификатором обязан записаться в журнал, а не упасть
    -- по FK. Иначе провайдер получит 500 и будет ретраить вечно, а
    -- причина отклонения нигде не сохранится.
    INSERT INTO billing_payment_events (
      provider, event_id, invoice_id, org_id, event_type,
      amount_agorot, currency, outcome, reject_reason, payload
    ) VALUES (
      p_provider, p_event_id,
      CASE WHEN v_inv.id IS NULL THEN NULL ELSE p_invoice_id END,
      v_inv.org_id, p_event_type,
      p_amount_agorot, p_currency, 'rejected', v_reason,
      -- Исходный идентификатор не теряем: он нужен для разбора.
      p_payload || jsonb_build_object('requested_invoice_id', p_invoice_id)
    );
    RETURN jsonb_build_object(
      'outcome', 'rejected', 'reason', v_reason, 'changed', FALSE
    );
  END IF;

  -- 3) Уже оплачен (человеком или прошлым событием) — фиксируем факт,
  --    но подписку не продлеваем повторно.
  IF v_inv.status = 'paid' THEN
    INSERT INTO billing_payment_events (
      provider, event_id, invoice_id, org_id, event_type,
      amount_agorot, currency, outcome, reject_reason, payload
    ) VALUES (
      p_provider, p_event_id, p_invoice_id, v_inv.org_id, p_event_type,
      p_amount_agorot, p_currency, 'duplicate', 'invoice_already_paid', p_payload
    );
    RETURN jsonb_build_object(
      'outcome', 'duplicate', 'reason', 'invoice_already_paid', 'changed', FALSE
    );
  END IF;

  -- 4) Платёж принят: журнал + продление подписок одной транзакцией.
  INSERT INTO billing_payment_events (
    provider, event_id, invoice_id, org_id, event_type,
    amount_agorot, currency, outcome, payload
  ) VALUES (
    p_provider, p_event_id, p_invoice_id, v_inv.org_id, p_event_type,
    p_amount_agorot, p_currency, 'applied', p_payload
  );

  UPDATE invoices SET provider = p_provider WHERE id = v_inv.id;

  PERFORM mark_invoice_paid(v_inv.id, 'card', p_provider_ref);

  RETURN jsonb_build_object(
    'outcome', 'applied', 'invoice_id', v_inv.id,
    'number', v_inv.number, 'changed', TRUE
  );
END $$;

REVOKE ALL ON FUNCTION record_provider_payment(TEXT, TEXT, UUID, INTEGER, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_provider_payment(TEXT, TEXT, UUID, INTEGER, TEXT, TEXT, TEXT, JSONB)
  TO service_role;

COMMENT ON TABLE billing_payment_events IS
  'Append-only журнал webhook-ов платёжного провайдера. UNIQUE(provider,event_id) — идемпотентность на уровне БД: ретрай не продлевает подписку дважды.';
COMMENT ON FUNCTION invoice_payment_context(UUID) IS
  'Данные счёта для создания платёжной сессии. Сумма берётся ОТСЮДА, а не из тела клиентского запроса (урок карантина cardcom-payment).';
COMMENT ON FUNCTION record_provider_payment(TEXT, TEXT, UUID, INTEGER, TEXT, TEXT, TEXT, JSONB) IS
  'Единственная точка приёма внешнего платежа: сверяет сумму и валюту со счётом, гасит повторы, продлевает подписки одной транзакцией. Только service_role, после проверки подписи webhook.';
