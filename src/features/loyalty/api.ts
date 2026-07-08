import { supabase } from '../../lib/supabase'
import { getDeviceContext } from '../auth/api'
import type { CartRedeem } from '../../store/cartStore'
import type { Location } from '../../types'

/**
 * Лояльность (031): гости по телефону в рамках org.
 * Балансы (stamps/points) меняет только сервер — apply_loyalty ставит
 * награду на open-заказ, pay_order списывает/начисляет при оплате.
 */

export interface Guest {
  id: string
  phone: string
  name: string | null
  stamps: number
  points: number // агороты
  visits: number
  total_spent: number
  last_visit_at: string | null
}

const GUEST_COLS = 'id, phone, name, stamps, points, visits, total_spent, last_visit_at'

/** Телефон храним как одни цифры — поиск и уникальность не зависят от формата ввода */
export function normalizePhone(v: string): string {
  return v.replace(/\D/g, '')
}

/** Красивый вид телефона из цифр: 0501234567 → 050-123-4567 */
export function formatPhone(digits: string): string {
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  return digits
}

/** Поиск: цифры → по телефону (вхождение), иначе — по имени */
export async function searchGuests(query: string): Promise<Guest[]> {
  const q = query.trim()
  let req = supabase.from('guests').select(GUEST_COLS)
  const digits = normalizePhone(q)
  if (q === '') {
    req = req.order('last_visit_at', { ascending: false, nullsFirst: false }).limit(20)
  } else if (digits.length >= 3 && digits.length >= q.replace(/[\s\-+()]/g, '').length) {
    req = req.like('phone', `%${digits}%`).limit(20)
  } else {
    req = req.ilike('name', `%${q}%`).limit(20)
  }
  const { data, error } = await req
  if (error) throw new Error(error.message)
  return data as Guest[]
}

export async function createGuest(phone: string, name: string): Promise<Guest> {
  const { data: session } = await supabase.auth.getSession()
  const meta = session.session?.user.app_metadata as { org_id?: string } | undefined
  if (!meta?.org_id) throw new Error('Device not bootstrapped')
  const { data, error } = await supabase
    .from('guests')
    .insert({ org_id: meta.org_id, phone: normalizePhone(phone), name: name.trim() || null })
    .select(GUEST_COLS)
    .single()
  if (error) throw new Error(error.message)
  return data as Guest
}

export type LoyaltySettings = Pick<
  Location,
  'loyalty_mode' | 'loyalty_stamps_goal' | 'loyalty_points_percent' | 'loyalty_points_min_redeem'
>

export async function updateLoyaltySettings(s: LoyaltySettings): Promise<void> {
  const ctx = await getDeviceContext()
  if (!ctx?.locationId) throw new Error('Device not bootstrapped')
  const { error } = await supabase.from('locations').update(s).eq('id', ctx.locationId)
  if (error) throw new Error(error.message)
}

/**
 * Привязать гостя и награду к открытому заказу (или отвязать: guestId = null).
 * Скидку считает сервер; возвращает новый total заказа.
 */
export async function applyLoyalty(
  orderId: string,
  guestId: string | null,
  redeem: CartRedeem | null
): Promise<{ total: number; loyalty_discount: number }> {
  const { data, error } = await supabase.rpc('apply_loyalty', {
    p_order_id: orderId,
    p_guest_id: guestId,
    p_redeem: redeem ? { type: redeem.type, amount: redeem.amount } : null,
  })
  if (error) throw new Error(error.message)
  return data as { total: number; loyalty_discount: number }
}
