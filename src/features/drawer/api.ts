import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'

/**
 * Журнал открытий денежного ящика (144). Физически ящик открывает
 * клиент (lib/cashDrawer.ts) — сервер фиксирует, кто и почему его открыл.
 */

/**
 * Почему открылся ящик:
 *  sale/refund               — расчёт наличными и возврат наличными;
 *  cash_in/cash_out          — внесение и изъятие (038);
 *  shift_open/shift_close    — пересчёт кассы на границах смены;
 *  no_sale                   — открытие без продажи (размен, проверка);
 *  test                      — тест из настроек кассы.
 */
export type DrawerReason =
  | 'sale' | 'refund' | 'cash_in' | 'cash_out'
  | 'shift_open' | 'shift_close' | 'no_sale' | 'test'

export interface DrawerOpenRow {
  id: string
  reason: DrawerReason
  note: string | null
  opened_at: string
  order_id: string | null
  staff: { name: string } | null
}

export interface LogDrawerOpenParams {
  /** Клиентский UUID — ключ идемпотентности (replay не задваивает запись) */
  opUuid: string
  reason: DrawerReason
  staffId: string | null
  orderId?: string | null
  note?: string | null
  deviceUuid?: string | null
  /** Честное время открытия на кассе (офлайн-запись доезжает позже) */
  openedAt?: string | null
}

/** Зафиксировать открытие ящика на сервере */
export async function logDrawerOpen(p: LogDrawerOpenParams): Promise<void> {
  const { error } = await supabase.rpc('log_drawer_open', {
    p_op_uuid: p.opUuid,
    p_reason: p.reason,
    p_staff_id: p.staffId,
    p_order_id: p.orderId ?? null,
    p_note: p.note ?? null,
    p_device_uuid: p.deviceUuid ?? null,
    p_opened_at: p.openedAt ?? null,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

/** Открытия ящика за смену, свежие сверху */
export async function fetchDrawerOpens(shiftId: string): Promise<DrawerOpenRow[]> {
  const { data, error } = await supabase
    .from('drawer_opens')
    .select('id, reason, note, opened_at, order_id, staff:staff(name)')
    .eq('shift_id', shiftId)
    .order('opened_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as DrawerOpenRow[]
}
