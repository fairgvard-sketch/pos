/**
 * public-order — приём онлайн-заказа с сайта и поллинг статуса (050).
 *
 * POST { loc, client_uuid, name, phone, pickup_at?, note?, items: [...] }
 *   → { online_id, total } | { error }
 *   Вся валидация, цены, анти-спам и идемпотентность — в БД
 *   (submit_online_order, SECURITY DEFINER, только service_role).
 *
 * GET ?id=<client_uuid>
 *   → { status, reject_reason, total, daily_number, order_status }
 *   client_uuid знает только гость — он же и ключ доступа к статусу.
 *
 * Деплой: supabase functions deploy public-order
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Ошибки, которые БД кидает осознанно — отдаём гостю как код, не 500
const KNOWN_ERRORS = [
  'disabled', 'closed', 'rate_limited', 'busy', 'invalid_location', 'invalid_name',
  'invalid_phone', 'invalid_pickup', 'invalid_items', 'item_unavailable',
  'invalid_client_uuid', 'invalid_order_type', 'invalid_address', 'not_found',
]

function errorCode(message: string): string {
  for (const code of KNOWN_ERRORS) if (message.includes(code)) return code
  return 'unknown'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id') ?? ''
    if (!UUID_RE.test(id)) return json({ error: 'not_found' }, 404)
    const { data, error } = await supabase.rpc('get_online_order_status', { p_client_uuid: id })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'not_found' ? 404 : 500)
    }
    return json(data)
  }

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  // Грубая защита от мусорных payload до похода в БД
  const raw = await req.text()
  if (raw.length > 20_000) return json({ error: 'invalid_items' }, 400)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  const { loc, client_uuid, name, phone, pickup_at, note, items, order_type, delivery_address } = body as {
    loc?: string; client_uuid?: string; name?: string; phone?: string
    pickup_at?: string | null; note?: string | null; items?: unknown
    order_type?: string; delivery_address?: string | null
  }
  if (!UUID_RE.test(loc ?? '') || !UUID_RE.test(client_uuid ?? '')) {
    return json({ error: 'bad_request' }, 400)
  }
  if (typeof name !== 'string' || typeof phone !== 'string' || !Array.isArray(items)) {
    return json({ error: 'bad_request' }, 400)
  }

  const { data, error } = await supabase.rpc('submit_online_order', {
    p_location_id: loc,
    p_client_uuid: client_uuid,
    p_name: name,
    p_phone: phone,
    p_items: items,
    p_pickup_at: pickup_at ?? null,
    p_note: note ?? null,
    p_order_type: typeof order_type === 'string' ? order_type : 'takeaway',
    p_delivery_address: typeof delivery_address === 'string' ? delivery_address : null,
  })

  if (error) {
    const code = errorCode(error.message)
    // item_unavailable несёт имя позиции — прокидываем для сообщения гостю
    const detail = code === 'item_unavailable' ? error.message.split(':').pop()?.trim() : undefined
    return json({ error: code, detail }, code === 'unknown' ? 500 : 400)
  }
  return json(data)
})
