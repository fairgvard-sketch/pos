/**
 * public-reserve — бронирование стола с сайта (053).
 *
 * GET ?loc=<location_id>
 *   → { location: { id, name, business_name, logo_url, accepting,
 *       address, phone, header_url } }
 *   Инфо точки для формы брони. accepting — тумблер
 *   settings->reservations->enabled (отсутствие = выключено).
 *   header_url переиспользуется из оформления онлайн-заказов.
 *
 * GET ?id=<client_uuid>
 *   → { status, reject_reason, reserved_at, party_size, table_label }
 *   client_uuid знает только гость — он же и ключ доступа к статусу.
 *
 * POST { action:'submit', loc, client_uuid, name, phone, party_size, reserved_at, note? }
 *   → { reservation_id, duplicate } | { error }
 * POST { action:'cancel', client_uuid }
 *   → { status } | { error }
 *
 * Вся валидация, анти-спам и идемпотентность — в БД
 * (submit_reservation и др., SECURITY DEFINER, только service_role).
 *
 * Деплой: supabase functions deploy public-reserve
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra },
  })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Ошибки, которые БД кидает осознанно — отдаём гостю как код, не 500
const KNOWN_ERRORS = [
  'disabled', 'rate_limited', 'busy', 'invalid_location', 'invalid_name',
  'invalid_phone', 'invalid_party', 'invalid_time', 'outside_hours', 'not_found',
  'full_slot', // 063: instant-режим, на слот не осталось свободного стола
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
    const params = new URL(req.url).searchParams

    // Live-доступность слотов (063): ?loc=&date=YYYY-MM-DD&party=N.
    // Требует instant-режима у точки (RPC сама вернёт 'disabled', если приём выкл).
    const availDate = params.get('date')
    const availParty = params.get('party')
    if (availDate !== null && availParty !== null) {
      const aLoc = params.get('loc') ?? ''
      if (!UUID_RE.test(aLoc)) return json({ error: 'invalid_location' }, 400)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(availDate)) return json({ error: 'bad_request' }, 400)
      const party = Math.floor(Number(availParty))
      if (!Number.isFinite(party) || party < 1 || party > 200) {
        return json({ error: 'invalid_party' }, 400)
      }
      const { data, error } = await supabase.rpc('reservation_availability', {
        p_location_id: aLoc,
        p_date: availDate,
        p_party: party,
      })
      if (error) {
        const code = errorCode(error.message)
        return json({ error: code }, code === 'unknown' ? 500 : 400)
      }
      return json(data, 200, { 'Cache-Control': 'no-store' })
    }

    // Инфо точки для формы брони
    const loc = params.get('loc')
    if (loc !== null) {
      if (!UUID_RE.test(loc)) return json({ error: 'invalid_location' }, 400)
      // Наружу — только флаг брони и баннер, НЕ весь settings (там права ролей)
      const { data, error } = await supabase
        .from('locations')
        .select('id, name, receipt_business_name, receipt_address, receipt_phone, logo_url, display_name:settings->>display_name, rsv:settings->reservations, header_url:settings->online_orders->>header_url')
        .eq('id', loc)
        .maybeSingle()
      if (error || !data) return json({ error: 'invalid_location' }, 404)
      const rsv = (data as { rsv?: {
        enabled?: boolean; instant?: boolean; open?: string | null; close?: string | null
        slot_min?: number | null; max_party?: number | null
        address?: string | null; lat?: number | null; lng?: number | null
      } }).rsv
      return json(
        {
          location: {
            id: data.id,
            name: data.name,
            business_name:
              (data as { display_name?: string | null }).display_name ||
              data.receipt_business_name ||
              data.name,
            logo_url: data.logo_url ?? null,
            // Тумблер 053: отсутствие ключа = бронирование ВЫКЛЮЧЕНО
            accepting: rsv?.enabled === true,
            // instant-режим (063): гость видит live-доступность, бронь сразу confirmed
            instant: rsv?.instant === true,
            // Часы приёма (059): гостевая страница ограничивает слоты этим окном
            open: rsv?.open ?? null,
            close: rsv?.close ?? null,
            slot_min: rsv?.slot_min ?? null,
            // Лимит гостей на бронь (061): гостевой селект ограничен этим числом
            max_party: rsv?.max_party ?? null,
            // Адрес брони (062): точный адрес из настроек приоритетнее адреса
            // из реквизитов чека. Телефон — из реквизитов чека.
            address: rsv?.address || data.receipt_address || null,
            // Координаты пина (062): заданы → «Навигация» открывает точную точку
            lat: rsv?.lat ?? null,
            lng: rsv?.lng ?? null,
            phone: data.receipt_phone ?? null,
            // Фото-шапка — общая с гостевой страницей заказа (Настройки → Онлайн-заказы)
            header_url: (data as { header_url?: string | null }).header_url ?? null,
          },
        },
        200,
        { 'Cache-Control': 'public, max-age=30' }
      )
    }

    // Поллинг статуса гостем
    const id = params.get('id') ?? ''
    if (!UUID_RE.test(id)) return json({ error: 'not_found' }, 404)
    const { data, error } = await supabase.rpc('get_reservation_status', { p_client_uuid: id })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'not_found' ? 404 : 500)
    }
    return json(data)
  }

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  // Грубая защита от мусорных payload до похода в БД
  const raw = await req.text()
  if (raw.length > 2_000) return json({ error: 'bad_request' }, 400)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  const action = body.action

  if (action === 'cancel') {
    const clientUuid = body.client_uuid
    if (typeof clientUuid !== 'string' || !UUID_RE.test(clientUuid)) {
      return json({ error: 'not_found' }, 404)
    }
    const { data, error } = await supabase.rpc('cancel_reservation', { p_client_uuid: clientUuid })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'not_found' ? 404 : 500)
    }
    return json(data)
  }

  if (action !== 'submit') return json({ error: 'bad_request' }, 400)

  const { loc, client_uuid, name, phone, party_size, reserved_at, note } = body as {
    loc?: string; client_uuid?: string; name?: string; phone?: string
    party_size?: number; reserved_at?: string; note?: string | null
  }
  if (!UUID_RE.test(loc ?? '') || !UUID_RE.test(client_uuid ?? '')) {
    return json({ error: 'bad_request' }, 400)
  }
  if (typeof name !== 'string' || typeof phone !== 'string'
      || typeof party_size !== 'number' || typeof reserved_at !== 'string') {
    return json({ error: 'bad_request' }, 400)
  }

  const { data, error } = await supabase.rpc('submit_reservation', {
    p_location_id: loc,
    p_client_uuid: client_uuid,
    p_name: name,
    p_phone: phone,
    p_party_size: Math.floor(party_size),
    p_reserved_at: reserved_at,
    p_note: note ?? null,
  })

  if (error) {
    const code = errorCode(error.message)
    return json({ error: code }, code === 'unknown' ? 500 : 400)
  }
  return json(data)
})
