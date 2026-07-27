/**
 * billing-webhook — приём подтверждения оплаты подписки от платёжного
 * провайдера (111). Единственный путь, которым внешний платёж
 * превращается в продлённую подписку.
 *
 * POST /billing-webhook?provider=stripe|cardcom
 *   заголовок подписи: x-angle-signature (HMAC-SHA256 сырого тела)
 *   → 200 { outcome: 'applied'|'duplicate'|'rejected' }
 *   → 401 при неверной подписи, 400 при неразбираемом теле
 *
 * Модель доверия (уроки карантина cardcom-payment, P9):
 *   * подпись проверяется ДО обращения к БД и до разбора тела;
 *   * сумма из webhook используется только ДЛЯ СВЕРКИ — источник
 *     истины о долге это счёт в БД (record_provider_payment);
 *   * возврат пользователя на success-страницу оплатой не считается:
 *     сюда приходит только сервер провайдера;
 *   * повтор ретрая гасится UNIQUE(provider, event_id) в БД, а не
 *     аккуратностью этого кода;
 *   * JWT здесь не проверяется намеренно (провайдер его не пришлёт) —
 *     аутентификация держится на подписи, поэтому функция деплоится
 *     с --no-verify-jwt.
 *
 * Секреты (Supabase → Edge Functions → Secrets):
 *   BILLING_WEBHOOK_SECRET_STRIPE   — HMAC-секрет для Stripe
 *   BILLING_WEBHOOK_SECRET_CARDCOM  — HMAC-секрет для Cardcom
 * Отсутствие секрета = провайдер выключен (fail closed, 503).
 *
 * Деплой: supabase functions deploy billing-webhook --no-verify-jwt
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyWebhookSignature } from '../_shared/billing/signature.ts'
import { parseWebhook, type ProviderKey } from '../_shared/billing/providers.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const SECRET_ENV: Record<string, string> = {
  stripe: 'BILLING_WEBHOOK_SECRET_STRIPE',
  cardcom: 'BILLING_WEBHOOK_SECRET_CARDCOM',
}

function isProvider(v: string | null): v is ProviderKey {
  return v === 'stripe' || v === 'cardcom'
}

Deno.serve(async (req) => {
  // CORS не нужен: сюда ходит сервер провайдера, не браузер. Отсутствие
  // Access-Control-Allow-Origin — дополнительный барьер от вызова со
  // страницы клиента.
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405)
  }

  const provider = new URL(req.url).searchParams.get('provider')
  if (!isProvider(provider)) {
    return json({ error: 'unknown_provider' }, 400)
  }

  const secret = Deno.env.get(SECRET_ENV[provider])

  // Сырое тело: подпись считается по байтам, которые прислал провайдер.
  // Пересериализация JSON меняет их и ломает проверку.
  const rawBody = await req.text()

  const tsHeader = req.headers.get('x-angle-timestamp')
  const timestamp = tsHeader !== null && /^\d+$/.test(tsHeader) ? Number(tsHeader) : null

  const check = await verifyWebhookSignature({
    secret,
    rawBody,
    signatureHeader: req.headers.get('x-angle-signature'),
    timestamp,
  })

  if (!check.ok) {
    // Провайдер не настроен — это конфигурация, а не атака: 503, чтобы
    // отличать в логах от подделки и чтобы провайдер повторил попытку.
    if (check.reason === 'missing_secret') {
      return json({ error: 'provider_not_configured', provider }, 503)
    }
    // Подробности не раскрываем: подсказка о причине помогает подбирать.
    console.warn('billing-webhook: rejected', { provider, reason: check.reason })
    return json({ error: 'invalid_signature' }, 401)
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return json({ error: 'bad_json' }, 400)
  }

  const parsed = parseWebhook(provider, body)
  if (!parsed.ok) {
    // Событие подписано верно, но нас не касается (иной тип, неуспешная
    // оплата). 200, иначе провайдер будет ретраить его бесконечно.
    console.info('billing-webhook: ignored', { provider, reason: parsed.reason })
    return json({ outcome: 'ignored', reason: parsed.reason }, 200)
  }

  const { eventId, invoiceId, amountAgorot, currency, eventType, providerRef } = parsed.payment

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  const { data, error } = await supabase.rpc('record_provider_payment', {
    p_provider: provider,
    p_event_id: eventId,
    p_invoice_id: invoiceId,
    p_amount_agorot: amountAgorot,
    p_currency: currency,
    p_event_type: eventType,
    p_provider_ref: providerRef,
    p_payload: body,
  })

  if (error) {
    // 500 — чтобы провайдер повторил: идемпотентность в БД защищает от
    // двойного продления, а потерять платёж нельзя.
    console.error('billing-webhook: rpc failed', { provider, eventId, code: error.code })
    return json({ error: 'processing_failed' }, 500)
  }

  return json(data, 200)
})
