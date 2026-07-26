/**
 * Клиент публичного API (050) для страницы гостя /order/:locId.
 * Ходит ТОЛЬКО в Edge Functions (public-menu / public-order) с anon-ключом —
 * прямого доступа к таблицам у гостя нет, всё решает сервер.
 */

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

const headers = {
  'Content-Type': 'application/json',
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
}

export interface PublicVariant {
  id: string
  name: string
  price: number
  is_default: boolean
}

export interface PublicModifier {
  id: string
  name: string
  price_delta: number
  is_default: boolean
}

export interface PublicModifierGroup {
  id: string
  name: string
  min_select: number
  max_select: number // 0 = без ограничения
  modifiers: PublicModifier[]
}

export interface PublicItem {
  id: string
  name: string
  price: number
  description: string | null
  image_url: string | null
  variants: PublicVariant[]
  modifier_groups: PublicModifierGroup[]
}

export interface PublicMenu {
  location: {
    id: string
    name: string
    /** Название заведения (шапка чека); показываем его, не имя точки */
    business_name?: string
    /** Логотип заведения (052) */
    logo_url?: string | null
    currency: string
    is_open: boolean
    /**
     * Модули организации (100). online_orders=false — организация без модуля
     * заказов: страница работает чистой витриной (без корзины, чекаута и
     * статуса приёма). Отсутствие поля (старая edge function) = заказ доступен.
     */
    modules?: { online_orders?: boolean }
    /** false = приём сейчас не идёт: выключен (051) или пауза (054) */
    accepting?: boolean
    /** Пауза с кассы (054): ISO-время, когда приём возобновится */
    paused_until?: string | null
    /** Время приготовления — вилка мин–макс, минуты; «готовим ~N–M мин» (061) */
    prep_min?: number | null
    prep_max?: number | null
    /** Типы заказа для гостя (058): здесь/с собой/доставка. Дефолт — here+takeaway */
    order_types?: ('here' | 'takeaway' | 'delivery')[]
    /** Баннер-шапка главного экрана; логотип и название — поверх */
    header_url?: string | null
    /** Декоративное видео hero: autoplay + muted + loop, poster = header_url. */
    hero_video_url?: string | null
    /** Фон главного экрана; шапка накладывается поверх */
    background_url?: string | null
    /** Соцссылки подвала — настраиваются в кассе, пусто = не показывать */
    links?: {
      instagram?: string | null
      facebook?: string | null
      google_review?: string | null
    }
  }
  /** Проверенный сервером контекст QR конкретного стола. */
  order_context?: {
    kind: 'table'
    label: string
    zone: string | null
  } | null
  /** Просроченный/неверный table-token: меню доступно, но заказ не привязан к столу. */
  context_error?: 'invalid_table' | 'table_ordering_disabled' | null
  categories: { id: string; name: string; cover_url?: string | null; items: PublicItem[] }[]
}

/**
 * Витрина без заказа (100): организация без модуля online_orders.
 * Отсутствие поля modules (старая edge function) = заказ доступен —
 * поведение существующих клиентов не меняется.
 */
export function isViewOnlyMenu(location: PublicMenu['location'] | undefined): boolean {
  return location?.modules?.online_orders === false
}

/** Осмысленная ошибка публичного API: code — ключ для перевода гостю */
export class PublicApiError extends Error {
  code: string
  detail?: string
  constructor(code: string, detail?: string) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

export async function parseError(res: Response): Promise<never> {
  let code = 'unknown'
  let detail: string | undefined
  try {
    const body = await res.json()
    if (typeof body?.error === 'string') code = body.error
    if (typeof body?.detail === 'string') detail = body.detail
  } catch { /* не-JSON ответ — оставляем unknown */ }
  throw new PublicApiError(code, detail)
}

export async function fetchPublicMenu(locId: string, tableToken?: string | null): Promise<PublicMenu> {
  const params = new URLSearchParams({ loc: locId })
  if (tableToken) params.set('table', tableToken)
  const res = await fetch(`${FN_BASE}/public-menu?${params.toString()}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}

export type PublicOrderType = 'here' | 'takeaway' | 'delivery'

export interface SubmitPayload {
  loc: string
  client_uuid: string
  name: string
  phone: string
  pickup_at: string | null
  note: string | null
  order_type: PublicOrderType
  delivery_address: string | null
  /** Непрозрачный токен из QR; сервер сам разрешает его в table_id/label. */
  table_token: string | null
  /** Атрибуция без влияния на права и цены. */
  order_channel: 'link' | 'counter_qr' | 'table_qr' | 'website' | 'social'
  items: {
    menu_item_id: string
    variant_id: string | null
    modifier_ids: string[]
    qty: number
    notes: string | null
  }[]
}

export interface SubmitResult {
  online_id: string
  total: number
  duplicate: boolean
}

export async function submitPublicOrder(payload: SubmitPayload): Promise<SubmitResult> {
  const res = await fetch(`${FN_BASE}/public-order`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  if (!res.ok) await parseError(res)
  return res.json()
}

export interface PublicStatus {
  /**
   * new/accepted/rejected — исходный цикл (050, POS-приёмка).
   * preparing/ready/completed/cancelled — standalone-цикл веб-инбокса (101):
   * заявка обслуживается в кабинете, POS-заказа (order_id) не существует.
   */
  status: 'new' | 'accepted' | 'preparing' | 'ready' | 'completed' | 'rejected' | 'cancelled'
  reject_reason: string | null
  total: number
  daily_number: number | null
  /** Статус настоящего заказа: open (готовится) | paid/fulfilled (выдан) | voided */
  order_status: string | null
  /** Тип заказа гостя (055) */
  order_type?: PublicOrderType
  /** Стол из проверенного QR-контекста; null для стойки/навынос/доставки. */
  table_label?: string | null
  order_channel?: 'link' | 'counter_qr' | 'table_qr' | 'website' | 'social'
  created_at: string
  /** Момент принятия заказа кассой (061), ISO — старт таймера у гостя */
  decided_at?: string | null
  /** Вилка приготовления, минуты (061): финиш таймера = decided_at + prep_max */
  prep_min?: number | null
  prep_max?: number | null
}

export async function fetchPublicStatus(clientUuid: string): Promise<PublicStatus> {
  const res = await fetch(`${FN_BASE}/public-order?id=${encodeURIComponent(clientUuid)}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}
