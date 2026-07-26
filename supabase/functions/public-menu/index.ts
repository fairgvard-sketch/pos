/**
 * public-menu — публичное меню для страницы онлайн-заказа (050).
 *
 * GET ?loc=<location_id>&table=<opaque_table_token?>
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
  const tableToken = new URL(req.url).searchParams.get('table')
  if (!UUID_RE.test(loc)) return json({ error: 'invalid_location' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const [locRes, shiftRes, catRes] = await Promise.all([
    // Наружу — только флаг онлайн-заказов, НЕ весь settings (там права ролей)
    supabase.from('locations').select('id, org_id, name, currency, timezone, receipt_business_name, logo_url, display_name:settings->>display_name, online_settings:settings->online_orders').eq('id', loc).maybeSingle(),
    supabase.from('shifts').select('id').eq('location_id', loc).eq('status', 'open').limit(1),
    supabase
      .from('menu_categories')
      .select(`
        id, name, sort_order, cover_url,
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

  // Capability-гейты (105): публичная витрина требует public_menu —
  // возможность дают и ANGLE Menu, и ANGLE Orders (без покупки Menu).
  // module_disabled ≠ invalid_location: модуль не подключён, точка существует.
  // online_orders — той же RPC: без него страница — чистая витрина
  // (без корзины и статуса приёма), см. modules в ответе.
  const gatesRes = await supabase.rpc('org_public_menu_gates', {
    p_org: (locRes.data as { org_id: string }).org_id,
  })
  if (gatesRes.error) return json({ error: 'menu_failed' }, 502)
  const gates = gatesRes.data as {
    public_menu: boolean
    online_orders: boolean
    pos: boolean
  }
  if (!gates?.public_menu) return json({ error: 'module_disabled' }, 404)
  const orderingModuleOn = gates.online_orders === true

  const bySort = (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order

  const categories = (catRes.data ?? [])
    .map((c) => ({
      id: c.id,
      name: c.name,
      // Обложка плитки категории (080): своя картинка или null (гость возьмёт фото первого товара)
      cover_url: (c as { cover_url?: string | null }).cover_url ?? null,
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

  const onlineSettings = (locRes.data as {
    online_settings?: {
      enabled?: boolean
      table_ordering_enabled?: boolean
      paused_until?: string | null
      prep_minutes?: number | null
      prep_min?: number | null
      prep_max?: number | null
      instagram?: string | null
      facebook?: string | null
      google_review?: string | null
      header_url?: string | null
      hero_video_url?: string | null
      background_url?: string | null
      display_name?: string | null
      order_types?: string[]
    }
  }).online_settings

  // Режим обслуживания (101): standalone-точка живёт без смен — открытость
  // для гостя решает недельное расписание (online_hours_open в БД), а не
  // открытая смена POS. Явная настройка fulfilment сильнее дефолта по модулю.
  const fulfilmentSetting = (locRes.data as {
    online_settings?: { fulfilment?: string }
  }).online_settings?.fulfilment
  const fulfilment =
    fulfilmentSetting === 'pos' || fulfilmentSetting === 'standalone'
      ? fulfilmentSetting
      : gates.pos === true ? 'pos' : 'standalone'
  let isOpen = (shiftRes.data ?? []).length > 0
  if (fulfilment === 'standalone') {
    const hoursRes = await supabase.rpc('online_hours_open', {
      p_settings: { online_orders: (locRes.data as { online_settings?: unknown }).online_settings ?? {} },
      p_tz: (locRes.data as { timezone?: string }).timezone ?? '',
    })
    // Ошибка проверки расписания не прячет меню: считаем точку открытой,
    // submit_online_order всё равно проверит расписание сервером.
    isOpen = hoursRes.error ? true : hoursRes.data === true
  }

  // Пауза с кассы (054): истёкшая метка = паузы нет (снимается сама)
  const pausedUntil =
    onlineSettings?.paused_until && Date.parse(onlineSettings.paused_until) > Date.now()
      ? onlineSettings.paused_until
      : null
  // Типы заказа, включённые владельцем (058). Отсутствие ключа = дефолт
  // ['here','takeaway'] (зеркало submit_online_order). Фильтруем мусор.
  const ALL_TYPES = ['here', 'takeaway', 'delivery']
  const orderTypes = (Array.isArray(onlineSettings?.order_types)
    ? onlineSettings!.order_types.filter((tp) => ALL_TYPES.includes(tp))
    : [])
  const enabledTypes = orderTypes.length > 0 ? orderTypes : ['here', 'takeaway']

  // Время приготовления — вилка мин–макс (061). Новые ключи в приоритете;
  // старый prep_minutes (054) читаем как min=max. 0/0 = не показывать.
  const prepMin = onlineSettings?.prep_min ?? onlineSettings?.prep_minutes ?? null
  const prepMax = onlineSettings?.prep_max ?? onlineSettings?.prep_minutes ?? null

  let orderContext: { kind: 'table'; label: string; zone: string | null } | null = null
  let contextError: 'invalid_table' | 'table_ordering_disabled' | null = null
  if (tableToken) {
    if (!UUID_RE.test(tableToken)) {
      contextError = 'invalid_table'
    } else {
      const tableRes = await supabase
        .from('tables')
        .select('label, zone, status, is_active')
        .eq('location_id', loc)
        .eq('public_token', tableToken)
        .maybeSingle()
      const table = tableRes.data as {
        label: string
        zone: string | null
        status: string
        is_active: boolean
      } | null

      if (tableRes.error || !table || !table.is_active) {
        contextError = 'invalid_table'
      } else if (table.status === 'disabled' || onlineSettings?.table_ordering_enabled === false) {
        contextError = 'table_ordering_disabled'
      } else {
        orderContext = { kind: 'table', label: table.label, zone: table.zone }
      }
    }
  }

  return json(
    {
      location: {
        id: locRes.data.id,
        name: locRes.data.name,
        // Название в шапке гостевой страницы: настройка «Онлайн-заказы» (062)
        // → отображаемое имя (профиль 052) → название из чека → имя точки
        business_name:
          onlineSettings?.display_name ||
          (locRes.data as { display_name?: string | null }).display_name ||
          locRes.data.receipt_business_name ||
          locRes.data.name,
        logo_url: locRes.data.logo_url ?? null,
        currency: locRes.data.currency,
        is_open: isOpen,
        // Модули организации (100): online_orders=false — витрина без заказа
        // (меню видно всегда, независимо от смены POS). Старые клиенты поле
        // игнорируют — поведение не меняется.
        modules: { online_orders: orderingModuleOn },
        // Тумблер 051 + пауза 054: false = заявки сейчас не принимаются
        accepting: onlineSettings?.enabled !== false && !pausedUntil,
        // Пауза с кассы: когда приём возобновится (null = паузы нет)
        paused_until: pausedUntil,
        // Время приготовления — вилка «готовим ~N–M мин» на странице гостя (061)
        prep_min: prepMin,
        prep_max: prepMax,
        // Типы заказа для гостя (058): здесь / с собой / доставка
        order_types: enabledTypes,
        // Оформление главного экрана: баннер-шапка и фон (Настройки → Онлайн-заказы)
        header_url: onlineSettings?.header_url || null,
        hero_video_url: onlineSettings?.hero_video_url || null,
        background_url: onlineSettings?.background_url || null,
        // Соцссылки подвала гостевой страницы (Настройки → Обслуживание → Онлайн-заказы)
        links: {
          instagram: onlineSettings?.instagram || null,
          facebook: onlineSettings?.facebook || null,
          google_review: onlineSettings?.google_review || null,
        },
      },
      order_context: orderContext,
      context_error: contextError,
      categories,
    },
    200,
    // Витрина меняется редко — короткий CDN/браузерный кэш разгружает БД
    { 'Cache-Control': 'public, max-age=30' }
  )
})
