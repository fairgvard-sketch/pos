import { supabase } from '../../lib/supabase'

export interface ReceiptLine {
  name: string
  variant_name: string | null
  qty: number
  unit_price: number
  line_total: number
  modifiers: { name: string; price_delta: number }[]
}

export interface ReceiptPayment {
  method: 'cash' | 'card'
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
  order_type: 'here' | 'takeaway'
  customer_name: string | null
  table_label: string | null
  status: string
  subtotal: number
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  discount_amount: number
  vat_rate: number
  vat_amount: number
  total: number
  paid_at: string | null
  created_at: string
  staff_name: string | null
  lines: ReceiptLine[]
  payments: ReceiptPayment[]
}

interface OrderRow {
  id: string
  daily_number: number
  receipt_number: number | null
  doc_type: 'receipt' | 'tax_invoice' | 'invoice_receipt'
  allocation_number: string | null
  order_type: 'here' | 'takeaway'
  customer_name: string | null
  table_label: string | null
  status: string
  subtotal: number
  discount_type: 'percent' | 'fixed' | null
  discount_value: number | null
  discount_amount: number
  vat_rate: number
  vat_amount: number
  total: number
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
  payments: { method: 'cash' | 'card'; amount: number; tendered: number | null; change_due: number | null }[]
}

/** Полный чек по заказу: снапшот-итоги, активные позиции, платежи, кассир */
export async function fetchReceipt(orderId: string): Promise<Receipt> {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id, daily_number, receipt_number, doc_type, allocation_number,
      order_type, customer_name, table_label, status,
      subtotal, discount_type, discount_value, discount_amount, vat_rate, vat_amount, total,
      paid_at, created_at,
      staff(name),
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
    order_type: o.order_type,
    customer_name: o.customer_name,
    table_label: o.table_label,
    status: o.status,
    subtotal: o.subtotal,
    discount_type: o.discount_type,
    discount_value: o.discount_value,
    discount_amount: o.discount_amount,
    vat_rate: o.vat_rate,
    vat_amount: o.vat_amount,
    total: o.total,
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
