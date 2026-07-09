import { supabase } from '../../lib/supabase'

export interface Shift {
  id: string
  org_id: string
  location_id: string
  opened_by: string
  status: 'open' | 'closed'
  opening_float: number
  opened_at: string
}

export interface ShiftReport {
  shift_id: string
  status: 'open' | 'closed'
  opened_at: string
  opening_float: number
  cash_sales: number
  card_sales: number
  total_sales: number
  /** Чаевые за смену (входят в cash/card_sales — деньги, вне выручки) */
  tips_total: number
  expected_cash: number
  orders_count: number
  // Движения наличных (038); отсутствуют, пока миграция не применена
  cash_in?: number
  cash_out?: number
}

/** Внесение/изъятие наличных в течение смены (038) */
export interface CashMovement {
  id: string
  type: 'in' | 'out'
  amount: number
  reason: string | null
  created_at: string
  staff: { name: string } | null
}

export interface CloseResult {
  cash_sales: number
  card_sales: number
  total_sales: number
  tips_total: number
  expected_cash: number
  counted_cash: number
  cash_diff: number
  orders_count: number
  /** Сколько брошенных counter-заказов аннулировано при закрытии (035) */
  abandoned_voided?: number
  // Поля Z-отчёта (037); отсутствуют, пока миграция не применена
  z_number?: number
  gross_cash?: number
  gross_card?: number
  gross_total?: number
  refunds_total?: number
  vat_total?: number
  opened_at?: string
  closed_at?: string
  opening_float?: number
  // Движения наличных (038)
  cash_in?: number
  cash_out?: number
}

/** Открытая смена точки, либо null */
export async function fetchCurrentShift(): Promise<Shift | null> {
  const { data, error } = await supabase.rpc('current_shift')
  if (error) throw new Error(error.message)
  return data as Shift | null
}

export async function openShift(staffId: string, openingFloat: number): Promise<string> {
  const { data, error } = await supabase.rpc('open_shift', {
    p_staff_id: staffId,
    p_opening_float: openingFloat,
  })
  if (error) throw new Error(error.message)
  return (data as { shift_id: string }).shift_id
}

export async function fetchShiftReport(shiftId: string): Promise<ShiftReport> {
  const { data, error } = await supabase.rpc('shift_report', { p_shift_id: shiftId })
  if (error) throw new Error(error.message)
  return data as ShiftReport
}

/** Внести/изъять наличные (только в открытую смену; сервер валидирует) */
export async function addCashMovement(
  shiftId: string,
  staffId: string,
  type: 'in' | 'out',
  amount: number,
  reason: string
): Promise<void> {
  const { error } = await supabase.rpc('add_cash_movement', {
    p_shift_id: shiftId,
    p_staff_id: staffId,
    p_type: type,
    p_amount: amount,
    p_reason: reason || null,
  })
  if (error) throw new Error(error.message)
}

/** Движения наличных смены, свежие сверху */
export async function fetchShiftMovements(shiftId: string): Promise<CashMovement[]> {
  const { data, error } = await supabase
    .from('cash_movements')
    .select('id, type, amount, reason, created_at, staff:staff(name)')
    .eq('shift_id', shiftId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as CashMovement[]
}

export async function closeShift(
  shiftId: string,
  staffId: string,
  countedCash: number,
  note: string
): Promise<CloseResult> {
  const { data, error } = await supabase.rpc('close_shift', {
    p_shift_id: shiftId,
    p_staff_id: staffId,
    p_counted_cash: countedCash,
    p_note: note || null,
  })
  if (error) throw new Error(error.message)
  return data as CloseResult
}
