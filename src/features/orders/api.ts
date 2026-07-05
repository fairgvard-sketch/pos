import { supabase, withContext } from '../../lib/supabase'
import { updateOrderItemModifiers } from '../menu/modifiers'
import type { Order, OrderStatus } from '../../types'

export async function fetchActiveOrder(tableId: string): Promise<Order | null> {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      *,
      order_items (
        *,
        menu_item:menu_items (*),
        order_item_modifiers (
          modifier:modifiers (id, name, price_delta)
        )
      )
    `)
    .eq('table_id', tableId)
    .in('status', ['new', 'cooking', 'ready'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data as Order | null
}

export async function fetchOrder(orderId: string): Promise<Order> {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      *,
      table:tables (*),
      waiter:staff (*),
      order_items (
        *,
        menu_item:menu_items (*)
      )
    `)
    .eq('id', orderId)
    .single()

  if (error) throw error
  return data as Order
}

export async function createOrder(tableId: string, waiterId: string): Promise<Order> {
  return withContext(async () => {
    const { data, error } = await supabase
      .from('orders')
      .insert({ table_id: tableId, waiter_id: waiterId, status: 'new', total: 0 })
      .select()
      .single()

    if (error) throw error
    return data as Order
  })
}

export async function addOrderItems(
  orderId: string,
  items: { menu_item_id: string; qty: number; price: number; notes: string; modifierIds?: string[] }[]
) {
  return withContext(async () => {
    const { data, error } = await supabase
      .from('order_items')
      .insert(items.map((i) => ({
        order_id: orderId,
        menu_item_id: i.menu_item_id,
        qty: i.qty,
        price: i.price,
        notes: i.notes,
        status: 'pending',
      })))
      .select('id')

    if (error) throw error

    const modifierRows: { order_item_id: string; modifier_id: string }[] = []
    data.forEach((row, idx) => {
      const mods = items[idx].modifierIds ?? []
      mods.forEach((modifier_id) => modifierRows.push({ order_item_id: row.id, modifier_id }))
    })

    if (modifierRows.length > 0) {
      const { error: modErr } = await supabase.from('order_item_modifiers').insert(modifierRows)
      if (modErr) throw modErr
    }
  })
}

export async function updateOrderItemQty(itemId: string, qty: number) {
  return withContext(async () => {
    if (qty <= 0) {
      const { error } = await supabase.from('order_items').delete().eq('id', itemId)
      if (error) throw error
    } else {
      const { error } = await supabase.from('order_items').update({ qty }).eq('id', itemId)
      if (error) throw error
    }
  })
}

export async function updateOrderItemStatus(itemId: string, status: 'pending' | 'cooking' | 'ready' | 'served') {
  return withContext(async () => {
    const { error } = await supabase.from('order_items').update({ status }).eq('id', itemId)
    if (error) throw error
  })
}

export async function updateOrderItemNotes(itemId: string, notes: string) {
  return withContext(async () => {
    const { error } = await supabase.from('order_items').update({ notes }).eq('id', itemId)
    if (error) throw error
  })
}

export async function updateOrderItem(
  itemId: string,
  updates: { price?: number; notes?: string; modifierIds?: string[] }
) {
  return withContext(async () => {
    if (updates.price !== undefined || updates.notes !== undefined) {
      const patch: Record<string, unknown> = {}
      if (updates.price !== undefined) patch.price = updates.price
      if (updates.notes !== undefined) patch.notes = updates.notes
      const { error } = await supabase.from('order_items').update(patch).eq('id', itemId)
      if (error) throw error
    }
    if (updates.modifierIds !== undefined) {
      await updateOrderItemModifiers(itemId, updates.modifierIds)
    }
  })
}

export async function sendOrderToKitchen(orderId: string) {
  return withContext(async () => {
    const { error } = await supabase
      .from('orders')
      .update({ status: 'cooking' })
      .eq('id', orderId)
    if (error) throw error

    await supabase
      .from('order_items')
      .update({ status: 'cooking' })
      .eq('order_id', orderId)
      .eq('status', 'pending')
  })
}

export async function requestBill(_orderId: string, tableId: string) {
  return withContext(async () => {
    const { error } = await supabase
      .from('tables')
      .update({ status: 'waiting_bill' })
      .eq('id', tableId)
    if (error) throw error
  })
}

export async function fetchAllActiveOrders(): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      *,
      table:tables (*),
      order_items (
        *,
        menu_item:menu_items (*)
      )
    `)
    .in('status', ['new', 'cooking', 'ready'])
    .order('created_at', { ascending: true })

  if (error) throw error
  return data as Order[]
}

export async function updateOrderStatus(orderId: string, status: OrderStatus) {
  return withContext(async () => {
    const { error } = await supabase.from('orders').update({ status }).eq('id', orderId)
    if (error) throw error

    if (status === 'ready') {
      const { error: itemsError } = await supabase
        .from('order_items')
        .update({ status: 'ready' })
        .eq('order_id', orderId)
        .eq('status', 'cooking')
      if (itemsError) throw itemsError
    }
  })
}

export async function voidOrderItem(itemId: string) {
  return withContext(async () => {
    const { error } = await supabase.from('order_items').delete().eq('id', itemId)
    if (error) throw error
  })
}

export async function moveOrderItems(
  itemIds: string[],
  fromOrderId: string,
  fromTableId: string,
  toTableId: string,
  waiterId: string,
) {
  return withContext(async () => {
    // Get or create active order on target table
    let { data: existingOrders, error: fetchErr } = await supabase
      .from('orders')
      .select('id')
      .eq('table_id', toTableId)
      .in('status', ['new', 'cooking', 'ready'])
      .order('created_at', { ascending: false })
      .limit(1)
    if (fetchErr) throw fetchErr

    let toOrderId: string
    if (existingOrders && existingOrders.length > 0) {
      toOrderId = existingOrders[0].id
    } else {
      const { data: newOrder, error: createErr } = await supabase
        .from('orders')
        .insert({ table_id: toTableId, waiter_id: waiterId, status: 'new', total: 0 })
        .select('id')
        .single()
      if (createErr) throw createErr
      toOrderId = newOrder.id
      // Mark target table occupied
      await supabase.from('tables').update({ status: 'occupied' }).eq('id', toTableId)
    }

    // Move items to target order
    const { error: moveErr } = await supabase
      .from('order_items')
      .update({ order_id: toOrderId })
      .in('id', itemIds)
    if (moveErr) throw moveErr

    // Check if source order has remaining items
    const { data: remaining, error: remErr } = await supabase
      .from('order_items')
      .select('id')
      .eq('order_id', fromOrderId)
    if (remErr) throw remErr

    if (!remaining || remaining.length === 0) {
      // Delete empty source order and free table
      await supabase.from('orders').delete().eq('id', fromOrderId)
      await supabase.from('tables').update({ status: 'free' }).eq('id', fromTableId)
    }
  })
}

export async function updateOrderCustomerName(orderId: string, name: string) {
  return withContext(async () => {
    const { error } = await supabase
      .from('orders')
      .update({ customer_name: name || null })
      .eq('id', orderId)
    if (error) throw error
  })
}

export async function cancelOrder(orderId: string, tableId: string) {
  return withContext(async () => {
    const { error: itemsErr } = await supabase
      .from('order_items')
      .delete()
      .eq('order_id', orderId)
    if (itemsErr) throw itemsErr

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
