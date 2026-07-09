import { supabase } from '../../lib/supabase'
import type { CartDiscount, CartLine, CartRedeem, OrderType } from '../../store/cartStore'
import { applyLoyalty } from '../loyalty/api'

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
  tableLabel: string = '',
  guestId: string | null = null,
  redeem: CartRedeem | null = null
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
  const result = data as PlaceOrderResult

  // Лояльность вторым шагом: скидку и балансы валидирует сервер.
  // При ретрае после сбоя place_order вернёт duplicate — apply_loyalty
  // идемпотентен (перезаписывает привязку), итог остаётся верным.
  if (guestId) {
    const loy = await applyLoyalty(result.order_id, guestId, redeem)
    return { ...result, total: loy.total }
  }
  return result
}

export interface PaymentInput {
  method: 'cash' | 'card'
  amount: number
  tendered?: number
  change_due?: number
}

export interface SplitResult {
  new_order_id: string
  new_total: number
  daily_number: number
  remaining_total: number
}

/**
 * Разделить open-заказ: выбранные позиции (частичное qty поддерживается)
 * уезжают в новый заказ с отдельным чеком. Возвращает новый заказ и остаток.
 */
export async function splitOrder(
  orderId: string,
  staffId: string,
  items: { item_id: string; qty: number }[],
): Promise<SplitResult> {
  const { data, error } = await supabase.rpc('split_order', {
    p_order_id: orderId,
    p_staff_id: staffId,
    p_items: items,
  })
  if (error) throw new Error(error.message)
  return data as SplitResult
}

/** Принять оплату по заказу, перевести в paid и присвоить фискальный номер документа */
export async function payOrder(orderId: string, payments: PaymentInput[], tip: number = 0): Promise<void> {
  // Один round-trip: фискальный номер присваивает сам pay_order (041) —
  // отдельный вызов assign_receipt_number больше не нужен.
  // p_tip только при чаевых: до применения миграции 033 в БД живёт
  // двухаргументная pay_order — обычная оплата не должна ломаться
  const { error } = await supabase.rpc('pay_order', {
    p_order_id: orderId,
    p_payments: payments,
    ...(tip > 0 ? { p_tip: tip } : {}),
  })
  if (error) throw new Error(error.message)
}
