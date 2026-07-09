import { supabase } from '../../lib/supabase'
import type { Role } from '../../types'

/**
 * Табель учёта рабочего времени. Независим от кассовой смены (shifts).
 * БД-слой — миграция 022: таблица time_entries + SECURITY DEFINER RPC,
 * запись только через RPC, скоуп по org. Завершение = UPDATE clock_out.
 */

/** Строка истории табеля за период */
export interface TimeEntryRow {
  id: string
  staff_id: string
  staff_name: string
  staff_role: Role
  clock_in: string
  clock_out: string | null
  note: string | null
  edited_at: string | null // не NULL = запись правил менеджер (027)
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

/** Результат отметки по PIN */
export interface PunchResult {
  action: 'in' | 'out'
  staff_name: string
  seconds?: number // при clock-out — длительность закрытого дня
}

/**
 * Отметка в табеле по личному PIN. Сервер сам сверяет PIN, определяет
 * сотрудника и переключает статус (clock-in ⇄ clock-out). PIN не покидает
 * БД — отметить чужой день нельзя.
 */
export async function punchByPin(pin: string): Promise<PunchResult> {
  const { data, error } = await supabase.rpc('punch_by_pin', { p_pin: pin })
  if (error) throw new Error(error.message)
  return data as PunchResult
}

export async function fetchTimesheetReport(from: Date, to: Date): Promise<TimesheetReport> {
  const { data, error } = await supabase.rpc('time_entries_report', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  })
  if (error) throw new Error(error.message)
  return data as TimesheetReport
}

/**
 * Правка табеля менеджером (027): добавить смену задним числом
 * (entryId = null) или исправить время существующей. actorId — кто правит;
 * сервер сверяет роль manager/owner.
 */
export async function saveTimeEntry(params: {
  entryId: string | null
  staffId: string
  clockIn: Date
  clockOut: Date | null
  actorId: string
  note?: string
}): Promise<void> {
  const { error } = await supabase.rpc('save_time_entry', {
    p_entry_id: params.entryId,
    p_staff_id: params.staffId,
    p_clock_in: params.clockIn.toISOString(),
    p_clock_out: params.clockOut ? params.clockOut.toISOString() : null,
    p_actor_id: params.actorId,
    p_note: params.note ?? null,
  })
  if (error) throw new Error(error.message)
}

/** Кто сейчас на смене (открытый рабочий день) — для закрытия кассовой смены */
export interface OnShiftStaff {
  staff_id: string
  staff_name: string
  clock_in: string
}

/**
 * Список сотрудников с открытым рабочим днём. Читаем из отчёта за
 * последние сутки (открытый день мог начаться вчера ночью) и берём
 * записи без clock_out — этого достаточно для диалога закрытия смены.
 */
export async function fetchOnShiftStaff(): Promise<OnShiftStaff[]> {
  const to = new Date()
  const from = new Date(to.getTime() - 48 * 3600 * 1000)
  const report = await fetchTimesheetReport(from, to)
  return report.entries
    .filter((e) => e.clock_out === null)
    .map((e) => ({ staff_id: e.staff_id, staff_name: e.staff_name, clock_in: e.clock_in }))
}

/** Снять сотрудника со смены (clock-out по staff_id). Сервер сам находит открытый день. */
export async function clockOutStaff(staffId: string): Promise<void> {
  const { error } = await supabase.rpc('clock_out', { p_staff_id: staffId })
  if (error) throw new Error(error.message)
}

/** Мягкое удаление ошибочной записи табеля (менеджер) */
export async function deleteTimeEntry(entryId: string, actorId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_time_entry', {
    p_entry_id: entryId,
    p_actor_id: actorId,
  })
  if (error) throw new Error(error.message)
}
