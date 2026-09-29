/**
 * public-service — ANGLE Guest service requests (172).
 *
 * POST { loc, table_token, client_uuid, kind }
 *   → one tracked request per guest action, idempotent per client_uuid.
 * GET ?id=<client_uuid>
 *   → public status for the browser that created/joined the request.
 *
 * The guest never reads service_requests directly. Validation, capability
 * gates, table resolution and rate limits live in SECURITY DEFINER RPCs.
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
const KINDS = new Set([
  'call_waiter', 'water', 'cutlery', 'napkins', 'bread',
  'next_course', 'hold_course', 'problem', 'bill',
])
const KNOWN_ERRORS = [
  'invalid_client_uuid', 'invalid_location', 'invalid_table', 'invalid_kind',
  'module_disabled', 'service_unavailable', 'rate_limited', 'busy', 'not_found',
]

function errorCode(message: string): string {
  for (const code of KNOWN_ERRORS) if (message.includes(code)) return code
  return 'unknown'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id') ?? ''
    if (!UUID_RE.test(id)) return json({ error: 'not_found' }, 404)

    const { data, error } = await supabase.rpc('get_service_request_status', {
      p_client_uuid: id,
    })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'not_found' ? 404 : code === 'unknown' ? 500 : 400)
    }
    return json(data)
  }

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const raw = await req.text()
  if (raw.length > 2_000) return json({ error: 'bad_request' }, 400)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  const { loc, table_token, client_uuid, kind } = body as {
    loc?: string
    table_token?: string
    client_uuid?: string
    kind?: string
  }
  if (!UUID_RE.test(loc ?? '') || !UUID_RE.test(table_token ?? '') || !UUID_RE.test(client_uuid ?? '')) {
    return json({ error: 'bad_request' }, 400)
  }
  if (!kind || !KINDS.has(kind)) return json({ error: 'invalid_kind' }, 400)

  const { data, error } = await supabase.rpc('submit_service_request', {
    p_location_id: loc,
    p_table_token: table_token,
    p_client_uuid: client_uuid,
    p_kind: kind,
  })
  if (error) {
    const code = errorCode(error.message)
    return json({ error: code }, code === 'unknown' ? 500 : 400)
  }
  return json(data)
})
