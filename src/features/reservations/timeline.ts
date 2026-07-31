/**
 * Раскладка таймлайна хостес (Phase 3): столы по вертикали, время по
 * горизонтали, бронь — блок длиной в визит.
 *
 * Вся геометрия и все правила — здесь, чистыми функциями. Компонент только
 * рисует то, что посчитано: иначе «почему блок налез на соседний» пришлось
 * бы отлаживать в DOM, а не в тестах. Занятость приходит с сервера
 * (reservation_tables, 119) — клиент её не выводит из массивов.
 */

import { dayWindows, hmToMin, type ReserveSchedule } from './schedule'
import { zonedToUtc } from './schedule'

/** Статус блока на таймлайне — производная от статуса брони и посадки */
export type BlockState = 'pending' | 'confirmed' | 'arrived' | 'done' | 'noshow'

export interface TimelineTable {
  id: string
  label: string
  seats: number
  zoneId: string | null
  zoneName: string | null
  sortOrder: number
  /** Стол выключен в плане зала — показываем полосой «недоступен» */
  blocked: boolean
}

export interface TimelineBooking {
  id: string
  /** Все столы визита, включая добавленные объединением */
  tableIds: string[]
  startMs: number
  endMs: number
  state: BlockState
  guestName: string
  partySize: number
  /** Бронь посажена в POS-заказ — её ведёт касса */
  posSeated: boolean
  zoneName: string | null
  note: string | null
}

export interface TimelineWindow {
  startMs: number
  endMs: number
}

export interface PositionedBlock {
  booking: TimelineBooking
  leftPct: number
  widthPct: number
  /** Визит начался до окна / кончается после — рисуем «обрезанный» край */
  clipsStart: boolean
  clipsEnd: boolean
  /** Блок пересекается с соседним на этом же столе */
  conflict: boolean
  /** Стол — часть объединения этой брони */
  combined: boolean
}

export interface TimelineRow {
  table: TimelineTable
  blocks: PositionedBlock[]
}

export interface TimelineZone {
  id: string | null
  name: string | null
  rows: TimelineRow[]
}

const HOUR_MS = 3_600_000
const DEFAULT_FROM_MIN = 8 * 60
const DEFAULT_TO_MIN = 24 * 60

/**
 * Видимое окно дня. Основа — расписание точки: показывать сутки целиком
 * бессмысленно, хостес смотрит на смену. Окно расширяется под брони,
 * выпадающие за расписание (ручная бронь на нерабочее время разрешена, и
 * она обязана быть видна, а не молча исчезнуть).
 */
export function timelineWindow(
  dateStr: string,
  tz: string,
  schedule: ReserveSchedule | null,
  bookings: TimelineBooking[] = [],
): TimelineWindow {
  let fromMin = DEFAULT_FROM_MIN
  let toMin = DEFAULT_TO_MIN

  const windows = schedule ? dayWindows(schedule, dateStr) : []
  const parsed = windows
    .map((w) => {
      const from = hmToMin(w[0])
      let to = hmToMin(w[1])
      if (from === null || to === null) return null
      if (to < from) to += 1440
      return { from, to }
    })
    .filter((w): w is { from: number; to: number } => w !== null)

  if (parsed.length > 0) {
    fromMin = Math.min(...parsed.map((w) => w.from))
    toMin = Math.max(...parsed.map((w) => w.to))
    // Дышим по получасу с обеих сторон: гость приходит чуть раньше, а
    // визит, начатый в последний слот, кончается уже после закрытия.
    fromMin -= 30
    toMin += 90
  }

  let startMs = zonedToUtc(dateStr, Math.max(0, fromMin), tz).getTime()
  let endMs = zonedToUtc(dateStr, toMin, tz).getTime()

  for (const b of bookings) {
    if (b.startMs < startMs) startMs = b.startMs
    if (b.endMs > endMs) endMs = b.endMs
  }
  if (!(endMs > startMs)) {
    endMs = startMs + 12 * HOUR_MS
  }
  return { startMs, endMs }
}

/** Позиция отрезка в окне, в процентах ширины */
export function positionOf(
  startMs: number, endMs: number, win: TimelineWindow,
): { leftPct: number; widthPct: number; clipsStart: boolean; clipsEnd: boolean } {
  const span = win.endMs - win.startMs
  if (span <= 0) return { leftPct: 0, widthPct: 0, clipsStart: false, clipsEnd: false }
  const from = Math.max(startMs, win.startMs)
  const to = Math.min(endMs, win.endMs)
  const leftPct = ((from - win.startMs) / span) * 100
  const widthPct = Math.max(0, ((to - from) / span) * 100)
  return {
    leftPct,
    widthPct,
    clipsStart: startMs < win.startMs,
    clipsEnd: endMs > win.endMs,
  }
}

/** Часовые отметки шкалы: подписи и их позиции */
export function hourTicks(win: TimelineWindow, tz: string): { label: string; leftPct: number }[] {
  const span = win.endMs - win.startMs
  if (span <= 0) return []
  const out: { label: string; leftPct: number }[] = []
  // Первая круглая точка не раньше начала окна
  const first = Math.ceil(win.startMs / HOUR_MS) * HOUR_MS
  for (let ts = first; ts <= win.endMs; ts += HOUR_MS) {
    out.push({
      label: hourLabelInZone(ts, tz),
      leftPct: ((ts - win.startMs) / span) * 100,
    })
  }
  return out
}

function hourLabelInZone(ts: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('he-IL', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(ts))
  } catch {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

/** Метка «сейчас» — null, если текущий момент вне окна дня */
export function nowMarkerPct(nowMs: number, win: TimelineWindow): number | null {
  const span = win.endMs - win.startMs
  if (span <= 0) return null
  if (nowMs < win.startMs || nowMs > win.endMs) return null
  return ((nowMs - win.startMs) / span) * 100
}

/**
 * Строки таймлайна: стол → блоки его броней. Столы, у которых на дне
 * ничего нет, остаются в списке — пустая строка и есть ответ «свободно».
 */
export function buildRows(
  tables: TimelineTable[],
  bookings: TimelineBooking[],
  win: TimelineWindow,
): TimelineRow[] {
  const byTable = new Map<string, TimelineBooking[]>()
  for (const b of bookings) {
    for (const tableId of b.tableIds) {
      const list = byTable.get(tableId)
      if (list) list.push(b)
      else byTable.set(tableId, [b])
    }
  }

  return [...tables]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, 'he'))
    .map((table) => {
      const list = (byTable.get(table.id) ?? [])
        .filter((b) => b.endMs > win.startMs && b.startMs < win.endMs)
        .sort((a, b) => a.startMs - b.startMs)

      const blocks: PositionedBlock[] = list.map((booking) => {
        const pos = positionOf(booking.startMs, booking.endMs, win)
        return {
          booking,
          ...pos,
          conflict: false,
          combined: booking.tableIds.length > 1,
        }
      })

      // Пересечения на одном столе. После 119 их не должно быть у живых
      // броней, но терминальные визиты и ручные правки в БД возможны —
      // хостес обязан увидеть проблему, а не ровную картинку.
      for (let i = 1; i < blocks.length; i += 1) {
        const prev = blocks[i - 1].booking
        const cur = blocks[i].booking
        if (cur.startMs < prev.endMs && isLive(cur.state) && isLive(prev.state)) {
          blocks[i].conflict = true
          blocks[i - 1].conflict = true
        }
      }

      return { table, blocks }
    })
}

function isLive(state: BlockState): boolean {
  return state === 'pending' || state === 'confirmed' || state === 'arrived'
}

/** Группировка строк по зонам зала — сначала зоны по порядку, затем «без зоны» */
export function groupByZone(rows: TimelineRow[]): TimelineZone[] {
  const zones: TimelineZone[] = []
  const index = new Map<string, TimelineZone>()

  for (const row of rows) {
    const key = row.table.zoneId ?? '__none__'
    let zone = index.get(key)
    if (!zone) {
      zone = { id: row.table.zoneId, name: row.table.zoneName, rows: [] }
      index.set(key, zone)
      zones.push(zone)
    }
    zone.rows.push(row)
  }
  // Столы без зоны — в конец: они исключение, а не начало зала
  return zones.sort((a, b) => Number(a.id === null) - Number(b.id === null))
}

export interface OccupancySummary {
  /** Столов занято прямо сейчас */
  busyTables: number
  totalTables: number
  /** Мест свободно сейчас */
  freeSeats: number
  totalSeats: number
  /** Броней, начинающихся в ближайший час */
  soon: number
  /** Ожидают решения */
  pending: number
}

/**
 * Сводка «что происходит» — то, ради чего хостес смотрит на экран первые
 * пять секунд. Считается по тем же блокам, что и рисуются, поэтому цифра
 * не может разойтись с картинкой.
 */
export function occupancySummary(
  rows: TimelineRow[], nowMs: number, soonMs = HOUR_MS,
): OccupancySummary {
  let busyTables = 0
  let freeSeats = 0
  let totalSeats = 0
  let totalTables = 0
  const soonIds = new Set<string>()
  const pendingIds = new Set<string>()

  for (const row of rows) {
    if (row.table.blocked) continue
    totalTables += 1
    totalSeats += row.table.seats

    const busyNow = row.blocks.some(
      (b) => isLive(b.booking.state) && b.booking.startMs <= nowMs && b.booking.endMs > nowMs,
    )
    if (busyNow) busyTables += 1
    else freeSeats += row.table.seats

    for (const b of row.blocks) {
      if (b.booking.state === 'pending') pendingIds.add(b.booking.id)
      if (
        isLive(b.booking.state)
        && b.booking.startMs > nowMs
        && b.booking.startMs <= nowMs + soonMs
      ) soonIds.add(b.booking.id)
    }
  }

  return {
    busyTables,
    totalTables,
    freeSeats,
    totalSeats,
    soon: soonIds.size,
    pending: pendingIds.size,
  }
}

/** Состояние блока из полей брони — одно место, где это решается */
export function blockState(
  status: string, arrivedAt: string | null, orderId: string | null,
): BlockState {
  if (status === 'completed') return 'done'
  if (status === 'no_show') return 'noshow'
  if (status === 'new') return 'pending'
  if (arrivedAt || orderId) return 'arrived'
  return 'confirmed'
}
