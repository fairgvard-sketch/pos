import { supabase } from '../../lib/supabase'
import type { CartLine, OrderType } from '../../store/cartStore'

export interface PlaceOrderResult {
  order_id: string
  daily_number: number
  total: number
  duplicate: boolean
}

/**
 * Оформление заказа. clientUuid генерирует касса ЗАРАНЕЕ (идемпотентность):
 * повторная отправка после сбоя сети не создаст дубликат.
 */
export async function placeOrder(
  clientUuid: string,
  staffId: string,
  orderType: OrderType,
  customerName: string,
  lines: CartLine[]
): Promise<PlaceOrderResult> {
  const { data, error } = await supabase.rpc('place_order', {
    p_client_uuid: clientUuid,
    p_staff_id: staffId,
    p_order_type: orderType,
    p_customer_name: customerName,
    p_items: lines.map((l) => ({
      menu_item_id: l.itemId,
      variant_id: l.variantId,
      modifier_ids: l.mods.map((m) => m.id),
      qty: l.qty,
      notes: l.notes,
    })),
  })
  if (error) throw new Error(error.message)
  return data as PlaceOrderResult
}
