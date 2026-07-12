import { supabase } from '../../lib/supabase'
import { getDeviceContext } from '../auth/api'
import type { Reservation, ReservationStatus } from '../../types'

// ── Чтение ───────────────────────────────────────────────

/** Границы локального дня (dateStr = 'YYYY-MM-DD') в ISO — для запроса по reserved_at */
function dayBounds(dateStr: string): { from: string; to: string } {
  const from = new Date(`${dateStr}T00:00:00`)
  const to = new Date(from.getTime() + 24 * 3600_000)
  return { from: from.toISOString(), to: to.toISOString() }
}

/** Все брони выбранного дня, по времени. RLS скоупит по org. */
export async function fetchReservationsForDay(dateStr: string): Promise<Reservation[]> {
  const { from, to } = dayBounds(dateStr)
  const { data, error } = await supabase
    .from('reservations')
    .select('*')
    .gte('reserved_at', from)
    .lt('reserved_at', to)
    .order('reserved_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data as Reservation[]
}

/**
 * Активные брони (ждут гостя) с назначенным столом — для бейджа в зале.
 * Окно: от «час назад» до конца суток, чтобы показывать ближайшую бронь стола.
 */
export async function fetchActiveTableReservations(): Promise<Reservation[]> {
  const from = new Date(Date.now() - 3600_000).toISOString()
  const to = new Date(new Date().setHours(23, 59, 59, 999)).toISOString()
  const { data, error } = await supabase
    .from('reservations')
    .select('*')
    .in('status', ['requested', 'confirmed'])
    .not('table_id', 'is', null)
    .gte('reserved_at', from)
    .lte('reserved_at', to)
    .order('reserved_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data as Reservation[]
}

// ── Запись (create/edit/status — прямо под RLS, как столы 013/016) ─

export interface ReservationInput {
  reservedAt: string
  durationMin: number
  partySize: number
  customerName: string
  customerPhone: string | null
  note: string | null
  tableId: string | null
  tags?: string[]
}

/** Код исключающего констрейнта 054 → «стол занят на это время» (сентинел для UI) */
function mapReservationError(error: { code?: string; message: string }): Error {
  // 23P01 = exclusion_violation (reservations_no_overlap)
  if (error.code === '23P01') return new Error('overlap')
  return new Error(error.message)
}

export async function createReservation(input: ReservationInput, staffId: string): Promise<void> {
  const ctx = await getDeviceContext()
  if (!ctx?.orgId || !ctx?.locationId) throw new Error('Device not bootstrapped')
  const { error } = await supabase.from('reservations').insert({
    org_id: ctx.orgId,
    location_id: ctx.locationId,
    table_id: input.tableId,
    reserved_at: input.reservedAt,
    duration_min: input.durationMin,
    party_size: input.partySize,
    customer_name: input.customerName,
    customer_phone: input.customerPhone,
    note: input.note,
    tags: input.tags ?? [],
    created_by: staffId,
  })
  if (error) throw mapReservationError(error)
}

export async function updateReservation(id: string, input: ReservationInput): Promise<void> {
  const { error } = await supabase
    .from('reservations')
    .update({
      table_id: input.tableId,
      reserved_at: input.reservedAt,
      duration_min: input.durationMin,
      party_size: input.partySize,
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      note: input.note,
      tags: input.tags ?? [],
    })
    .eq('id', id)
  if (error) throw mapReservationError(error)
}

/** Смена статуса брони (подтвердить / неявка / отмена / завершить). */
export async function setReservationStatus(id: string, status: ReservationStatus): Promise<void> {
  const { error } = await supabase.from('reservations').update({ status }).eq('id', id)
  if (error) throw new Error(error.message)
}

// ── Посадка (RPC: открывает счёт стола) ──────────────────

export interface SeatResult {
  order_id: string
  daily_number: number
  total: number
  existing: boolean
}

/**
 * Посадить гостя брони за стол: открывает обычный счёт стола
 * (open_or_get_table_order) и привязывает бронь к заказу.
 * tableId переопределяет стол брони (NULL → берётся стол брони).
 */
export async function seatReservation(
  reservationId: string,
  staffId: string,
  tableId: string | null,
): Promise<SeatResult> {
  const { data, error } = await supabase.rpc('seat_reservation', {
    p_reservation_id: reservationId,
    p_staff_id: staffId,
    ...(tableId ? { p_table_id: tableId } : {}),
  })
  if (error) throw new Error(error.message)
  return data as SeatResult
}
