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
  expected_cash: number
  orders_count: number
}

export interface CloseResult {
  cash_sales: number
  card_sales: number
  total_sales: number
  expected_cash: number
  counted_cash: number
  cash_diff: number
  orders_count: number
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
