/**
 * Cardcom Payment Edge Function — КАРАНТИН (P9).
 *
 * Прежняя версия НЕ production-ready: клиент задавал amount и redirect URL,
 * JWT устройства не проверялся, сумма не бралась из БД. Это позволяло
 * заплатить произвольную сумму и увести редирект куда угодно.
 *
 * ДО доводки функция ЗАБЛОКИРОВАНА feature-флагом (по умолчанию 503).
 * Включать только вместе с полноценной реализацией (см. TODO ниже) —
 * НЕ деплоить как готовый платёжный endpoint.
 *
 * Чтобы включить (после реализации TODO): выставить секрет
 *   CARDCOM_ENABLED=true
 * в Supabase → Edge Functions → Secrets. Без него — 503.
 *
 * TODO для production-готовности (НЕ реализовано):
 *   1. Проверять JWT устройства (Authorization: Bearer) и org_id из него.
 *   2. Брать сумму и описание ИЗ БД по orderId (service_role), НЕ из тела.
 *   3. successUrl/cancelUrl — из allow-list (домены кассы), не из клиента.
 *   4. Идемпотентность: ключ на orderId, чтобы повтор не создавал 2 платежа.
 *   5. Webhook-подтверждение оплаты и запись payment в БД (не доверять redirect).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve((req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Карантин: функция намеренно выключена, пока не доведена до production.
  // Реальные платежи не включаем (запрет задачи). Возвращаем 503, чтобы
  // случайный вызов не создавал платёж по недоверенным данным.
  const enabled = Deno.env.get('CARDCOM_ENABLED') === 'true'
  if (!enabled) {
    return json(
      {
        error: 'cardcom-payment is disabled (not production-ready)',
        detail: 'See supabase/functions/cardcom-payment/index.ts — enable only after implementing JWT/amount-from-DB/redirect-allowlist/idempotency.',
      },
      503,
    )
  }

  // Флаг включён, но безопасная реализация ещё не написана — тоже отказ,
  // чтобы «включил флаг» ≠ «принимаю недоверенные суммы».
  return json(
    { error: 'cardcom-payment not implemented (secure flow pending)' },
    501,
  )
})
