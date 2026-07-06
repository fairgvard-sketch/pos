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
  order_type: 'here' | 'takeaway'
  customer_name: string | null
  status: string
  paid_at: string | null
  created_at: string
  order_items: QueueItem[]
}

/** Оплаченные заказы (в очереди), старые сверху — FIFO */
export async function fetchQueue(): Promise<QueueOrder[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id, daily_number, order_type, customer_name, status, paid_at, created_at,
      order_items (
        id, name, variant_name, qty, notes, station_id, prep_status,
        order_item_modifiers ( name )
      )
    `)
    .eq('status', 'paid')
    .order('paid_at', { ascending: true })
  if (error) throw error
  return data as QueueOrder[]
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
