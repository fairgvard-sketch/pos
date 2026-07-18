import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'
import type { PayMethodId } from '../../lib/payMethods'

export interface TxPayment {
  method: PayMethodId
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

/** Серверные фильтры журнала операций. Пустой объект = все операции. */
export interface TxFilters {
  /** Нижняя граница paid_at, ISO (включительно) */
  from?: string | null
  /** Верхняя граница paid_at, ISO (исключительно) */
  to?: string | null
  status?: 'paid' | 'fulfilled' | 'refunded' | null
  method?: PayMethodId | null
  staffId?: string | null
  /** Подстрока метки стола */
  table?: string | null
  /** Число — номер чека ИЛИ дневной номер; текст — имя гостя */
  search?: string
}

export const TX_PAGE_SIZE = 50

// staff указываем через явный FK: после 025 у orders ДВА FK на staff
// (staff_id и refunded_by) — без уточнения embedded-join неоднозначен
const TX_SELECT =
  'id, daily_number, receipt_number, total, status, paid_at, created_at, customer_name, table_label, staff:staff!orders_staff_id_fkey(name), payments(method, amount)'

/**
 * Страница журнала операций: фильтры и поиск выполняются СЕРВЕРОМ (не по
 * загруженным строкам), порядок paid_at DESC + id DESC (стабильные страницы),
 * offset-пагинация под useInfiniteQuery. Индексы — миграция 083.
 */
export async function fetchTransactionsPage(
  filters: TxFilters = {},
  offset = 0,
  pageSize = TX_PAGE_SIZE
): Promise<Transaction[]> {
  // Фильтр по способу оплаты — второй embed тем же payments с !inner:
  // он сужает выборку заказов, а полный payments(...) остаётся для UI
  const select = filters.method ? `${TX_SELECT}, pay_filter:payments!inner(method)` : TX_SELECT
  let q = supabase
    .from('orders')
    .select(select)
    .in('status', filters.status ? [filters.status] : ['paid', 'fulfilled', 'refunded'])
    .order('paid_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + pageSize - 1)

  if (filters.from) q = q.gte('paid_at', filters.from)
  if (filters.to) q = q.lt('paid_at', filters.to)
  if (filters.staffId) q = q.eq('staff_id', filters.staffId)
  if (filters.table?.trim()) q = q.ilike('table_label', `%${filters.table.trim()}%`)
  if (filters.method) q = q.eq('pay_filter.method', filters.method)

  const s = filters.search?.trim()
  if (s) {
    if (/^\d+$/.test(s)) q = q.or(`daily_number.eq.${s},receipt_number.eq.${s}`)
    else q = q.ilike('customer_name', `%${s}%`)
  }

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data as unknown as Transaction[]
}

/**
 * Все операции периода для экспорта: постранично докачивает до конца
 * (страховочный потолок cap — экспорт не должен уронить терминал).
 */
export async function fetchTransactionsAll(
  filters: TxFilters,
  cap = 5000
): Promise<Transaction[]> {
  const out: Transaction[] = []
  const page = 500
  for (let offset = 0; offset < cap; offset += page) {
    const rows = await fetchTransactionsPage(filters, offset, page)
    out.push(...rows)
    if (rows.length < page) break
  }
  return out
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
  method: PayMethodId
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
  method: PayMethodId
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
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
  return refundId
}
