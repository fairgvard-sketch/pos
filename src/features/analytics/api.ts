import { supabase } from '../../lib/supabase'
import type { Order } from '../../types'

export async function fetchDailyRevenue(days = 30) {
  const since = new Date()
  since.setDate(since.getDate() - days)

  const { data, error } = await supabase
    .from('orders')
    .select('created_at, total')
    .eq('status', 'paid')
    .gte('created_at', since.toISOString())
    .order('created_at')

  if (error) throw error

  const byDay: Record<string, number> = {}
  data.forEach((o) => {
    const day = o.created_at.slice(0, 10)
    byDay[day] = (byDay[day] ?? 0) + o.total
  })

  return Object.entries(byDay).map(([date, revenue]) => ({ date, revenue }))
}

export async function fetchTopItems(limit = 10) {
  const { data, error } = await supabase
    .from('order_items')
    .select(`menu_item_id, qty, price, menu_item:menu_items(name)`)
    .limit(1000)

  if (error) throw error

  const aggregated: Record<string, { name: string; qty: number; revenue: number }> = {}
  data.forEach((item: any) => {
    const id = item.menu_item_id
    if (!aggregated[id]) aggregated[id] = { name: item.menu_item?.name ?? id, qty: 0, revenue: 0 }
    aggregated[id].qty += item.qty
    aggregated[id].revenue += item.qty * item.price
  })

  return Object.values(aggregated).sort((a, b) => b.qty - a.qty).slice(0, limit)
}

export async function fetchItemSalesByPeriod(dateFrom: string, dateTo: string) {
  const { data, error } = await supabase
    .from('order_items')
    .select(`
      menu_item_id, qty, price,
      menu_item:menu_items(name),
      order:orders!inner(status, created_at)
    `)
    .eq('order.status', 'paid')
    .gte('order.created_at', dateFrom)
    .lte('order.created_at', dateTo)
    .limit(5000)

  if (error) throw error

  const aggregated: Record<string, { name: string; qty: number; revenue: number }> = {}
  data.forEach((item: any) => {
    const id = item.menu_item_id
    if (!aggregated[id]) aggregated[id] = { name: item.menu_item?.name ?? id, qty: 0, revenue: 0 }
    aggregated[id].qty += item.qty
    aggregated[id].revenue += item.qty * item.price
  })

  return Object.values(aggregated).sort((a, b) => b.revenue - a.revenue)
}

export async function fetchStatsByPeriod(dateFrom: string, dateTo: string) {
  const { data, error } = await supabase
    .from('orders')
    .select('total, status')
    .eq('status', 'paid')
    .gte('created_at', dateFrom)
    .lte('created_at', dateTo)

  if (error) throw error

  return {
    totalRevenue: data.reduce((s, o) => s + o.total, 0),
    ordersCount: data.length,
    avgCheck: data.length > 0 ? data.reduce((s, o) => s + o.total, 0) / data.length : 0,
  }
}

export async function fetchTodayStats() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const { data, error } = await supabase
    .from('orders')
    .select('total, status')
    .gte('created_at', today.toISOString())

  if (error) throw error

  const paid = data.filter((o) => o.status === 'paid')
  return {
    totalRevenue: paid.reduce((s, o) => s + o.total, 0),
    ordersCount: paid.length,
    activeOrders: data.filter((o) => o.status !== 'paid').length,
  }
}

export async function fetchActiveShift() {
  const { data, error } = await supabase
    .from('shifts')
    .select('*, staff:staff(*)')
    .is('closed_at', null)
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data
}

export async function openShift(staffId: string, openingCash = 0) {
  const { error } = await supabase
    .from('shifts')
    .insert({ staff_id: staffId, opening_cash: openingCash })
  if (error) throw error
}

export interface ClockEvent {
  id: string
  staff_id: string
  event_type: 'clock_in' | 'clock_out'
  created_at: string
  staff?: { id: string; name: string; role: string }
}

export async function clockIn(staffId: string) {
  const { error } = await supabase
    .from('staff_clock_events')
    .insert({ staff_id: staffId, event_type: 'clock_in' })
  if (error) throw error
}

export async function clockOut(staffId: string) {
  const { error } = await supabase
    .from('staff_clock_events')
    .insert({ staff_id: staffId, event_type: 'clock_out' })
  if (error) throw error
}

export async function fetchClockEvents(dateFrom: string, dateTo: string): Promise<ClockEvent[]> {
  const { data, error } = await supabase
    .from('staff_clock_events')
    .select('*, staff:staff(id, name, role)')
    .gte('created_at', dateFrom)
    .lte('created_at', dateTo)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as ClockEvent[]
}

export async function fetchAllStaff() {
  const { data, error } = await supabase
    .from('staff')
    .select('id, name, role')
    .order('name')
  if (error) throw error
  return data as { id: string; name: string; role: string }[]
}

export async function fetchTodayClockStatus(): Promise<Record<string, 'clock_in' | 'clock_out' | null>> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const { data, error } = await supabase
    .from('staff_clock_events')
    .select('staff_id, event_type, created_at')
    .gte('created_at', today.toISOString())
    .order('created_at', { ascending: false })
  if (error) throw error

  const status: Record<string, 'clock_in' | 'clock_out' | null> = {}
  for (const e of (data ?? [])) {
    if (!(e.staff_id in status)) {
      status[e.staff_id] = e.event_type as 'clock_in' | 'clock_out'
    }
  }
  return status
}

export async function closeShift(shiftId: string, totalRevenue: number) {
  const { error } = await supabase
    .from('shifts')
    .update({ closed_at: new Date().toISOString(), total_revenue: totalRevenue })
    .eq('id', shiftId)
  if (error) throw error
}

export interface ReportData {
  // period
  from: string
  to: string
  shiftNumber: number | null
  // receipts
  receiptsCount: number
  avgReceipt: number
  // revenue breakdown
  totalRevenue: number
  cashRevenue: number
  cardRevenue: number
  // VAT (מע"מ) — 17% included
  vatAmount: number
  vatRate: number
}

const VAT_RATE = 0.17

export async function fetchXReport(): Promise<ReportData> {
  // Active shift start, or today midnight if no shift
  const shift = await fetchActiveShift()
  const from = shift?.opened_at ?? new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
  const to = new Date().toISOString()

  const { data: payments, error } = await supabase
    .from('payments')
    .select('method, amount, created_at')
    .gte('created_at', from)
    .lte('created_at', to)

  if (error) throw error

  const cashRevenue = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0)
  const cardRevenue = payments.filter((p) => p.method === 'card').reduce((s, p) => s + p.amount, 0)
  // split payments counted in both cash+card already via separate rows
  const totalRevenue = payments.reduce((s, p) => s + p.amount, 0)

  // Count unique orders paid
  const { data: orders, error: oErr } = await supabase
    .from('orders')
    .select('id, total')
    .eq('status', 'paid')
    .gte('created_at', from)
    .lte('created_at', to)
  if (oErr) throw oErr

  const receiptsCount = orders.length
  const avgReceipt = receiptsCount > 0 ? totalRevenue / receiptsCount : 0
  const vatAmount = totalRevenue * VAT_RATE / (1 + VAT_RATE)

  return {
    from,
    to,
    shiftNumber: shift ? shift.id.slice(0, 6).toUpperCase().replace(/[^0-9]/g, '').slice(0, 4) as any : null,
    receiptsCount,
    avgReceipt,
    totalRevenue,
    cashRevenue,
    cardRevenue,
    vatAmount,
    vatRate: VAT_RATE * 100,
  }
}

export async function fetchZReport(shiftId: string): Promise<ReportData & { closedAt: string }> {
  const { data: shift, error: sErr } = await supabase
    .from('shifts')
    .select('*')
    .eq('id', shiftId)
    .single()
  if (sErr) throw sErr

  const from = shift.opened_at
  const to = shift.closed_at ?? new Date().toISOString()

  const { data: payments, error } = await supabase
    .from('payments')
    .select('method, amount, created_at')
    .gte('created_at', from)
    .lte('created_at', to)
  if (error) throw error

  const cashRevenue = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0)
  const cardRevenue = payments.filter((p) => p.method === 'card').reduce((s, p) => s + p.amount, 0)
  const totalRevenue = payments.reduce((s, p) => s + p.amount, 0)

  const { data: orders, error: oErr } = await supabase
    .from('orders')
    .select('id, total')
    .eq('status', 'paid')
    .gte('created_at', from)
    .lte('created_at', to)
  if (oErr) throw oErr

  const receiptsCount = orders.length
  const avgReceipt = receiptsCount > 0 ? totalRevenue / receiptsCount : 0
  const vatAmount = totalRevenue * VAT_RATE / (1 + VAT_RATE)

  return {
    from,
    to,
    closedAt: to,
    shiftNumber: null,
    receiptsCount,
    avgReceipt,
    totalRevenue,
    cashRevenue,
    cardRevenue,
    vatAmount,
    vatRate: VAT_RATE * 100,
  }
}

export async function fetchOrderHistory(params: {
  dateFrom?: string
  dateTo?: string
  tableNumber?: number
  limit?: number
}): Promise<Order[]> {
  let query = supabase
    .from('orders')
    .select(`
      *,
      table:tables(number),
      waiter:staff(name),
      order_items(*, menu_item:menu_items(name)),
      payments(method, amount)
    `)
    .eq('status', 'paid')
    .order('created_at', { ascending: false })
    .limit(params.limit ?? 50)

  if (params.dateFrom) query = query.gte('created_at', params.dateFrom)
  if (params.dateTo) query = query.lte('created_at', params.dateTo)

  const { data, error } = await query
  if (error) throw error

  const orders = data as any[]
  if (params.tableNumber) {
    return orders.filter((o) => o.table?.number === params.tableNumber)
  }
  return orders as Order[]
}

export interface DiscountRow {
  orderId: string
  createdAt: string
  tableNumber: number | null
  waiterName: string
  itemName: string
  originalPrice: number
  paidPrice: number
  qty: number
  discountAmount: number
}

export async function fetchDiscountReport(dateFrom: string, dateTo: string): Promise<DiscountRow[]> {
  const { data, error } = await supabase
    .from('order_items')
    .select(`
      id, qty, price,
      menu_item:menu_items(name, price),
      order:orders!inner(id, created_at, status, table:tables(number), waiter:staff(name))
    `)
    .eq('order.status', 'paid')
    .gte('order.created_at', dateFrom)
    .lte('order.created_at', dateTo)
  if (error) throw error

  const rows: DiscountRow[] = []
  for (const item of (data as any[])) {
    const originalPrice = item.menu_item?.price ?? item.price
    if (item.price < originalPrice) {
      rows.push({
        orderId: item.order.id,
        createdAt: item.order.created_at,
        tableNumber: item.order.table?.number ?? null,
        waiterName: item.order.waiter?.name ?? '—',
        itemName: item.menu_item?.name ?? '—',
        originalPrice,
        paidPrice: item.price,
        qty: item.qty,
        discountAmount: (originalPrice - item.price) * item.qty,
      })
    }
  }
  return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export async function fetchLastShifts(limit = 10) {
  const { data, error } = await supabase
    .from('shifts')
    .select('*, staff:staff(name)')
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data
}
