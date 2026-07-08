import { supabase } from '../../lib/supabase'

export interface TxPayment {
  method: 'cash' | 'card'
  amount: number
}

export interface Transaction {
  id: string
  daily_number: number
  receipt_number: number | null
  total: number
  status: 'paid' | 'fulfilled' | 'refunded'
  paid_at: string | null
  created_at: string
  customer_name: string | null
  table_label: string | null
  staff: { name: string } | null
  payments: TxPayment[]
}

/** Журнал операций: оплаченные/возвращённые заказы, свежие сверху */
export async function fetchTransactions(): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('orders')
    // staff указываем через явный FK: после 025 у orders ДВА FK на staff
    // (staff_id и refunded_by) — без уточнения embedded-join неоднозначен
    .select('id, daily_number, receipt_number, total, status, paid_at, created_at, customer_name, table_label, staff:staff!orders_staff_id_fkey(name), payments(method, amount)')
    .in('status', ['paid', 'fulfilled', 'refunded'])
    .order('paid_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)
  return data as unknown as Transaction[]
}

/** Сколько уже возвращено по операции (отрицательные платежи) */
export function refundedTotal(tx: Transaction): number {
  return -tx.payments.filter((p) => p.amount < 0).reduce((s, p) => s + p.amount, 0)
}

export interface RefundableItem {
  id: string
  name: string
  variant_name: string | null
  qty: number
  line_total: number
  /** line_total за вычетом пропорциональной доли скидки заказа */
  refund_amount: number
}

/** Позиции заказа с суммой к возврату (скидка заказа распределяется пропорционально) */
export async function fetchRefundableItems(orderId: string): Promise<RefundableItem[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('subtotal, discount_amount, order_items(id, name, variant_name, qty, line_total, voided_at)')
    .eq('id', orderId)
    .single()
  if (error) throw new Error(error.message)
  const o = data as unknown as {
    subtotal: number
    discount_amount: number
    order_items: { id: string; name: string; variant_name: string | null; qty: number; line_total: number; voided_at: string | null }[]
  }
  const factor = o.subtotal > 0 ? 1 - o.discount_amount / o.subtotal : 1
  return (o.order_items ?? [])
    .filter((i) => i.voided_at === null)
    .map(({ voided_at: _v, ...i }) => ({ ...i, refund_amount: Math.round(i.line_total * factor) }))
}

export interface RefundRow {
  id: string
  refund_number: number | null
  amount: number
  method: 'cash' | 'card'
  reason: string | null
  items: { name: string; qty: number; amount: number }[] | null
  created_at: string
  staff: { name: string } | null
}

/** История возвратов по заказу (для панели деталей) */
export async function fetchRefunds(orderId: string): Promise<RefundRow[]> {
  const { data, error } = await supabase
    .from('refunds')
    .select('id, refund_number, amount, method, reason, items, created_at, staff(name)')
    .eq('order_id', orderId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data as unknown as RefundRow[]
}

export interface IssueRefundParams {
  orderId: string
  staffId: string
  amount: number
  method: 'cash' | 'card'
  reason?: string
  items?: { name: string; qty: number; amount: number }[]
}

/** Частичный/полный возврат: отриц. платёж выбранным способом в текущую
 *  смену + תעודת זיכוי со сквозным номером. Возвращает id возврата. */
export async function issueRefund(p: IssueRefundParams): Promise<string> {
  const refundId = crypto.randomUUID()
  const { error } = await supabase.rpc('issue_refund', {
    p_refund_id: refundId,
    p_order_id: p.orderId,
    p_staff_id: p.staffId,
    p_amount: p.amount,
    p_method: p.method,
    p_reason: p.reason ?? null,
    p_items: p.items ?? null,
  })
  if (error) throw new Error(error.message)
  return refundId
}
