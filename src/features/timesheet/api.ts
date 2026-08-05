import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'
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

// ── Часы по дням (143) ──────────────────────────────────────

/** Одна смена в отчёте по часам. День и день недели считает сервер. */
export interface StaffHoursEntry {
  id: string
  /** YYYY-MM-DD — календарный день НАЧАЛА смены в поясе точки */
  day: string
  /** 0 = воскресенье (א) … 6 = суббота (ש) */
  dow: number
  clock_in: string
  clock_out: string | null
  seconds: number
  is_open: boolean
  note: string | null
  edited_at: string | null
  edited_by_name: string | null
  location_id: string
  location_name: string | null
}

/** Сотрудник с его сменами за период */
export interface StaffHours {
  staff_id: string
  name: string
  role: Role
  is_active: boolean
  seconds: number
  days: number
  shifts: number
  has_open: boolean
  entries: StaffHoursEntry[]
}

export interface StaffHoursReport {
  scope: { from: string; to: string; tz: string; location_ids: string[] | null }
  staff: StaffHours[]
  totals: { seconds: number; shifts: number; days: number; staff: number }
}

/** YYYY-MM-DD в локальном поясе (toISOString сдвинул бы дату) */
export function toDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Часы за период по дням (143). Границы — КАЛЕНДАРНЫЕ даты включительно:
 * сервер сам режет сутки по поясу точки, поэтому ночная смена не уезжает
 * на соседний день и печать сходится с экраном.
 */
export async function fetchStaffHours(params: {
  from: Date
  to: Date
  staffIds?: string[]
  locationIds?: string[]
  tz?: string
}): Promise<StaffHoursReport> {
  const { data, error } = await supabase.rpc('staff_hours_report', {
    p_from: toDateKey(params.from),
    p_to: toDateKey(params.to),
    p_tz: params.tz ?? 'Asia/Jerusalem',
    p_staff_ids: params.staffIds ?? null,
    p_location_ids: params.locationIds ?? null,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
  return data as StaffHoursReport
}

/**
 * Правка табеля менеджером (027): добавить смену задним числом
 * (entryId = null) или исправить время существующей. actorId — кто правит;
 * право сверяется по manage-сессии (143), actorId остаётся автором в аудите.
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
    p_staff_session: currentStaffToken(),
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
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}
