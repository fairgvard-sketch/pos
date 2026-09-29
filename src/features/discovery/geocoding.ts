export interface AddressSearchResult {
  id: string
  label: string
  lat: number
  lng: number
}

const resultCache = new Map<string, AddressSearchResult[]>()
let lastRequestAt = 0

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

export async function searchAddresses(query: string, language = 'en'): Promise<AddressSearchResult[]> {
  const normalizedQuery = query.trim()
  if (normalizedQuery.length < 3) return []

  const cacheKey = `${language}:${normalizedQuery.toLocaleLowerCase()}`
  const cached = resultCache.get(cacheKey)
  if (cached) return cached

  const delay = Math.max(0, 1_000 - (Date.now() - lastRequestAt))
  if (delay > 0) await wait(delay)
  lastRequestAt = Date.now()

  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', normalizedQuery)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', '5')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('layer', 'address')
  url.searchParams.set('accept-language', language)

  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error('address_search_failed')

  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) throw new Error('address_search_failed')

  const results = payload.flatMap((candidate): AddressSearchResult[] => {
    if (!candidate || typeof candidate !== 'object') return []
    const record = candidate as Record<string, unknown>
    const lat = Number(record.lat)
    const lng = Number(record.lon)
    const label = typeof record.display_name === 'string' ? record.display_name.trim() : ''
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !label) return []
    const rawId = record.osm_id ?? record.place_id ?? `${lat}:${lng}`
    return [{ id: `${record.osm_type ?? 'place'}:${String(rawId)}`, label, lat, lng }]
  })

  resultCache.set(cacheKey, results)
  return results
}
