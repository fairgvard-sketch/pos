/**
 * public-menu — публичное меню для страницы онлайн-заказа (050).
 *
 * GET ?loc=<location_id>
 *   → { location: { id, name, currency, is_open }, categories: [...] }
 *
 * Анонимные гости сайта ≠ authenticated-устройства кассы: анон-ключ
 * кассы им не выдаём, ходим под service_role ЗДЕСЬ, на сервере.
 * Наружу уходит только публичная витрина: активные категории,
 * доступные товары (стоп-лист 047 уже вычищен), размеры и
 * модификаторы с ценами в агоротах.
 *
 * Деплой: supabase functions deploy public-menu
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)

  const loc = new URL(req.url).searchParams.get('loc') ?? ''
  if (!UUID_RE.test(loc)) return json({ error: 'invalid_location' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const [locRes, shiftRes, catRes] = await Promise.all([
    // Наружу — только флаг онлайн-заказов, НЕ весь settings (там права ролей)
    supabase.from('locations').select('id, name, currency, online_settings:settings->online_orders').eq('id', loc).maybeSingle(),
    supabase.from('shifts').select('id').eq('location_id', loc).eq('status', 'open').limit(1),
    supabase
      .from('menu_categories')
      .select(`
        id, name, sort_order,
        menu_items (
          id, name, price, description, image_url, sort_order, is_available,
          item_variants ( id, name, price, is_default, sort_order ),
          menu_item_modifier_groups (
            sort_order,
            modifier_groups (
              id, name, min_select, max_select, sort_order,
              modifiers ( id, name, price_delta, is_default, is_available, sort_order )
            )
          )
        )
      `)
      .eq('location_id', loc)
      .eq('is_active', true)
      .order('sort_order'),
  ])

  if (locRes.error || !locRes.data) return json({ error: 'invalid_location' }, 404)
  if (catRes.error) return json({ error: 'menu_failed' }, 502)

  const bySort = (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order

  const categories = (catRes.data ?? [])
    .map((c) => ({
      id: c.id,
      name: c.name,
      items: (c.menu_items ?? [])
        .filter((i) => i.is_available)
        .sort(bySort)
        .map((i) => ({
          id: i.id,
          name: i.name,
          price: i.price,
          description: i.description,
          image_url: i.image_url,
          variants: (i.item_variants ?? []).sort(bySort).map((v) => ({
            id: v.id, name: v.name, price: v.price, is_default: v.is_default,
          })),
          modifier_groups: (i.menu_item_modifier_groups ?? [])
            .sort(bySort)
            .map((link) => link.modifier_groups)
            .filter(Boolean)
            .map((g) => ({
              id: g.id,
              name: g.name,
              min_select: g.min_select,
              max_select: g.max_select,
              modifiers: (g.modifiers ?? [])
                .filter((m) => m.is_available)
                .sort(bySort)
                .map((m) => ({ id: m.id, name: m.name, price_delta: m.price_delta, is_default: m.is_default })),
            }))
            .filter((g) => g.modifiers.length > 0),
        })),
    }))
    .filter((c) => c.items.length > 0)

  return json(
    {
      location: {
        id: locRes.data.id,
        name: locRes.data.name,
        currency: locRes.data.currency,
        is_open: (shiftRes.data ?? []).length > 0,
        // Тумблер 051: false = владелец выключил приём онлайн-заказов
        accepting: (locRes.data as { online_settings?: { enabled?: boolean } }).online_settings?.enabled !== false,
      },
      categories,
    },
    200,
    // Витрина меняется редко — короткий CDN/браузерный кэш разгружает БД
    { 'Cache-Control': 'public, max-age=30' }
  )
})
