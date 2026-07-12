import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'

/** Строка снапшота заявки (цены на момент заявки — для карточки кассира) */
export interface OnlineOrderLine {
  menu_item_id: string
  variant_id: string | null
  modifier_ids: string[]
  qty: number
  notes: string | null
  name: string
  variant_name: string | null
  unit_price: number
  line_total: number
  mods: { id: string; name: string; price_delta: number }[]
}

export type OnlineOrderStatus = 'new' | 'accepted' | 'rejected'

export interface OnlineOrder {
  id: string
  client_uuid: string
  customer_name: string
  customer_phone: string
  pickup_at: string | null // null = как можно скорее
  note: string | null
  /** Тип заказа гостя (055): here | takeaway | delivery */
  order_type: 'here' | 'takeaway' | 'delivery'
  /** Адрес доставки — только при order_type='delivery' */
  delivery_address: string | null
  items: OnlineOrderLine[]
  subtotal: number
  total: number
  status: OnlineOrderStatus
  reject_reason: string | null
  order_id: string | null
  created_at: string
  decided_at: string | null
  /** Связанный настоящий заказ (после принятия): статус и номер */
  order: { id: string; status: string; daily_number: number; total: number } | null
}

/**
 * Заявки для экрана: все новые + решённые за последние 24 часа
 * (история дня; старое доступно в Операциях по самим заказам).
 */
export async function fetchOnlineOrders(): Promise<OnlineOrder[]> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data, error } = await supabase
    .from('online_orders')
    .select('*, order:order_id ( id, status, daily_number, total )')
    .or(`status.eq.new,created_at.gte.${since}`)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(error.message)
  return data as OnlineOrder[]
}

export interface AcceptResult {
  order_id: string
  daily_number: number
  total: number
  duplicate: boolean
}

/** Принять заявку: создаёт настоящий заказ (takeaway, source='site') → очередь бариста */
export async function acceptOnlineOrder(onlineId: string, staffId: string): Promise<AcceptResult> {
  const { data, error } = await supabase.rpc('accept_online_order', {
    p_online_id: onlineId,
    p_staff_id: staffId,
  })
  if (error) throw new Error(error.message)
  return data as AcceptResult
}

/** Отклонить заявку (гость увидит статус и причину при поллинге) */
export async function rejectOnlineOrder(onlineId: string, staffId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('reject_online_order', {
    p_online_id: onlineId,
    p_staff_id: staffId,
    p_reason: reason ?? null,
  })
  if (error) throw new Error(error.message)
}

export interface OnlineStats {
  requests: number  // заявок за 7 дней
  accepted: number
  revenue: number   // продано онлайн-заказов (paid/fulfilled), агороты
}

/** Статистика онлайн-заказов за 7 дней (идея из Square Online) */
export async function fetchOnlineStats(): Promise<OnlineStats> {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
  const [oo, orders] = await Promise.all([
    supabase.from('online_orders').select('status').gte('created_at', since),
    supabase.from('orders').select('total, status').eq('source', 'site')
      .in('status', ['paid', 'fulfilled']).gte('created_at', since),
  ])
  if (oo.error) throw new Error(oo.error.message)
  if (orders.error) throw new Error(orders.error.message)
  return {
    requests: oo.data.length,
    accepted: oo.data.filter((r) => r.status === 'accepted').length,
    revenue: orders.data.reduce((s, o) => s + o.total, 0),
  }
}

/**
 * Пауза приёма онлайн-заказов (054, идея из Square): null = возобновить.
 * Право online_pause (по умолчанию — все) проверяется в БД.
 */
export async function setOnlinePause(pausedUntil: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_online_pause', {
    p_paused_until: pausedUntil,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

/** Время приготовления в минутах — гость видит его при заказе (054) */
export async function setOnlinePrepMinutes(minutes: number): Promise<void> {
  const { error } = await supabase.rpc('set_online_prep_minutes', {
    p_minutes: minutes,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

/**
 * Realtime-подписка на заявки: любое изменение → onChange (инвалидация
 * кэша). Имя канала уникально на каждый вызов: supabase.channel(name)
 * возвращает УЖЕ подписанный канал с тем же именем, и повторный .on()
 * после subscribe() кидает исключение (белый экран /online в проде,
 * когда подписывались и сайдбар, и страница).
 */
let channelSeq = 0
export function subscribeOnlineOrders(onChange: () => void) {
  const channel = supabase
    .channel(`online-orders-${++channelSeq}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'online_orders' }, onChange)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}
