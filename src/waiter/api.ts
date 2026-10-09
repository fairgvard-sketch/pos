import { supabase } from '../lib/supabase'
import { isNetworkishError } from '../lib/offline/net'
import type { MenuCategory, MenuItem, ModifierGroup, TableStatus } from '../types'
import { sendItems, type PendingSend } from './draft'

/**
 * API телефона официанта (180). Телефон — отдельный Auth-аккаунт без
 * организации: прямые запросы к таблицам ему ничего не отдают, всё идёт
 * через waiter_*. Доступ — PIN официанта (staff-сессия на каждом вызове).
 */

const CALL_TIMEOUT_MS = 12_000

export type WaiterErrorKind =
  | 'network'      // ответа нет: исход неизвестен, повтор с тем же ключом
  | 'revoked'      // телефон отключён / аккаунта нет → новый код
  | 'session'      // PIN-сессия истекла или официант удалён → PIN
  | 'locked'       // перебор PIN
  | 'unavailable'  // блюдо в стоп-листе
  | 'shift'        // смена закрыта
  | 'table'        // стол недоступен
  | 'invalid_code' // код допуска не подошёл
  | 'unknown'

export class WaiterError extends Error {
  kind: WaiterErrorKind

  constructor(kind: WaiterErrorKind, message: string) {
    super(message)
    this.name = 'WaiterError'
    this.kind = kind
  }
}

export function classify(e: unknown): WaiterErrorKind {
  if (e instanceof WaiterError) return e.kind
  if (isNetworkishError(e)) return 'network'
  const m = e instanceof Error ? e.message : String(e)
  if (/waiter_device_revoked|not authenticated|permission denied|JWT/i.test(m)) return 'revoked'
  if (/staff session (invalid|required)/.test(m)) return 'session'
  if (m.includes('pin_locked_out')) return 'locked'
  if (m.includes('item_unavailable')) return 'unavailable'
  if (m.includes('no open shift')) return 'shift'
  if (/table not found|order not found|item not found/.test(m)) return 'table'
  return 'unknown'
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await Promise.race([
      supabase.rpc(fn, args),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('timeout')), CALL_TIMEOUT_MS)
      }),
    ])
    if (res.error) throw new WaiterError(classify(new Error(res.error.message)), res.error.message)
    return res.data as T
  } catch (e) {
    if (e instanceof WaiterError) throw e
    throw new WaiterError(classify(e), e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
  }
}

// ── Допуск и вход ───────────────────────────────────────────
export interface WaiterStaff { id: string; name: string; role: string }
export interface WaiterLocation { id: string; name: string; timezone: string; service_mode: string }

export async function pairPhone(code: string, label: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('waiter-pair', { body: { code, label } })
  if (error) {
    let reason = ''
    try {
      const ctx = (error as { context?: Response }).context
      reason = ((await ctx?.json()) as { error?: string } | undefined)?.error ?? ''
    } catch { /* тело не JSON — сетевой сбой */ }
    if (reason === 'invalid_code') throw new WaiterError('invalid_code', reason)
    throw new WaiterError(isNetworkishError(error) ? 'network' : 'unknown', reason || error.message)
  }
  const d = data as { access_token: string; refresh_token: string; location_name: string }
  // Аккаунт кассы на этом браузере заменился бы аккаунтом телефона —
  // экран допуска сюда не пускает (см. WaiterApp), здесь просто ставим сессию
  const { error: e } = await supabase.auth.setSession({ access_token: d.access_token, refresh_token: d.refresh_token })
  if (e) throw new WaiterError('unknown', e.message)
  return d.location_name
}

export interface UnlockResult {
  ok: boolean
  session_token?: string
  staff?: WaiterStaff
  location?: WaiterLocation
}

export function unlock(pin: string): Promise<UnlockResult> {
  return call<UnlockResult>('waiter_unlock', { p_pin: pin })
}

// ── Зал ─────────────────────────────────────────────────────
export interface HallZone { id: string; name: string; sort_order: number }
export interface HallTable {
  id: string
  label: string
  zone_id: string | null
  zone: string | null
  sort_order: number
  seats: number
  status: TableStatus
}
export interface HallOpen {
  table_id: string
  order_id: string
  total: number
  daily_number: number
  opened_at: string
  staff_name: string | null
  item_count: number
  has_held: boolean
  /** Fire уже нажимали (182); нет у ответа сервера до 182 */
  has_fired?: boolean
}
export interface Hall {
  shift_open: boolean
  printer_ready: boolean
  zones: HallZone[]
  tables: HallTable[]
  open: HallOpen[]
}

export function fetchHall(session: string): Promise<Hall> {
  return call<Hall>('waiter_hall', { p_staff_session: session })
}

// ── Меню ────────────────────────────────────────────────────
export type WaiterMenuItem = Pick<
  MenuItem,
  'id' | 'category_id' | 'name' | 'price' | 'is_available' | 'ask_modifiers' | 'sort_order' | 'course'
  | 'item_variants' | 'menu_item_modifier_groups'
>
export interface WaiterMenu {
  categories: Pick<MenuCategory, 'id' | 'name' | 'icon' | 'sort_order' | 'is_active'>[]
  items: WaiterMenuItem[]
  modifier_groups: ModifierGroup[]
}

export function fetchMenu(session: string): Promise<WaiterMenu> {
  return call<WaiterMenu>('waiter_menu', { p_staff_session: session })
}

// ── Счёт стола ──────────────────────────────────────────────
export interface WaiterBillLine {
  id: string
  name: string
  variant_name: string | null
  qty: number
  line_total: number
  modifiers: string[]
  notes: string | null
  course: number | null
  held: boolean
  /** Для «ещё одной такой же» (182); нет у ответа сервера до 182 */
  menu_item_id?: string | null
  variant_id?: string | null
  unit_price?: number
  mods?: { id: string | null; name: string; priceDelta: number }[]
}
export interface WaiterBill {
  order: { id: string; daily_number: number; total: number; opened_at: string } | null
  lines: WaiterBillLine[]
}

export function fetchBill(session: string, tableId: string): Promise<WaiterBill> {
  return call<WaiterBill>('waiter_bill', { p_staff_session: session, p_table_id: tableId })
}

// ── Отправка и Fire ─────────────────────────────────────────
export interface SendResult {
  order_id: string
  total: number
  job_id: string | null
  replay: boolean
}

export function sendOrder(session: string, tableId: string, p: PendingSend): Promise<SendResult> {
  return call<SendResult>('waiter_send', {
    p_staff_session: session,
    p_table_id: tableId,
    p_op_uuid: p.opUuid,
    p_items: sendItems(p),
  })
}

export function fireItems(session: string, orderId: string, itemIds: string[], opUuid: string): Promise<{ fired: string[]; job_id: string | null }> {
  return call('waiter_fire', { p_staff_session: session, p_order_id: orderId, p_item_ids: itemIds, p_op_uuid: opUuid })
}

// ── Правка отправленного (182) ──────────────────────────────
export type VoidLineResult =
  | { ok: true; total: number; approved_by: string; job_id: string | null }
  | { ok: false; error: 'manager_pin_invalid' }

/** Убрать позицию: p_qty null — всю строку. Подтверждает PIN менеджера. */
export function voidLine(
  session: string, itemId: string, qty: number | null, reason: string, managerPin: string, opUuid: string,
): Promise<VoidLineResult> {
  return call('waiter_void_line', {
    p_staff_session: session,
    p_item_id: itemId,
    p_qty: qty,
    p_reason: reason,
    p_manager_pin: managerPin,
    p_op_uuid: opUuid,
  })
}

export interface MoveLinesResult {
  ok: true
  source_total: number
  source_empty: boolean
  target_total: number
  to_label: string
  job_id: string | null
}

export function moveLines(session: string, itemIds: string[], toTableId: string, opUuid: string): Promise<MoveLinesResult> {
  return call('waiter_move_lines', {
    p_staff_session: session,
    p_item_ids: itemIds,
    p_to_table_id: toTableId,
    p_op_uuid: opUuid,
  })
}

// ── Тикеты ──────────────────────────────────────────────────
export type PrintJobStatus = 'pending' | 'printing' | 'printed' | 'failed' | 'expired'

export function fetchPrintStatus(session: string, ids: string[]): Promise<{ id: string; status: PrintJobStatus; error: string | null }[]> {
  return call('waiter_print_status', { p_staff_session: session, p_job_ids: ids })
}
