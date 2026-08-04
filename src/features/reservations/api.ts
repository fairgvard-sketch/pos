import { supabase } from '../../lib/supabase'
import { historySince, type HistoryPeriod } from '../online/api'

export type { HistoryPeriod }

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
  /** Пожелание зоны от гостя (072); null = без предпочтений */
  zone: { id: string; name: string } | null
  /** Бронь пришла мгновенной (063, instant-режим) — без ручного подтверждения */
  auto: boolean
  /** Длительность визита, мин (063) */
  duration_min: number
  /** Доп. столы объединённой брони (063) — кроме основного table_id */
  hold_table_ids: string[]
  /** Депозит (063, плейсхолдер) */
  deposit_amount: number
  deposit_status: 'none' | 'required' | 'paid' | 'refunded' | 'forfeited'
  /** Момент посадки гостя (119); POS дополнительно отмечает её order_id */
  arrived_at?: string | null
  /** Все столы визита, включая объединение (119) — источник для таймлайна */
  tables_link?: { table_id: string; is_primary: boolean }[]
  /** Пожелание зоны как id (072) — когда вложенный объект zone не запрошен */
  zone_id?: string | null
  /**
   * Путь заведения визита (136): кто нажал кнопку — гость, касса, кабинет
   * или согласие из листа ожидания. null у броней, заведённых до 136.
   */
  created_via?: 'public' | 'pos' | 'backoffice' | 'waitlist' | null
  /** Тестовая бронь запуска (126): настоящая, но не попадает в отчёты */
  is_test?: boolean
}

/** Статусы, которые терминальны для веб-стола хостес (102) */
export type ReservationStatusFull = ReservationStatus | 'completed' | 'no_show'

/** Профиль гостя по телефону (063 → 121): единая запись брони и продаж */
export interface GuestHistory {
  visits: number
  cancelled: number
  total: number
  last_at: string | null
  name: string | null
  /** Заметки из самих броней (последние 5) */
  notes: string[]
  /** Профиль в базе клиентов (121); null — телефона нет в базе */
  guest_id?: string | null
  /** Заметка бариста о госте */
  guest_note?: string | null
  /** Внутренние метки: VIP, аллергия, дважды не пришёл (наружу не уходят) */
  tags?: string[]
  no_shows?: number
  upcoming?: number
  avg_party?: string | null
  zone?: string | null
  /** Денежная часть — только у точки с кассой */
  total_spent?: number
  pos_visits?: number
}

/**
 * История гостя по телефону (063) — для карточки брони на кассе.
 * Агрегат по всем броням org с этим номером. Пустой телефон → нули.
 */
export async function fetchGuestHistory(phone: string): Promise<GuestHistory> {
  const { data, error } = await supabase.rpc('guest_history', { p_phone: phone })
  if (error) throw new Error(error.message)
  return data as GuestHistory
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
    .select('*, table:table_id ( id, label ), zone:table_zones!reservations_zone_fk ( id, name )')
    .or(`status.eq.new,reserved_at.gte.${startOfToday.toISOString()}`)
    .order('reserved_at', { ascending: true })
    .limit(200)
  if (error) throw new Error(error.message)
  return data as Reservation[]
}

/**
 * История броней за период (вкладка «История»): все статусы, включая
 * прошедшие дни, свежие сверху. Поиск по имени/телефону — на сервере,
 * чтобы лимит не срезал совпадения за пределами первой страницы.
 */
export async function fetchReservationHistory(
  period: HistoryPeriod,
  search = '',
): Promise<Reservation[]> {
  let req = supabase
    .from('reservations')
    .select('*, table:table_id ( id, label ), zone:table_zones!reservations_zone_fk ( id, name )')
    .gte('reserved_at', historySince(period))

  const q = search.trim()
  if (q) {
    const digits = q.replace(/\D/g, '')
    req = digits.length >= 3
      ? req.like('customer_phone', `%${digits}%`)
      : req.ilike('customer_name', `%${q}%`)
  }

  const { data, error } = await req.order('reserved_at', { ascending: false }).limit(200)
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
    .select('*, table:table_id ( id, label ), zone:table_zones!reservations_zone_fk ( id, name )')
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

// ── Таймлайн хостес (Phase 3, 119) ───────────────────────────

const TIMELINE_SELECT =
  '*, table:table_id ( id, label ), zone:table_zones!reservations_zone_fk ( id, name ), '
  + 'tables_link:reservation_tables ( table_id, is_primary )'

/**
 * Брони, попадающие в сутки таймлайна. Берём с запасом в сутки назад:
 * ночная смена начинается вчера и заканчивается сегодня, а фильтровать
 * по концу визита через PostgREST нельзя — длительность у каждой своя.
 * Лишнее отсечёт раскладка по окну дня.
 */
export async function fetchTimelineReservations(
  fromMs: number, toMs: number,
): Promise<Reservation[]> {
  const { data, error } = await supabase
    .from('reservations')
    .select(TIMELINE_SELECT)
    .gte('reserved_at', new Date(fromMs - 24 * 3600_000).toISOString())
    .lt('reserved_at', new Date(toMs).toISOString())
    .order('reserved_at', { ascending: true })
    .limit(500)
  if (error) throw new Error(error.message)
  return data as unknown as Reservation[]
}

/** Сколько броней лента забирает за один заход */
const RANGE_LIMIT = 500

export interface ReservationRange {
  rows: Reservation[]
  /** Упёрлись в лимит: часть периода не показана, и об этом говорим вслух */
  capped: boolean
}

/**
 * Брони за отрезок времени — лента списка (день / ближайшие 7 / прошедшие 7).
 *
 * Отдельно от `fetchReservations`: тому нужны заявки и будущее, а ленте —
 * произвольное окно, включая прошедшие дни. Столы приходят связью 119,
 * поэтому зона визита считается по факту рассадки, а не по пожеланию.
 */
export async function fetchReservationsRange(
  fromMs: number, toMs: number,
): Promise<ReservationRange> {
  const { data, error } = await supabase
    .from('reservations')
    .select(TIMELINE_SELECT)
    .gte('reserved_at', new Date(fromMs).toISOString())
    .lt('reserved_at', new Date(toMs).toISOString())
    .order('reserved_at', { ascending: true })
    .limit(RANGE_LIMIT)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as unknown as Reservation[]
  return { rows, capped: rows.length >= RANGE_LIMIT }
}

/**
 * Набор столов брони одним действием (119): назначить, объединить,
 * разъединить. Пустой массив снимает столы. Первый становится основным —
 * в него сажает касса.
 */
export async function setReservationTables(
  id: string, staffId: string, tableIds: string[],
): Promise<void> {
  const { error } = await supabase.rpc('set_reservation_tables', {
    p_id: id,
    p_staff_id: staffId,
    p_table_ids: tableIds,
  })
  if (error) throw new Error(error.message)
}

export interface ReservationPatch {
  reservedAt?: string | null
  partySize?: number | null
  note?: string | null
  zoneId?: string | null
  durationMin?: number | null
}

/** Правка брони со стола хостес (119). Незаданные поля не меняются. */
export async function updateReservation(
  id: string, staffId: string, patch: ReservationPatch,
): Promise<void> {
  const { error } = await supabase.rpc('update_reservation', {
    p_id: id,
    p_staff_id: staffId,
    p_reserved_at: patch.reservedAt ?? null,
    p_party_size: patch.partySize ?? null,
    p_note: patch.note ?? null,
    p_zone_id: patch.zoneId ?? null,
    p_duration: patch.durationMin ?? null,
  })
  if (error) throw new Error(error.message)
}

/**
 * Отметить, что гость сел (119). Для точки без POS это и есть посадка:
 * счёт не открывается, стол остаётся занят до завершения визита.
 */
export async function markReservationArrived(id: string, staffId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_reservation_arrived', {
    p_id: id,
    p_staff_id: staffId,
  })
  if (error) throw new Error(error.message)
}
