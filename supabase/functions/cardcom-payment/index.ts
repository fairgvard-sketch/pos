/**
 * Cardcom Payment Edge Function
 *
 * Env vars required (set in Supabase dashboard → Edge Functions → Secrets):
 *   CARDCOM_TERMINAL   - Terminal number (מספר מסוף)
 *   CARDCOM_API_KEY    - API key / username
 *   CARDCOM_CODEPAGE   - 65001 (UTF-8) recommended
 *
 * POST body:
 *   { orderId, amount, description, successUrl, cancelUrl }
 *
 * Returns:
 *   { lowProfileCode, url }  — redirect user to `url` for payment
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CARDCOM_API = 'https://secure.cardcom.solutions/api/v11/LowProfile/Create'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { orderId, amount, description, successUrl, cancelUrl } = await req.json()

    if (!orderId || !amount) {
      return new Response(
        JSON.stringify({ error: 'orderId and amount are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const terminal = Deno.env.get('CARDCOM_TERMINAL')
    const apiKey   = Deno.env.get('CARDCOM_API_KEY')

    if (!terminal || !apiKey) {
      return new Response(
        JSON.stringify({ error: 'CARDCOM_TERMINAL and CARDCOM_API_KEY must be set' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const payload = {
      TerminalNumber: terminal,
      UserName: apiKey,
      APILevel: '10',
      codepage: '65001',
      Operation: '1',  // charge
      Amount: amount.toString(),
      CoinID: '1',     // 1 = ILS
      Language: 'he',
      ProductName: description ?? `Заказ #${orderId.slice(0, 8)}`,
      ReturnValue: orderId,
      SuccessRedirectUrl: successUrl ?? '',
      ErrorRedirectUrl: cancelUrl ?? '',
      CancelType: '0',
      CreateTokenId: 'false',
    }

    const resp = await fetch(CARDCOM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!resp.ok) {
      const text = await resp.text()
      return new Response(
        JSON.stringify({ error: 'Cardcom API error', details: text }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const data = await resp.json()

    // Cardcom returns ResponseCode 0 on success
    if (data.ResponseCode !== 0) {
      return new Response(
        JSON.stringify({ error: data.Description ?? 'Cardcom rejected request', code: data.ResponseCode }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        lowProfileCode: data.LowProfileCode,
        url: data.url ?? `https://secure.cardcom.solutions/External/LowProfile.aspx?LowProfileCode=${data.LowProfileCode}`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
