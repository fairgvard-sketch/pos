/**
 * waiter-pair — допуск телефона официанта в точку (180).
 *
 * POST { code, label } → { access_token, refresh_token, expires_at, location_name }
 *
 * Код выдаёт владелец/менеджер (create_waiter_pairing_code), живёт 10
 * минут, одноразовый. Функция создаёт телефону ОТДЕЛЬНЫЙ Auth-аккаунт
 * без org_id/location_id в app_metadata: RLS не отдаёт ему ни строки,
 * работать он может только через waiter_*. Пароль аккаунта нигде не
 * хранится — телефон живёт refresh-токеном; потерял его — новый код.
 *
 * Порядок: проверить код → создать аккаунт → привязать (код гасится
 * условным UPDATE в waiter_pair_bind) → выдать сессию. Сбой после
 * создания аккаунта удаляет аккаунт: мусорных входов не остаётся.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  cleanDeviceLabel,
  normalizePairCode,
  pairErrorCode,
  randomPassword,
} from '../_shared/waiter-pair.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const raw = await req.text()
  if (raw.length > 1_000) return json({ error: 'bad_request' }, 400)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  const code = normalizePairCode(body.code)
  if (!code) return json({ error: 'invalid_code' }, 400)
  const label = cleanDeviceLabel(body.label)

  const url = Deno.env.get('SUPABASE_URL')!
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, noSession)

  const check = await admin.rpc('waiter_pair_check', { p_code: code })
  if (check.error) {
    const err = pairErrorCode(check.error.message)
    return json({ error: err }, err === 'unknown' ? 500 : 400)
  }

  // Адрес служебный: письма на него не уходят (email_confirm сразу),
  // человек его не видит. Домен вынесен в env на случай валидации MX.
  const domain = Deno.env.get('WAITER_EMAIL_DOMAIN') || 'waiter.angle.invalid'
  const email = `waiter-${crypto.randomUUID()}@${domain}`
  const password = randomPassword()

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { kind: 'waiter' },
  })
  if (created.error || !created.data.user) {
    console.error('[waiter-pair] createUser failed:', created.error?.message)
    return json({ error: 'account_failed' }, 500)
  }
  const userId = created.data.user.id

  const bound = await admin.rpc('waiter_pair_bind', {
    p_code: code,
    p_auth_user_id: userId,
    p_label: label,
  })
  if (bound.error) {
    await admin.auth.admin.deleteUser(userId)
    const err = pairErrorCode(bound.error.message)
    return json({ error: err }, err === 'unknown' ? 500 : 400)
  }

  const pub = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, noSession)
  const signed = await pub.auth.signInWithPassword({ email, password })
  if (signed.error || !signed.data.session) {
    console.error('[waiter-pair] signIn failed:', signed.error?.message)
    // Телефон без сессии бесполезен: снять привязку и аккаунт, код
    // владелец выдаст новый
    await admin.from('waiter_devices')
      .update({ revoked_at: new Date().toISOString(), auth_user_id: null })
      .eq('auth_user_id', userId)
    await admin.auth.admin.deleteUser(userId)
    return json({ error: 'session_failed' }, 500)
  }

  const s = signed.data.session
  return json({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at,
    location_name: (bound.data as { location_name?: string } | null)?.location_name ?? '',
  })
})
