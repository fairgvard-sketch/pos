import { partsInZone, shiftDate } from './schedule'
import { blockState, type BlockState } from './timeline'
import type { Reservation } from './api'

/**
 * Лента броней: отбор, порядок, дни и страницы.
 *
 * Список на кассе был сеткой карточек — «Новые», «Сегодня», «Будущие» по
 * дням и свёрнутая «История». Найти в нём конкретную бронь можно было
 * только глазами: ни фильтра по состоянию, ни по залу, ни поиска, а
 * прошедшие дни не показывались вовсе.
 *
 * Правила отбора живут здесь, а не в разметке: их видно целиком и можно
 * проверить тестом. Зеркало `anglesite/backoffice/src/reservation-list.js` —
 * кабинет и касса обязаны отвечать на вопрос «что у нас в субботу
 * вечером» одинаково.
 */

/** Состояние визита в ленте: живые состояния полотна + отказ и отмена */
export type VisitState = BlockState | 'rejected' | 'cancelled'

/** Путь заведения визита (136): кто нажал кнопку */
export type CreatedVia = 'public' | 'pos' | 'backoffice' | 'waitlist' | 'unknown'

export const VIA_KEYS: CreatedVia[] = ['public', 'pos', 'backoffice', 'waitlist', 'unknown']

export const VISIT_STATES: VisitState[] = [
  'pending', 'confirmed', 'arrived', 'done', 'noshow', 'rejected', 'cancelled',
]

/**
 * Состояние визита из его полей.
 *
 * `blockState` отвечает за живые состояния таймлайна и про отказ с
 * отменой не знает — на полотне их нет. В ленте есть, поэтому решаются
 * здесь, а эталонный модуль не трогаем.
 */
export function visitState(r: Reservation): VisitState {
  if (r.status === 'rejected' || r.status === 'cancelled') return r.status
  return blockState(r.status, r.arrived_at ?? null, r.order_id)
}

/**
 * Каким путём заведён визит.
 *
 * Не путать с каналом привода гостя (instagram, qr, site). Пусто значит
 * «путь не записан» — так выглядят брони до 136. Назвать их гостевыми
 * было бы догадкой, выданной за факт.
 */
export function createdVia(r: Reservation): CreatedVia {
  const via = r.created_via
  return via && (VIA_KEYS as string[]).includes(via) ? via as CreatedVia : 'unknown'
}

/** Столы визита: связь 119 → основной стол → объединённые */
export function tableIdsOf(r: Reservation): string[] {
  const ids = [
    ...(r.tables_link ?? []).map((l) => l.table_id),
    r.table_id,
    ...(r.hold_table_ids ?? []),
  ].filter((id): id is string => !!id)
  return [...new Set(ids)]
}

/** Зона визита: сначала по назначенным столам, потом по пожеланию гостя */
export function zoneOf(r: Reservation, zoneByTable: Map<string, string | null> | null): string | null {
  for (const id of tableIdsOf(r)) {
    const zoneId = zoneByTable?.get(id)
    if (zoneId) return zoneId
  }
  return r.zone?.id ?? r.zone_id ?? null
}

/** Совпадает ли бронь с поиском по имени или телефону */
export function matchesQuery(r: Reservation, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const digits = needle.replace(/\D/g, '')
  const phone = (r.customer_phone ?? '').replace(/\D/g, '')
  if (digits.length >= 3 && phone.includes(digits)) return true
  return (r.customer_name ?? '').toLowerCase().includes(needle)
}

export interface ListFilters {
  state?: VisitState | null
  zone?: string | null
  via?: CreatedVia | null
  query?: string
  zoneByTable?: Map<string, string | null> | null
}

/** Отбор по состоянию, залу, пути и поиску. Пустой фильтр — «всё», не «ничего». */
export function filterReservations(rows: Reservation[], filters: ListFilters = {}): Reservation[] {
  const { state = null, zone = null, via = null, query = '', zoneByTable = null } = filters
  return rows.filter((r) => {
    if (state && visitState(r) !== state) return false
    if (zone && zoneOf(r, zoneByTable) !== zone) return false
    if (via && createdVia(r) !== via) return false
    return matchesQuery(r, query)
  })
}

/**
 * Порядок по времени визита. Обратимый: утром хостес смотрит вперёд, а
 * разбирая вчерашнее — назад.
 */
export function sortByTime(rows: Reservation[], direction: 'asc' | 'desc' = 'asc'): Reservation[] {
  const sign = direction === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const diff = new Date(a.reserved_at).getTime() - new Date(b.reserved_at).getTime()
    // Одинаковое время — стабильный порядок по имени, иначе строки прыгают
    // при каждой перерисовке от realtime
    if (diff !== 0) return sign * diff
    return (a.customer_name ?? '').localeCompare(b.customer_name ?? '')
  })
}

/** Сутки визита в зоне ТОЧКИ, а не устройства */
export function dayKey(iso: string, tz: string): string {
  const p = partsInZone(new Date(iso), tz)
  if (!p) return iso.slice(0, 10)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Относительная подпись дня; null — подписываем датой */
export type DayRel = 'today' | 'tomorrow' | 'yesterday' | null

export interface DayGroup {
  key: string
  rel: DayRel
  rows: Reservation[]
}

/**
 * Группировка по дню визита в часах точки: хостес в зале и владелец в
 * отпуске обязаны видеть одинаковые сутки.
 */
export function groupByDay(rows: Reservation[], tz: string, todayStr: string): DayGroup[] {
  const groups: DayGroup[] = []
  const index = new Map<string, DayGroup>()
  for (const row of rows) {
    const key = dayKey(row.reserved_at, tz)
    let group = index.get(key)
    if (!group) {
      group = { key, rel: dayRel(key, todayStr), rows: [] }
      index.set(key, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups
}

/** «Сегодня», «Завтра», «Вчера» — остальное датой */
export function dayRel(key: string, todayStr: string): DayRel {
  if (!todayStr) return null
  if (key === todayStr) return 'today'
  if (key === shiftDate(todayStr, 1)) return 'tomorrow'
  if (key === shiftDate(todayStr, -1)) return 'yesterday'
  return null
}

export const PAGE_SIZE = 25

export interface PageSlice<T> {
  items: T[]
  page: number
  pages: number
  total: number
  /** Номер первой строки страницы, 1-based; 0 — строк нет */
  from: number
  to: number
}

/**
 * Страница ленты. Номер приводится к существующему: после ужесточения
 * фильтра третья страница может исчезнуть, и показывать пустоту вместо
 * результатов нельзя.
 */
export function paginate<T>(rows: T[], page = 1, size = PAGE_SIZE): PageSlice<T> {
  const total = rows.length
  const pages = Math.max(1, Math.ceil(total / size))
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages)
  const from = (current - 1) * size
  return {
    items: rows.slice(from, from + size),
    page: current,
    pages,
    total,
    from: total === 0 ? 0 : from + 1,
    to: Math.min(from + size, total),
  }
}
