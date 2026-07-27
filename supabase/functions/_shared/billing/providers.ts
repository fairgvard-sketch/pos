/**
 * Адаптеры платёжных провайдеров: разные форматы webhook → одна форма.
 *
 * Провайдер подписки ещё НЕ выбран (docs/billing.md). Каркас построен
 * так, чтобы подключение свелось к одному адаптеру: схема БД, гарантии
 * идемпотентности и UI кабинета при этом не меняются.
 *
 * Инвариант, который держат все адаптеры: из webhook берутся только
 * идентификаторы и сумма ДЛЯ СВЕРКИ. Источник истины о том, сколько
 * клиент должен, — счёт в БД (record_provider_payment, 111). Адаптер
 * не решает, оплачен ли счёт: он лишь переводит формат.
 */

export type ProviderKey = 'manual' | 'cardcom' | 'stripe'

export interface NormalizedPayment {
  /** Идентификатор события у провайдера — ключ идемпотентности */
  eventId: string
  /** Наш invoice_id, который мы отдали провайдеру при создании сессии */
  invoiceId: string
  /** Сумма в целых агоротах для сверки со счётом */
  amountAgorot: number
  currency: string
  eventType: string
  /** Ссылка на транзакцию у провайдера — для сверки и поддержки */
  providerRef: string | null
}

export type ParseResult =
  | { ok: true; payment: NormalizedPayment }
  | { ok: false; reason: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Деньги: принимаем только целое число агорот (инвариант №1 CLAUDE.md) */
function agorot(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (!Number.isInteger(v) || v < 0) return null
  return v
}

/**
 * Stripe: сумма в минорных единицах (agorot для ILS) — совпадает с нашим
 * представлением. invoice_id кладём в metadata при создании сессии.
 */
function parseStripe(body: unknown): ParseResult {
  const root = asRecord(body)
  if (!root) return { ok: false, reason: 'bad_payload' }

  const eventId = str(root.id)
  const eventType = str(root.type)
  if (!eventId || !eventType) return { ok: false, reason: 'missing_event_fields' }

  // Обрабатываем только успешную оплату. Остальные события (created,
  // failed) журналируются вызывающим кодом, но доступ не открывают.
  if (eventType !== 'checkout.session.completed' && eventType !== 'payment_intent.succeeded') {
    return { ok: false, reason: 'unsupported_event_type' }
  }

  const object = asRecord(asRecord(root.data)?.object)
  if (!object) return { ok: false, reason: 'missing_object' }

  const metadata = asRecord(object.metadata)
  const invoiceId = str(metadata?.invoice_id)
  if (!invoiceId || !UUID_RE.test(invoiceId)) return { ok: false, reason: 'missing_invoice_id' }

  const amount = agorot(object.amount_total ?? object.amount_received ?? object.amount)
  if (amount === null) return { ok: false, reason: 'bad_amount' }

  const currency = str(object.currency)?.toUpperCase() ?? null
  if (!currency) return { ok: false, reason: 'missing_currency' }

  return {
    ok: true,
    payment: {
      eventId,
      invoiceId,
      amountAgorot: amount,
      currency,
      eventType,
      providerRef: str(object.payment_intent) ?? str(object.id),
    },
  }
}

/**
 * Cardcom: суммы приходят в ШЕКЕЛЯХ (дробные), поэтому переводим в
 * агороты через округление — float в деньгах запрещён, но на границе
 * с внешним API он неизбежен, и здесь единственное место конверсии.
 */
function parseCardcom(body: unknown): ParseResult {
  const root = asRecord(body)
  if (!root) return { ok: false, reason: 'bad_payload' }

  const eventId = str(root.InternalDealNumber) ?? str(root.TranzactionId) ?? str(root.lowprofilecode)
  if (!eventId) return { ok: false, reason: 'missing_event_fields' }

  // Cardcom сигнализирует успех кодом операции 0.
  const responseCode = root.ResponseCode ?? root.OperationResponse
  const succeeded = responseCode === 0 || responseCode === '0'
  if (!succeeded) return { ok: false, reason: 'payment_not_successful' }

  const invoiceId = str(root.ReturnValue) ?? str(asRecord(root.metadata)?.invoice_id)
  if (!invoiceId || !UUID_RE.test(invoiceId)) return { ok: false, reason: 'missing_invoice_id' }

  const rawAmount = root.Amount ?? root.SumToBill
  if (typeof rawAmount !== 'number' && typeof rawAmount !== 'string') {
    return { ok: false, reason: 'bad_amount' }
  }
  const shekels = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount)
  if (!Number.isFinite(shekels) || shekels < 0) return { ok: false, reason: 'bad_amount' }
  const amountAgorot = Math.round(shekels * 100)

  return {
    ok: true,
    payment: {
      eventId,
      invoiceId,
      amountAgorot,
      currency: 'ILS',
      eventType: 'payment_succeeded',
      providerRef: str(root.TranzactionId) ?? eventId,
    },
  }
}

export function parseWebhook(provider: ProviderKey, body: unknown): ParseResult {
  switch (provider) {
    case 'stripe':
      return parseStripe(body)
    case 'cardcom':
      return parseCardcom(body)
    default:
      // manual оплачивается оператором через mark_invoice_paid, webhook
      // для него не предусмотрен — принимать его было бы дырой.
      return { ok: false, reason: 'provider_has_no_webhook' }
  }
}
