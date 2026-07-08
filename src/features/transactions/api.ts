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
    .select('id, daily_number, receipt_number, total, status, paid_at, created_at, customer_name, table_label, staff(name), payments(method, amount)')
    .in('status', ['paid', 'fulfilled', 'refunded'])
    .order('paid_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)
  return data as unknown as Transaction[]
}

/** Полный возврат заказа: отриц. платежи в текущую смену + статус refunded */
export async function refundOrder(orderId: string, staffId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('refund_order', {
    p_order_id: orderId,
    p_staff_id: staffId,
    p_reason: reason ?? null,
  })
  if (error) throw new Error(error.message)
}
