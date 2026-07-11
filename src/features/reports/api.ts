import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'

export interface SalesSummary {
  gross_sales: number
  discounts: number
  vat: number
  orders_count: number
  avg_check: number
  refunds: number
  refunds_count: number
}

export interface MethodRow {
  /** cash | card | cibus | tenbis | bit (046) */
  method: string
  amount: number
  count: number
}

export interface HourRow {
  hour: number
  amount: number
  count: number
}

export interface DayRow {
  day: string // YYYY-MM-DD, локальная дата точки
  amount: number
  count: number
}

export interface ItemRow {
  name: string
  qty: number
  amount: number
}

export interface CategoryRow {
  category: string
  qty: number
  amount: number
}

export interface StaffRow {
  name: string
  amount: number
  count: number
}

export interface SalesReport {
  summary: SalesSummary
  by_method: MethodRow[]
  by_hour: HourRow[]
  by_day: DayRow[]
  top_items: ItemRow[]
  by_category: CategoryRow[]
  by_staff: StaffRow[]
}

/** Отчёт «Продажи» за [from, to). Часы/дни группирует сервер в поясе точки. */
export async function fetchSalesReport(from: Date, to: Date): Promise<SalesReport> {
  // На старых WebView (Android 7.1) timeZone может отсутствовать
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jerusalem'
  const { data, error } = await supabase.rpc('sales_report', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_tz: tz,
    // Отчёты — manager-данные: сервер проверяет staff-сессию (049)
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
  return data as SalesReport
}
