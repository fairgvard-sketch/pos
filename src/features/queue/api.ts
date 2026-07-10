import { supabase } from '../../lib/supabase'

export interface QueueItemMod {
  name: string
}

export interface QueueItem {
  id: string
  name: string
  variant_name: string | null
  qty: number
  notes: string | null
  station_id: string | null
  prep_status: 'pending' | 'ready'
  order_item_modifiers: QueueItemMod[]
}

export interface QueueOrder {
  id: string
  daily_number: number
  order_type: 'here' | 'takeaway' | 'delivery'
  customer_name: string | null
  table_label: string | null
  status: string
  paid_at: string | null
  created_at: string
  order_items: QueueItem[]
}

/**
 * Заказы в очереди готовки, старые сверху (FIFO).
 * — оплаченные заказы стойки (status='paid')
 * — открытые счета столов (status='open' + table_id): в режиме tables
 *   готовим сразу, до оплаты. Чистая стойка их не создаёт, так что
 *   для counter-точки выборка эквивалентна прежней (только paid).
 *
 * Столовый заказ живёт в 'open' до оплаты (стол занят, пока гость сидит),
 * поэтому автоперехода в 'fulfilled' у него нет. Чтобы готовый стол ушёл
 * с экрана бариста, фильтруем по позициям: показываем стол, только пока
 * есть хоть одна pending-позиция. Дозаказ (новая pending) вернёт его в очередь.
 * Для paid-заказов из очереди их выводит переход paid → fulfilled (mark_*_ready).
 */
export async function fetchQueue(): Promise<QueueOrder[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id, daily_number, order_type, customer_name, table_label, status, paid_at, created_at, table_id,
      order_items (
        id, name, variant_name, qty, notes, station_id, prep_status,
        order_item_modifiers ( name )
      )
    `)
    .or('status.eq.paid,and(status.eq.open,table_id.not.is.null)')
    .is('order_items.voided_at', null)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data as (QueueOrder & { table_id: string | null })[]).filter((o) => {
    // Открытый счёт без позиций (только что сел гость) в очереди не показываем
    if (o.order_items.length === 0) return false
    // Столовый open-заказ: скрываем, когда всё приготовлено (нет pending)
    if (o.status === 'open' && o.table_id) {
      return o.order_items.some((i) => i.prep_status === 'pending')
    }
    return true
  })
}

export async function markItemReady(itemId: string, ready = true): Promise<void> {
  const { error } = await supabase.rpc('mark_item_ready', { p_item_id: itemId, p_ready: ready })
  if (error) throw new Error(error.message)
}

export async function markOrderReady(orderId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_order_ready', { p_order_id: orderId })
  if (error) throw new Error(error.message)
}

/**
 * Realtime-подписка на изменения очереди. Любое изменение orders/order_items
 * дёргает onChange — там просто инвалидируем кеш (перезапрос дёшев).
 */
export function subscribeQueue(onChange: () => void) {
  const channel = supabase
    .channel('queue')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, onChange)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}
