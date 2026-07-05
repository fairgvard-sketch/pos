import { supabase, withContext } from '../../lib/supabase'
import type { PaymentMethod } from '../../types'

export interface RefundItem {
  order_item_id: string
  name: string
  qty: number
  price: number
}

export async function fetchPaidOrders() {
  return withContext(async () => {
    const { data, error } = await supabase
      .from('orders')
      .select('id, created_at, total, table:tables(number), order_items(id, qty, price, menu_item:menu_items(name))')
      .eq('status', 'paid')
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error
    return data as any[]
  })
}

export async function processRefund(
  orderId: string,
  staffId: string,
  items: RefundItem[],
  reason: string
) {
  return withContext(async () => {
    const amount = items.reduce((s, i) => s + i.price * i.qty, 0)
    const { error } = await supabase.from('refunds').insert({
      order_id: orderId,
      staff_id: staffId,
      amount,
      reason: reason || null,
      items: items.map((i) => ({ order_item_id: i.order_item_id, name: i.name, qty: i.qty, price: i.price })),
    })
    if (error) throw error
    return amount
  })
}

export interface CardcomSession {
  lowProfileCode: string
  url: string
}

export async function createCardcomSession(
  orderId: string,
  amount: number,
  successUrl: string,
  cancelUrl: string
): Promise<CardcomSession> {
  const { data, error } = await supabase.functions.invoke('cardcom-payment', {
    body: { orderId, amount, successUrl, cancelUrl },
  })
  if (error) throw new Error(error.message)
  if (data.error) throw new Error(data.error)
  return data as CardcomSession
}

export async function processPayment(
  orderId: string,
  tableId: string,
  method: PaymentMethod,
  amount: number
) {
  return withContext(async () => {
    const { error: payErr } = await supabase.from('payments').insert({
      order_id: orderId,
      method,
      amount,
    })
    if (payErr) throw payErr

    const { error: orderErr } = await supabase
      .from('orders')
      .update({ status: 'paid' })
      .eq('id', orderId)
    if (orderErr) throw orderErr

    const { error: tableErr } = await supabase
      .from('tables')
      .update({ status: 'free' })
      .eq('id', tableId)
    if (tableErr) throw tableErr
  })
}

export async function processSplitPayment(
  orderId: string,
  tableId: string,
  splits: { method: PaymentMethod; amount: number }[]
) {
  return withContext(async () => {
    const { error: payErr } = await supabase.from('payments').insert(
      splits.map((s) => ({ order_id: orderId, method: s.method, amount: s.amount }))
    )
    if (payErr) throw payErr

    const { error: orderErr } = await supabase
      .from('orders')
      .update({ status: 'paid' })
      .eq('id', orderId)
    if (orderErr) throw orderErr

    const { error: tableErr } = await supabase
      .from('tables')
      .update({ status: 'free' })
      .eq('id', tableId)
    if (tableErr) throw tableErr
  })
}
