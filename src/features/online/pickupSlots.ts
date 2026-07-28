/**
 * Слоты времени заказа внутри часов работы точки (112).
 *
 * Раньше время вводилось свободным `<input type="time">`, и гость мог
 * выбрать 23:30 при закрытии в 20:00 — заявка уходила в инбокс на время,
 * когда точка закрыта. Теперь выбор ограничен готовыми слотами, а сервер
 * (submit_online_order) проверяет то же правило независимо.
 *
 * Расписание приходит из public-menu как `hours`: ключ — день недели
 * (0 = воскресенье) в таймзоне ТОЧКИ, значение — массив окон
 * [["08:00","16:00"], ...]. Окно с концом меньше начала — переход через
 * полночь. Формат и семантика зеркалят online_hours_open_at в БД.
 */

export type Hours = Record<string, [string, string][]>

export interface PickupSlot {
  /** ISO-момент начала слота */
  iso: string
  /** «HH:MM» в таймзоне точки — то, что видит гость */
  label: string
  /** Слот относится к сегодняшнему или завтрашнему дню точки */
  day: 'today' | 'tomorrow'
}

/** Шаг сетки слотов по умолчанию — четверть часа */
export const SLOT_STEP_MIN = 15

/**
 * Горизонт заказа: сегодня и завтра. Совпадает с лимитом 24 часов в
 * submit_online_order — дальше сервер всё равно ответит invalid_pickup.
 */
const HORIZON_DAYS = 2

const HHMM_RE = /^(\d{1,2}):(\d{2})$/

/** «HH:MM» → минуты от полуночи; null для мусора. */
function parseHhMm(value: string): number | null {
  const match = HHMM_RE.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Минуты от полуночи → «HH:MM» (минуты за сутки заворачиваются). */
function formatHhMm(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`
}

/**
 * Календарные части момента в произвольной таймзоне.
 *
 * Через Intl, а не через смещение: в Израиле есть переход на летнее время,
 * и фиксированный сдвиг давал бы час ошибки дважды в год.
 */
function partsInTz(date: Date, tz: string): {
  year: number; month: number; day: number; minutes: number; dow: number
} {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((part) => [part.type, part.value])
  ) as Record<string, string>

  const DOW: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  // 24:00 вместо 00:00 встречается в некоторых окружениях hour12: false
  const hour = Number(parts.hour) % 24

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    minutes: hour * 60 + Number(parts.minute),
    dow: DOW[parts.weekday] ?? 0,
  }
}

/** Смещение таймзоны в минутах для конкретного момента (с учётом DST). */
function tzOffsetMinutes(date: Date, tz: string): number {
  const p = partsInTz(date, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0) + p.minutes * 60_000
  return (asUtc - date.getTime()) / 60_000
}

/**
 * Локальные «дата + минуты от полуночи» в таймзоне точки → абсолютный момент.
 *
 * Смещение берём итеративно: первое приближение может попасть в другую
 * сторону перехода DST, второй проход это исправляет.
 */
function zonedToDate(
  year: number, month: number, day: number, minutes: number, tz: string
): Date {
  const guessUtc = Date.UTC(year, month - 1, day, 0, 0) + minutes * 60_000
  let result = new Date(guessUtc - tzOffsetMinutes(new Date(guessUtc), tz) * 60_000)
  result = new Date(guessUtc - tzOffsetMinutes(result, tz) * 60_000)
  return result
}

/** Окна дня недели из расписания; пустой массив = день закрыт. */
function windowsFor(hours: Hours, dow: number): [number, number][] {
  const raw = hours[String(dow)]
  if (!Array.isArray(raw)) return []
  const result: [number, number][] = []
  for (const win of raw) {
    if (!Array.isArray(win) || win.length < 2) continue
    const from = parseHhMm(String(win[0]))
    const to = parseHhMm(String(win[1]))
    // Битое окно пропускаем, а не роняем весь список — зеркало логики в БД
    if (from === null || to === null) continue
    result.push([from, to])
  }
  return result
}

/**
 * Слоты заказа на сегодня и завтра в таймзоне точки.
 *
 * @param hours    расписание из public-menu; null/пусто = приём в любое время
 * @param tz       таймзона точки (по умолчанию — Израиль)
 * @param now      «сейчас»
 * @param stepMin  шаг сетки в минутах
 *
 * Прошедшие слоты отброшены. Окно через полночь продолжается в следующий
 * день и не рвётся на границе суток. Без расписания выдаётся ровная сетка
 * на сутки вперёд — так гость всё равно выбирает из слотов, а не из
 * произвольного времени.
 */
export function buildPickupSlots(
  hours: Hours | null | undefined,
  tz = 'Asia/Jerusalem',
  now = new Date(),
  stepMin = SLOT_STEP_MIN
): PickupSlot[] {
  const zone = tz || 'Asia/Jerusalem'
  const today = partsInTz(now, zone)
  const slots: PickupSlot[] = []
  const seen = new Set<string>()

  const push = (dayIndex: number, minutes: number) => {
    // Минуты сверх суток переносят слот на следующий календарный день
    const base = zonedToDate(today.year, today.month, today.day + dayIndex, minutes, zone)
    if (base.getTime() <= now.getTime()) return
    const iso = base.toISOString()
    if (seen.has(iso)) return
    seen.add(iso)
    slots.push({
      iso,
      label: formatHhMm(minutes),
      day: dayIndex === 0 && minutes < 1440 ? 'today' : 'tomorrow',
    })
  }

  const hasSchedule = hours && typeof hours === 'object' && Object.keys(hours).length > 0

  for (let dayIndex = 0; dayIndex < HORIZON_DAYS; dayIndex += 1) {
    if (!hasSchedule) {
      // Расписание не настроено: ровная сетка суток, приём не ограничен
      for (let m = 0; m < 1440; m += stepMin) push(dayIndex, m)
      continue
    }

    const dow = (today.dow + dayIndex) % 7
    for (const [from, to] of windowsFor(hours as Hours, dow)) {
      // Окно через полночь: конец переносим за границу суток, чтобы
      // 20:00–02:00 давало непрерывную ленту слотов до 01:45.
      const end = to > from ? to : to + 1440
      // Первый слот выравниваем по сетке шага от начала окна
      for (let m = from; m < end; m += stepMin) push(dayIndex, m)
    }
  }

  return slots.sort((a, b) => a.iso.localeCompare(b.iso))
}
