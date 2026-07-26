import type { PublicOrderType } from './publicApi'

export type PublicOrderChannel =
  | 'link'
  | 'counter_qr'
  | 'table_qr'
  | 'website'
  | 'social'

export interface PublicOrderQueryContext {
  tableToken: string | null
  requestedType: PublicOrderType | null
  channel: PublicOrderChannel
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHANNELS = new Set<PublicOrderChannel>([
  'link',
  'counter_qr',
  'table_qr',
  'website',
  'social',
])
const DEFAULT_PUBLIC_APP_ORIGIN = 'https://menu.angle.co.il'

/**
 * Канонический домен гостевых продуктов. На localhost оставляем текущий
 * origin, чтобы QR можно было проверять без production-домена.
 */
export function publicAppOrigin(currentOrigin = window.location.origin): string {
  const configured = import.meta.env.VITE_PUBLIC_MENU_ORIGIN?.trim()
  const candidate = configured || (import.meta.env.PROD ? DEFAULT_PUBLIC_APP_ORIGIN : currentOrigin)
  try {
    return new URL(candidate).origin
  } catch {
    return import.meta.env.PROD ? DEFAULT_PUBLIC_APP_ORIGIN : currentOrigin
  }
}

/**
 * Контекст гостевой ссылки не считается доверенным — это только UX-подсказка.
 * Токен стола и включённый тип заказа повторно валидирует submit_online_order.
 */
export function parsePublicOrderQuery(search: string): PublicOrderQueryContext {
  const params = new URLSearchParams(search)
  const rawTable = params.get('table')?.trim() ?? ''
  const tableToken = UUID_RE.test(rawTable) ? rawTable : null

  const rawMode = params.get('mode')?.trim().toLowerCase()
  const requestedType: PublicOrderType | null =
    rawMode === 'here'
      ? 'here'
      : rawMode === 'takeaway' || rawMode === 'pickup'
        ? 'takeaway'
        : rawMode === 'delivery'
          ? 'delivery'
          : null

  const rawChannel = params.get('source')?.trim().toLowerCase() as PublicOrderChannel | undefined
  const channel = tableToken
    ? 'table_qr'
    : rawChannel && CHANNELS.has(rawChannel)
      ? rawChannel
      : 'link'

  return { tableToken, requestedType: tableToken ? 'here' : requestedType, channel }
}

export function publicOrderUrl(
  origin: string,
  locationId: string,
  options: { tableToken?: string | null; channel?: PublicOrderChannel; mode?: PublicOrderType } = {},
): string {
  const url = new URL(`/order/${locationId}`, origin)
  if (options.tableToken) {
    url.searchParams.set('table', options.tableToken)
    url.searchParams.set('source', 'table_qr')
  } else {
    if (options.mode) url.searchParams.set('mode', options.mode)
    if (options.channel && options.channel !== 'link') url.searchParams.set('source', options.channel)
  }
  return url.toString()
}

export function publicReservationUrl(origin: string, locationId: string): string {
  return new URL(`/reserve/${locationId}`, origin).toString()
}
