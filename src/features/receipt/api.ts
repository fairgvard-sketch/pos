import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'
import type { PayMethodId } from '../../lib/payMethods'

export interface ReceiptLine {
  name: string
  variant_name: string | null
  qty: number
  unit_price: number
  line_total: number
  modifiers: { name: string; price_delta: number }[]
}

export interface ReceiptPayment {
  method: PayMethodId
  amount: number
  tendered: number | null
  change_due: number | null
}

export interface Receipt {
  order_id: string
  daily_number: number
  receipt_number: number | null
  doc_type: 'receipt' | 'tax_invoice' | 'invoice_receipt'
  allocation_number: string | null
  /** Покупатель-бизнес (048): блок на чеке — חשבונית מס для B2B */
  buyer_name: string | null
  buyer_tax_id: string | null
  order_type: 'here' | 'takeaway' | 'delivery'
  customer_name: string | null
  table_label: string | null
  status: string
  subtotal: number
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  discount_amount: number
  loyalty_discount: number
  vat_rate: number
  vat_amount: number
  total: number
  /** Чаевые — сверх total, вне базы НДС */
  tip_amount: number
  paid_at: string | null
  created_at: string
  staff_name: string | null
  lines: ReceiptLine[]
  payments: ReceiptPayment[]
  /**
   * Офлайн (фаза 7): чек построен на кассе без сервера — временный
   * документ. Печатается с пометкой «מסמך זמני» и локальным номером
   * заказа (K-n); фискальный receipt_number присвоится при синхронизации.
   */
  provisional?: boolean
  provisional_number?: string | null
}

export interface RefundReceipt {
  refund_id: string
  refund_number: number | null
  amount: number
  method: PayMethodId
  reason: string | null
  items: { name: string; qty: number; amount: number }[] | null
  created_at: string
  staff_name: string | null
  /** Исходный документ */
  daily_number: number
  receipt_number: number | null
  doc_type: 'receipt' | 'tax_invoice' | 'invoice_receipt'
  vat_rate: number
  /** Доля НДС в возвращаемой сумме (пропорция исходного чека) */
  vat_amount: number
}

/** Данные תעודת זיכוי: возврат + реквизиты исходного чека */
export async function fetchRefundReceipt(refundId: string): Promise<RefundReceipt> {
  const { data, error } = await supabase
    .from('refunds')
    .select('id, refund_number, amount, method, reason, items, created_at, staff(name), orders(daily_number, receipt_number, doc_type, vat_rate, vat_amount, total)')
    .eq('id', refundId)
    .single()
  if (error) throw new Error(error.message)
  const r = data as unknown as {
    id: string
    refund_number: number | null
    amount: number
    method: PayMethodId
    reason: string | null
    items: { name: string; qty: number; amount: number }[] | null
    created_at: string
    staff: { name: string } | null
    orders: { daily_number: number; receipt_number: number | null; doc_type: RefundReceipt['doc_type']; vat_rate: number; vat_amount: number; total: number }
  }
  const o = r.orders
  return {
    refund_id: r.id,
    refund_number: r.refund_number,
    amount: r.amount,
    method: r.method,
    reason: r.reason,
    items: r.items,
    created_at: r.created_at,
    staff_name: r.staff?.name ?? null,
    daily_number: o.daily_number,
    receipt_number: o.receipt_number,
    doc_type: o.doc_type,
    vat_rate: o.vat_rate,
    vat_amount: o.total > 0 ? Math.round((r.amount * o.vat_amount) / o.total) : 0,
  }
}

interface OrderRow {
  id: string
  daily_number: number
  receipt_number: number | null
  doc_type: 'receipt' | 'tax_invoice' | 'invoice_receipt'
  allocation_number: string | null
  buyer_name: string | null
  buyer_tax_id: string | null
  order_type: 'here' | 'takeaway' | 'delivery'
  customer_name: string | null
  table_label: string | null
  status: string
  subtotal: number
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  discount_amount: number
  loyalty_discount: number
  vat_rate: number
  vat_amount: number
  total: number
  tip_amount: number
  paid_at: string | null
  created_at: string
  staff: { name: string } | null
  order_items: {
    name: string
    variant_name: string | null
    qty: number
    unit_price: number
    line_total: number
    voided_at: string | null
    order_item_modifiers: { name: string; price_delta: number }[]
  }[]
  payments: { method: PayMethodId; amount: number; tendered: number | null; change_due: number | null }[]
}

/**
 * Реквизиты покупателя-бизнеса на оплаченный документ (048):
 * печатаются блоком на чеке (חשבונית מס для B2B). Один раз на документ.
 */
export async function setOrderBuyer(orderId: string, name: string, taxId: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_order_buyer', {
    p_order_id: orderId,
    p_name: name,
    p_tax_id: taxId,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

/** Полный чек по заказу: снапшот-итоги, активные позиции, платежи, кассир */
export async function fetchReceipt(orderId: string): Promise<Receipt> {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id, daily_number, receipt_number, doc_type, allocation_number,
      buyer_name, buyer_tax_id,
      order_type, customer_name, table_label, status,
      subtotal, discount_type, discount_value, discount_amount, loyalty_discount, vat_rate, vat_amount, total, tip_amount,
      paid_at, created_at,
      staff:staff!orders_staff_id_fkey(name),
      order_items(name, variant_name, qty, unit_price, line_total, voided_at, order_item_modifiers(name, price_delta)),
      payments(method, amount, tendered, change_due)
    `)
    .eq('id', orderId)
    .single()
  if (error) throw new Error(error.message)
  const o = data as unknown as OrderRow
  return {
    order_id: o.id,
    daily_number: o.daily_number,
    receipt_number: o.receipt_number,
    doc_type: o.doc_type,
    allocation_number: o.allocation_number,
    buyer_name: o.buyer_name,
    buyer_tax_id: o.buyer_tax_id,
    order_type: o.order_type,
    customer_name: o.customer_name,
    table_label: o.table_label,
    status: o.status,
    subtotal: o.subtotal,
    discount_type: o.discount_type,
    discount_value: o.discount_value,
    discount_amount: o.discount_amount,
    loyalty_discount: o.loyalty_discount,
    vat_rate: o.vat_rate,
    vat_amount: o.vat_amount,
    total: o.total,
    tip_amount: o.tip_amount ?? 0,
    paid_at: o.paid_at,
    created_at: o.created_at,
    staff_name: o.staff?.name ?? null,
    lines: (o.order_items ?? [])
      .filter((i) => i.voided_at === null)
      .map((i) => ({
        name: i.name,
        variant_name: i.variant_name,
        qty: i.qty,
        unit_price: i.unit_price,
        line_total: i.line_total,
        modifiers: (i.order_item_modifiers ?? []).map((m) => ({ name: m.name, price_delta: m.price_delta })),
      })),
    payments: (o.payments ?? []).map((p) => ({
      method: p.method,
      amount: p.amount,
      tendered: p.tendered,
      change_due: p.change_due,
    })),
  }
}
