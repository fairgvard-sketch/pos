import { supabase } from '../../lib/supabase'
import type { Role } from '../../types'

/**
 * Табель учёта рабочего времени. Независим от кассовой смены (shifts).
 * БД-слой — миграция 022: таблица time_entries + SECURITY DEFINER RPC,
 * запись только через RPC, скоуп по org. Завершение = UPDATE clock_out.
 */

/** Открытая (текущая) запись рабочего дня сотрудника */
export interface OpenEntry {
  id: string
  staff_id: string
  clock_in: string
  clock_out: string | null
}

/** Строка истории табеля за период */
export interface TimeEntryRow {
  id: string
  staff_id: string
  staff_name: string
  staff_role: Role
  clock_in: string
  clock_out: string | null
  note: string | null
  seconds: number | null // null пока день не закрыт
}

/** Итог по сотруднику за период */
export interface TimeTotalRow {
  staff_id: string
  name: string
  seconds: number // включает текущий незакрытый день (до NOW())
  on_shift: boolean
}

export interface TimesheetReport {
  entries: TimeEntryRow[]
  totals: TimeTotalRow[]
}

export async function clockIn(staffId: string): Promise<void> {
  const { error } = await supabase.rpc('clock_in', { p_staff_id: staffId })
  if (error) throw new Error(error.message)
}

export async function clockOut(staffId: string, note?: string): Promise<void> {
  const { error } = await supabase.rpc('clock_out', { p_staff_id: staffId, p_note: note ?? null })
  if (error) throw new Error(error.message)
}

export async function fetchOpenEntry(staffId: string): Promise<OpenEntry | null> {
  const { data, error } = await supabase.rpc('open_time_entry', { p_staff_id: staffId })
  if (error) throw new Error(error.message)
  return (data as OpenEntry | null) ?? null
}

export async function fetchTimesheetReport(from: Date, to: Date): Promise<TimesheetReport> {
  const { data, error } = await supabase.rpc('time_entries_report', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  })
  if (error) throw new Error(error.message)
  return data as TimesheetReport
}
