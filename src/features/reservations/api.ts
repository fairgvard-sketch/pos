import { supabase } from '../../lib/supabase'

export type ReservationStatus = 'new' | 'confirmed' | 'rejected' | 'cancelled'

export interface Reservation {
  id: string
  client_uuid: string
  customer_name: string
  customer_phone: string
  party_size: number
  reserved_at: string
  note: string | null
  table_id: string | null
  status: ReservationStatus
  reject_reason: string | null
  decided_at: string | null
  cancelled_at: string | null
  created_at: string
  /** Открытый счёт стола после посадки (057). null = ещё не посажены */
  order_id: string | null
  /** Назначенный стол (метка для карточки/чипа) */
  table: { id: string; label: string } | null
}

/**
 * Брони для экрана: все новые + всё, что с сегодняшнего дня и позже
 * (история прошлых дней не нужна — заявки решаются в моменте).
 */
export async function fetchReservations(): Promise<Reservation[]> {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const { data, error } = await supabase
    .from('reservations')
    .select('*, table:table_id ( id, label )')
    .or(`status.eq.new,reserved_at.gte.${startOfToday.toISOString()}`)
    .order('reserved_at', { ascending: true })
    .limit(200)
  if (error) throw new Error(error.message)
  return data as Reservation[]
}

/**
 * Подтверждённые брони с назначенным столом в окне «скоро»
 * ([now−30мин, now+2ч]) — подсветка на плане зала. Окно
 * вычисляется в момент запроса; HallPage перезапрашивает раз в минуту.
 */
export async function fetchUpcomingTableReservations(): Promise<Reservation[]> {
  const from = new Date(Date.now() - 30 * 60_000).toISOString()
  const to = new Date(Date.now() + 2 * 3600_000).toISOString()
  const { data, error } = await supabase
    .from('reservations')
    .select('*, table:table_id ( id, label )')
    .eq('status', 'confirmed')
    .not('table_id', 'is', null)
    .gte('reserved_at', from)
    .lte('reserved_at', to)
    .order('reserved_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data as Reservation[]
}

export interface CreateReservationInput {
  name: string
  phone: string
  partySize: number
  reservedAt: string // ISO
  note: string | null
  tableId: string | null
}

/**
 * Ручная бронь на кассе (060) — телефонный звонок. Создаётся сразу
 * в статусе 'confirmed'. locationId берётся из контекста устройства.
 */
export async function createReservation(
  locationId: string,
  staffId: string,
  input: CreateReservationInput,
): Promise<{ reservation_id: string }> {
  const { data, error } = await supabase.rpc('create_reservation', {
    p_location_id: locationId,
    p_staff_id: staffId,
    p_name: input.name,
    p_phone: input.phone,
    p_party_size: input.partySize,
    p_reserved_at: input.reservedAt,
    p_note: input.note,
    p_table_id: input.tableId,
  })
  if (error) throw new Error(error.message)
  return data as { reservation_id: string }
}

/** Подтвердить бронь, опционально сразу назначив стол */
export async function acceptReservation(id: string, staffId: string, tableId?: string | null): Promise<void> {
  const { error } = await supabase.rpc('accept_reservation', {
    p_id: id,
    p_staff_id: staffId,
    p_table_id: tableId ?? null,
  })
  if (error) throw new Error(error.message)
}

/** Отклонить заявку или отменить подтверждённую бронь (гость увидит причину) */
export async function rejectReservation(id: string, staffId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('reject_reservation', {
    p_id: id,
    p_staff_id: staffId,
    p_reason: reason ?? null,
  })
  if (error) throw new Error(error.message)
}

/**
 * Посадить бронь за стол (057): открыть счёт стола и привязать к брони.
 * Возвращает счёт для перехода в продажу. Идемпотентно (повтор → тот же счёт).
 */
export async function seatReservation(
  id: string,
  staffId: string,
): Promise<{ order_id: string; daily_number: number; total: number; existing: boolean }> {
  const { data, error } = await supabase.rpc('seat_reservation', { p_id: id, p_staff_id: staffId })
  if (error) throw new Error(error.message)
  return data as { order_id: string; daily_number: number; total: number; existing: boolean }
}

/** Назначить/сменить/снять (null) стол у подтверждённой брони */
export async function setReservationTable(id: string, staffId: string, tableId: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_reservation_table', {
    p_id: id,
    p_staff_id: staffId,
    p_table_id: tableId,
  })
  if (error) throw new Error(error.message)
}

/**
 * Realtime-подписка на брони. Имя канала уникально на каждый вызов:
 * supabase.channel(name) с повторным именем возвращает УЖЕ подписанный
 * канал, и повторный .on() после subscribe() кидает исключение
 * (урок online/api.ts — белый экран /online).
 */
let channelSeq = 0
export function subscribeReservations(onChange: () => void) {
  const channel = supabase
    .channel(`reservations-${++channelSeq}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, onChange)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}
