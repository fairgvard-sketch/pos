import { supabase } from '../../lib/supabase'
import type { CartDiscount, CartLine, OrderType } from '../../store/cartStore'

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
  lines: CartLine[],
  discount: CartDiscount | null = null,
  tableLabel: string = ''
): Promise<PlaceOrderResult> {
  const { data, error } = await supabase.rpc('place_order', {
    p_client_uuid: clientUuid,
    p_staff_id: staffId,
    p_order_type: orderType,
    p_customer_name: customerName,
    p_table_label: tableLabel || null,
    p_items: lines.map((l) => ({
      menu_item_id: l.itemId,
      variant_id: l.variantId,
      modifier_ids: l.mods.map((m) => m.id),
      qty: l.qty,
      notes: l.notes,
      // Свободная позиция: имя приходит от кассы (в каталоге товара нет)
      custom_name: l.itemId === null ? l.name : null,
      unit_price_override: l.priceOverride,
    })),
    // Скидку считает сервер из type+value — клиент присылает намерение
    p_discount:
      discount && discount.value > 0
        ? { type: discount.type, value: discount.value, reason: discount.reason || null }
        : null,
  })
  if (error) throw new Error(error.message)
  return data as PlaceOrderResult
}

export interface PaymentInput {
  method: 'cash' | 'card'
  amount: number
  tendered?: number
  change_due?: number
}

/** Принять оплату по заказу и перевести его в paid */
export async function payOrder(orderId: string, payments: PaymentInput[]): Promise<void> {
  const { error } = await supabase.rpc('pay_order', {
    p_order_id: orderId,
    p_payments: payments,
  })
  if (error) throw new Error(error.message)
}
