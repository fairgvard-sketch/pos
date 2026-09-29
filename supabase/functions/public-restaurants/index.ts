/**
 * public-restaurants — безопасная выдача опубликованных карточек ANGLE.
 *
 * GET                  → { restaurants: [...] }
 * GET ?slug=bulochka  → { restaurant: {...} }
 *
 * Браузер не перечисляет locations и не видит org_id/settings. Профиль
 * появляется только при is_published=true и действующем public_menu.
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

type ProfileRow = {
  location_id: string
  org_id: string
  city: string | null
  country_code: string
  cuisine_labels: string[] | null
  summary: string | null
  hero_url: string | null
  price_level: number | null
  demo_rating: number | null
  demo_rating_count: number | null
}

type LocationRow = {
  id: string
  org_id: string
  name: string
  receipt_business_name: string | null
  receipt_address: string | null
  logo_url: string | null
  service_mode: string
  settings: {
    display_name?: string | null
    online_orders?: { header_url?: string | null }
    reservations?: { enabled?: boolean; lat?: number | null; lng?: number | null }
  } | null
}

const publicCoordinates = (lat: number | null | undefined, lng: number | null | undefined) =>
  typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
    ? { lat, lng }
    : null

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)

  const slugFilter = new URL(req.url).searchParams.get('slug')?.trim().toLowerCase() || null
  if (slugFilter && !/^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$/.test(slugFilter)) {
    return json({ error: 'invalid_restaurant' }, 400)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let locationFilter: string | null = null
  if (slugFilter) {
    const slugRes = await supabase
      .from('location_slugs')
      .select('location_id')
      .eq('slug', slugFilter)
      .maybeSingle()
    if (slugRes.error || !slugRes.data) return json({ error: 'invalid_restaurant' }, 404)
    locationFilter = slugRes.data.location_id
  }

  let profileQuery = supabase
    .from('restaurant_directory_profiles')
    .select('location_id, org_id, city, country_code, cuisine_labels, summary, hero_url, price_level, demo_rating, demo_rating_count')
    .eq('is_published', true)
    .order('created_at')
  if (locationFilter) profileQuery = profileQuery.eq('location_id', locationFilter)

  const profilesRes = await profileQuery
  if (profilesRes.error) return json({ error: 'directory_failed' }, 502)
  const profiles = (profilesRes.data ?? []) as ProfileRow[]
  if (slugFilter && profiles.length === 0) return json({ error: 'invalid_restaurant' }, 404)
  if (profiles.length === 0) {
    return json(slugFilter ? { error: 'invalid_restaurant' } : { restaurants: [] }, slugFilter ? 404 : 200)
  }

  const locationIds = profiles.map((profile) => profile.location_id)
  const [locationsRes, slugsRes] = await Promise.all([
    supabase
      .from('locations')
      .select('id, org_id, name, receipt_business_name, receipt_address, logo_url, service_mode, settings')
      .in('id', locationIds),
    supabase
      .from('location_slugs')
      .select('location_id, slug')
      .in('location_id', locationIds),
  ])
  if (locationsRes.error || slugsRes.error) return json({ error: 'directory_failed' }, 502)

  const locations = new Map(
    ((locationsRes.data ?? []) as LocationRow[]).map((location) => [location.id, location]),
  )
  const slugs = new Map(
    (slugsRes.data ?? []).map((row) => [row.location_id as string, row.slug as string]),
  )
  const uniqueOrgs = [...new Set(profiles.map((profile) => profile.org_id))]
  const gates = new Map<string, {
    public_menu?: boolean
    online_orders?: boolean
    table_service?: boolean
    public_reservations?: boolean
  }>()
  await Promise.all(uniqueOrgs.map(async (orgId) => {
    const result = await supabase.rpc('org_public_menu_gates', { p_org: orgId })
    if (!result.error && result.data) gates.set(orgId, result.data)
  }))

  const restaurants = profiles.flatMap((profile) => {
    const location = locations.get(profile.location_id)
    const slug = slugs.get(profile.location_id)
    const gate = gates.get(profile.org_id)
    if (!location || !slug || gate?.public_menu !== true) return []

    const displayName = location.settings?.display_name?.trim()
      || location.receipt_business_name?.trim()
      || location.name
    const reservationEnabled = location.settings?.reservations?.enabled === true
    const heroUrl = profile.hero_url
      || location.settings?.online_orders?.header_url
      || null

    return [{
      id: location.id,
      slug,
      name: displayName,
      address: location.receipt_address,
      city: profile.city,
      country_code: profile.country_code,
      coordinates: publicCoordinates(
        location.settings?.reservations?.lat,
        location.settings?.reservations?.lng,
      ),
      cuisine: profile.cuisine_labels ?? [],
      summary: profile.summary,
      hero_url: heroUrl,
      logo_url: location.logo_url,
      price_level: profile.price_level,
      rating: profile.demo_rating == null ? null : {
        value: Number(profile.demo_rating),
        count: profile.demo_rating_count ?? 0,
        source: 'demo',
      },
      features: {
        menu: true,
        ordering: gate?.online_orders === true,
        table_service:
          gate?.table_service === true && location.service_mode === 'tables',
        reservations: gate?.public_reservations === true && reservationEnabled,
      },
    }]
  })

  const cache = { 'Cache-Control': 'public, max-age=30' }
  if (slugFilter) {
    if (restaurants.length === 0) return json({ error: 'invalid_restaurant' }, 404)
    return json({ restaurant: restaurants[0] }, 200, cache)
  }
  return json({ restaurants }, 200, cache)
})
