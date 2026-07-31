const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Тот же формат, что и CHECK location_slugs_format в 106: строчные
 *  латиница/цифры/дефис, дефис не с краю, 3–40 символов. Слаг подставляется
 *  в start_url, поэтому проверяется так же строго, как UUID. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const MODES = new Set(['here', 'takeaway', 'delivery'])
const SOURCES = new Set(['link', 'counter_qr', 'table_qr', 'website', 'social'])

export interface MenuWebManifest {
  name: string
  short_name: string
  description: string
  id: string
  start_url: string
  scope: string
  lang: string
  dir: 'rtl'
  display: 'standalone'
  orientation: 'portrait'
  background_color: string
  theme_color: string
  icons: {
    src: string
    sizes: string
    type: string
    purpose?: 'maskable'
  }[]
}

function cleanName(value: string | null): string {
  const withoutControls = Array.from(value ?? '')
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 32 && code !== 127
    })
    .join('')
  const clean = withoutControls
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return clean || 'Angle Menu'
}

/**
 * Строит отдельное установленное web-приложение для точки/стола.
 * Все параметры считаются недоверенными: в start_url проходят только UUID
 * и закрытые наборы mode/source. Так manifest нельзя превратить в open redirect.
 */
export function buildMenuManifest(params: URLSearchParams): MenuWebManifest | null {
  // Публичная ссылка бывает и /order/<uuid>, и /order/<slug> (106).
  // Оба варианта попадают в start_url как есть, поэтому оба валидируются.
  const locationId = params.get('loc')?.trim() ?? ''
  if (!UUID_RE.test(locationId) && !SLUG_RE.test(locationId)) return null

  const rawTable = params.get('table')?.trim() ?? ''
  const tableToken = UUID_RE.test(rawTable) ? rawTable : null
  const rawMode = params.get('mode')?.trim().toLowerCase() ?? ''
  const mode = !tableToken && MODES.has(rawMode) ? rawMode : null
  const rawSource = params.get('source')?.trim().toLowerCase() ?? ''
  const source = tableToken
    ? 'table_qr'
    : SOURCES.has(rawSource)
      ? rawSource
      : null

  const startParams = new URLSearchParams()
  if (tableToken) startParams.set('table', tableToken)
  if (mode) startParams.set('mode', mode)
  if (source && source !== 'link') startParams.set('source', source)

  // Гостевых поверхностей две: витрина/заказ и бронь (118). У каждой свой
  // scope, иначе установленное приложение брони уводило бы гостя в меню.
  // Значение из закрытого набора — в start_url недоверенное не попадает.
  const surface = params.get('surface')?.trim().toLowerCase() === 'reserve' ? 'reserve' : 'order'
  const basePath = `/${surface}/${locationId}`
  const startUrl = startParams.size > 0 ? `${basePath}?${startParams.toString()}` : basePath
  const appId = tableToken ? `${basePath}?table=${tableToken}` : basePath
  const name = cleanName(params.get('name'))

  return {
    name,
    short_name: name.slice(0, 24),
    description: surface === 'reserve' ? 'Table reservations' : 'Digital menu and ordering',
    id: appId,
    start_url: startUrl,
    scope: `/${surface}/`,
    lang: 'he',
    dir: 'rtl',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f8f9fb',
    theme_color: '#111827',
    icons: [
      { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

/** Обновляет install-имя после того, как публичный API вернул бренд точки. */
export function updateInstalledMenuName(name: string): void {
  const link = document.querySelector<HTMLLinkElement>('#app-manifest[rel="manifest"]')
  if (!link || !link.href.includes('/api/menu-manifest')) return
  const url = new URL(link.href)
  url.searchParams.set('name', cleanName(name))
  link.href = url.toString()
}
