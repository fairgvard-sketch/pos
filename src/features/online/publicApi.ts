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
    /** false = владелец выключил приём онлайн-заказов (051) */
    accepting?: boolean
  }
  categories: { id: string; name: string; items: PublicItem[] }[]
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

async function parseError(res: Response): Promise<never> {
  let code = 'unknown'
  let detail: string | undefined
  try {
    const body = await res.json()
    if (typeof body?.error === 'string') code = body.error
    if (typeof body?.detail === 'string') detail = body.detail
  } catch { /* не-JSON ответ — оставляем unknown */ }
  throw new PublicApiError(code, detail)
}

export async function fetchPublicMenu(locId: string): Promise<PublicMenu> {
  const res = await fetch(`${FN_BASE}/public-menu?loc=${encodeURIComponent(locId)}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}

export interface SubmitPayload {
  loc: string
  client_uuid: string
  name: string
  phone: string
  pickup_at: string | null
  note: string | null
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
  status: 'new' | 'accepted' | 'rejected'
  reject_reason: string | null
  total: number
  daily_number: number | null
  /** Статус настоящего заказа: open (готовится) | paid/fulfilled (выдан) | voided */
  order_status: string | null
  created_at: string
}

export async function fetchPublicStatus(clientUuid: string): Promise<PublicStatus> {
  const res = await fetch(`${FN_BASE}/public-order?id=${encodeURIComponent(clientUuid)}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}
