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
  /** Автовозврат на hero нужен только общему киоск-устройству, не телефону гостя. */
  kiosk: boolean
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
 * Канонический домен гостевых продуктов во всех сборках, включая локальный
 * бэкофис: QR, скопированная ссылка и печатный флаер всегда должны совпадать
 * с production. Для отдельного локального стенда origin можно явно
 * переопределить через VITE_PUBLIC_MENU_ORIGIN.
 */
export function publicAppOrigin(): string {
  const configured = import.meta.env.VITE_PUBLIC_MENU_ORIGIN?.trim()
  const candidate = configured || DEFAULT_PUBLIC_APP_ORIGIN
  try {
    return new URL(candidate).origin
  } catch {
    return DEFAULT_PUBLIC_APP_ORIGIN
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
  const rawKiosk = params.get('kiosk')?.trim().toLowerCase()
  const kiosk = rawKiosk === '1' || rawKiosk === 'true'

  return { tableToken, requestedType: tableToken ? 'here' : requestedType, channel, kiosk }
}

/**
 * Слаг точки (106), если владелец его задал: /order/bulochka вместо
 * /order/<uuid>. UUID остаётся рабочим входом — на столах уже наклеены QR
 * со старыми ссылками, и ломать их нельзя.
 */
export function publicOrderUrl(
  origin: string,
  locationId: string,
  options: {
    tableToken?: string | null
    channel?: PublicOrderChannel
    mode?: PublicOrderType
    slug?: string | null
  } = {},
): string {
  const url = new URL(`/order/${options.slug || locationId}`, origin)
  if (options.tableToken) {
    url.searchParams.set('table', options.tableToken)
    url.searchParams.set('source', 'table_qr')
  } else {
    if (options.mode) url.searchParams.set('mode', options.mode)
    if (options.channel && options.channel !== 'link') url.searchParams.set('source', options.channel)
  }
  return url.toString()
}

export function publicReservationUrl(
  origin: string,
  locationId: string,
  slug?: string | null,
): string {
  return new URL(`/reserve/${slug || locationId}`, origin).toString()
}
