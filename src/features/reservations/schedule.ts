/**
 * Расписание брони на клиенте (117) — зеркало серверных функций
 * `reservation_schedule` / `reservation_day_windows` / сетки слотов
 * `reservation_availability`.
 *
 * Зачем зеркало, а не «спросить сервер». Live-доступность запрашивается
 * только в instant-режиме; в обычном режиме сетку строит страница. До 117
 * она строила её по единственной паре open/close и в часовом поясе
 * УСТРОЙСТВА гостя — отсюда и субботние слоты у заведения, закрытого по
 * субботам, и расхождение времени у гостя с чужой временной зоной.
 * Теперь обе стороны читают одну структуру и считают в зоне ТОЧКИ.
 *
 * Правила совпадают с SQL дословно:
 *   • границы окна включительны с обеих сторон;
 *   • окно через полночь принадлежит дате начала и продолжается за 24:00;
 *   • исключение по дате замещает недельное правило целиком;
 *   • несуществующее локальное время (весенний перевод часов) выбрасывается.
 */

export type HoursWindow = [string, string]

export interface ReserveSchedule {
  weekly: Record<string, HoursWindow[]>
  exceptions: Record<string, HoursWindow[]>
  leadMin: number
  horizonDays: number
}

/** Слот сетки: метка для показа и абсолютный момент для отправки */
export interface ScheduleSlot {
  time: string
  at: Date
}

const DEF_OPEN = '07:00'
const DEF_CLOSE = '23:45'
const DEF_LEAD_MIN = 30
const DEF_HORIZON_DAYS = 30

/** 'HH:MM' → минуты от полуночи; мусор → null */
export function hmToMin(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? '')
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Минуты от полуночи → 'HH:MM' (за сутками — по модулю, как на сервере) */
export function minToHm(mins: number): string {
  return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`
}

function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function isWindowList(value: unknown): value is HoursWindow[] {
  return Array.isArray(value)
    && value.every((w) => Array.isArray(w) && hmToMin(w[0]) !== null && hmToMin(w[1]) !== null)
}

export interface ScheduleSource {
  schedule?: {
    weekly?: Record<string, unknown>
    exceptions?: Record<string, unknown>
    lead_min?: number
    horizon_days?: number
  } | null
  /** Legacy-пара (059): одно окно на все семь дней */
  open?: string | null
  close?: string | null
}

/**
 * Настройки точки → каноническое расписание. Без ключа schedule
 * разворачивает legacy open/close в семь одинаковых дней — ровно как
 * серверная `reservation_schedule`, поэтому точка, до которой не дошёл
 * бэкфилл, ведёт себя на клиенте так же, как на сервере.
 */
export function normalizeSchedule(source: ScheduleSource | null | undefined): ReserveSchedule {
  const raw = source?.schedule
  const weekly: Record<string, HoursWindow[]> = {}

  if (raw && isPlainObject(raw.weekly)) {
    for (const key of Object.keys(raw.weekly)) {
      const windows = raw.weekly[key]
      if (isWindowList(windows)) weekly[key] = windows
      else weekly[key] = []
    }
  } else {
    const open = hmToMin(source?.open) !== null ? (source!.open as string) : DEF_OPEN
    const close = hmToMin(source?.close) !== null ? (source!.close as string) : DEF_CLOSE
    for (let d = 0; d < 7; d += 1) weekly[String(d)] = [[open, close]]
  }

  const exceptions: Record<string, HoursWindow[]> = {}
  if (raw && isPlainObject(raw.exceptions)) {
    for (const key of Object.keys(raw.exceptions)) {
      const windows = raw.exceptions[key]
      if (isWindowList(windows)) exceptions[key] = windows
      else if (Array.isArray(windows)) exceptions[key] = []
    }
  }

  return {
    weekly,
    exceptions,
    leadMin: clampInt(raw?.lead_min, DEF_LEAD_MIN, 0, 43200),
    horizonDays: clampInt(raw?.horizon_days, DEF_HORIZON_DAYS, 1, 365),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Окна конкретной локальной даты: исключение замещает неделю целиком */
export function dayWindows(schedule: ReserveSchedule, dateStr: string): HoursWindow[] {
  const exception = schedule.exceptions[dateStr]
  if (exception) return exception
  const dow = dowOf(dateStr)
  if (dow === null) return []
  return schedule.weekly[String(dow)] ?? []
}

/** День недели локальной даты 'YYYY-MM-DD' (0 = вс) без участия таймзон */
export function dowOf(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()
}

/** Сдвиг даты на N суток по календарю, без таймзонных сюрпризов */
export function shiftDate(dateStr: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return dateStr
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() + days)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// ── Часовой пояс точки ───────────────────────────────────────

/**
 * Умеет ли движок разбирать дату в произвольной зоне. Целевой WebView
 * Android 7.1 может не знать formatToParts; там честно возвращаем false и
 * считаем в зоне устройства — прежнее поведение, а не белый экран.
 */
export function supportsZones(): boolean {
  try {
    return typeof Intl !== 'undefined'
      && typeof Intl.DateTimeFormat === 'function'
      && typeof Intl.DateTimeFormat.prototype.formatToParts === 'function'
  } catch {
    return false
  }
}

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    partsCache.set(tz, fmt)
  }
  return fmt
}

/** Локальные компоненты момента в зоне точки */
export function partsInZone(at: Date, tz: string): {
  year: number; month: number; day: number; hour: number; minute: number
} | null {
  if (!supportsZones()) return null
  try {
    const parts = formatterFor(tz).formatToParts(at)
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    const hour = get('hour')
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      // Некоторые движки отдают 24 вместо 00 для полуночи
      hour: hour === 24 ? 0 : hour,
      minute: get('minute'),
    }
  } catch {
    return null
  }
}

/**
 * Локальные дата+минуты в зоне точки → абсолютный момент.
 *
 * Два прохода, потому что смещение зоны зависит от самого момента: первый
 * даёт приближение, второй уточняет его на границе перевода часов. Без
 * поддержки зон считаем в зоне устройства (прежнее поведение страницы).
 */
export function zonedToUtc(dateStr: string, minutes: number, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return new Date(NaN)
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  // Минуты могут выходить за сутки (ночная смена) — Date.UTC переносит дату сам
  const asUtc = Date.UTC(y, mo - 1, d, 0, minutes)

  if (!supportsZones()) {
    const local = new Date(y, mo - 1, d, 0, 0, 0, 0)
    local.setMinutes(local.getMinutes() + minutes)
    return local
  }

  let guess = new Date(asUtc - offsetAt(asUtc, tz))
  guess = new Date(asUtc - offsetAt(guess.getTime(), tz))
  return guess
}

function offsetAt(ts: number, tz: string): number {
  const p = partsInZone(new Date(ts), tz)
  if (!p) return 0
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ts
}

/**
 * Существует ли такое локальное время в зоне точки. Весной 02:00 → 03:00,
 * и оба «времени» отображаются в ОДИН момент: без этой проверки гость
 * выбрал бы 02:00, а забронировал 03:00.
 */
export function localTimeExists(dateStr: string, minutes: number, tz: string): boolean {
  if (!supportsZones()) return true
  const at = zonedToUtc(dateStr, minutes, tz)
  const p = partsInZone(at, tz)
  if (!p) return true
  return p.hour * 60 + p.minute === minutes % 1440
}

// ── Сетка слотов ─────────────────────────────────────────────

export interface SlotGridOptions {
  schedule: ReserveSchedule
  dateStr: string
  tz: string
  stepMin: number
  /** «Сейчас» в мс — параметром ради тестируемости */
  nowMs: number
}

/**
 * Слоты даты — зеркало цикла `reservation_availability`. Обходятся ВСЕ
 * окна дня (обед и ужин — разные окна), окно через полночь продолжается
 * за 24:00, слоты вне lead/horizon и несуществующие локальные времена
 * отбрасываются, дубли меток схлопываются.
 */
export function slotGrid({ schedule, dateStr, tz, stepMin, nowMs }: SlotGridOptions): ScheduleSlot[] {
  const step = stepMin > 0 ? stepMin : 15
  const minTs = nowMs + schedule.leadMin * 60_000
  const maxTs = nowMs + schedule.horizonDays * 86_400_000
  const seen = new Set<string>()
  const out: ScheduleSlot[] = []

  for (const win of dayWindows(schedule, dateStr)) {
    const from = hmToMin(win[0])
    let to = hmToMin(win[1])
    if (from === null || to === null) continue
    if (to < from) to += 1440

    for (let mins = from; mins <= to; mins += step) {
      const label = minToHm(mins)
      if (seen.has(label)) continue
      if (!localTimeExists(dateStr, mins, tz)) continue
      const at = zonedToUtc(dateStr, mins, tz)
      const ts = at.getTime()
      if (!Number.isFinite(ts) || ts < minTs || ts > maxTs) continue
      seen.add(label)
      out.push({ time: label, at })
    }
  }

  return out
}

/**
 * Есть ли у даты хоть один бронируемый слот. Отдельная функция, а не
 * `slotGrid(...).length > 0`: селект дат спрашивает это про каждый из
 * ~60 дней на каждом рендере, а полная сетка дня — это десятки переводов
 * времени через Intl. Здесь выход по первому найденному слоту, поэтому
 * открытый день стоит один-два перевода, а закрытый — ни одного.
 */
export function hasBookableSlot({
  schedule, dateStr, tz, stepMin, nowMs,
}: SlotGridOptions): boolean {
  const step = stepMin > 0 ? stepMin : 15
  const minTs = nowMs + schedule.leadMin * 60_000
  const maxTs = nowMs + schedule.horizonDays * 86_400_000

  for (const win of dayWindows(schedule, dateStr)) {
    const from = hmToMin(win[0])
    let to = hmToMin(win[1])
    if (from === null || to === null) continue
    if (to < from) to += 1440

    for (let mins = from; mins <= to; mins += step) {
      if (!localTimeExists(dateStr, mins, tz)) continue
      const ts = zonedToUtc(dateStr, mins, tz).getTime()
      if (!Number.isFinite(ts)) continue
      // Слоты идут по возрастанию: перевалили за горизонт — дальше только хуже
      if (ts > maxTs) break
      if (ts >= minTs) return true
    }
  }
  return false
}

// ── Показ часов работы ───────────────────────────────────────

export interface HoursRow {
  /** Индексы дней недели подряд идущей группы */
  days: number[]
  /** Окна группы; пустой массив = закрыто */
  windows: HoursWindow[]
}

/** Окна дня → «08:00–20:00, 18:00–23:00»; пусто = день закрыт */
export function formatWindows(windows: HoursWindow[]): string {
  return windows.map((w) => `${w[0]}–${w[1]}`).join(', ')
}

/**
 * Открыто ли заведение прямо сейчас — для точки «открыто» в полосе часов.
 *
 * Проверяются окна СЕГОДНЯШНЕЙ даты и окна вчерашней, перешедшие полночь:
 * заведение, работающее до 02:00, в час ночи открыто по вчерашнему окну, а
 * не по сегодняшнему. Ровно так же считает сетка слотов (окно принадлежит
 * дате начала и продолжается за 24:00), поэтому показанное «открыто» не
 * расходится с тем, что реально можно забронировать.
 */
export function isOpenAt(
  schedule: ReserveSchedule, dateStr: string, minutes: number,
): boolean {
  const within = (windows: HoursWindow[], value: number) => windows.some((w) => {
    const from = hmToMin(w[0])
    let to = hmToMin(w[1])
    if (from === null || to === null) return false
    if (to < from) to += 1440
    return value >= from && value <= to
  })
  if (within(dayWindows(schedule, dateStr), minutes)) return true
  // Вчерашнее окно за полночь: 01:30 сегодня = 25:30 вчерашних суток
  return within(dayWindows(schedule, shiftDate(dateStr, -1)), minutes + 1440)
}

/**
 * Недельное расписание → строки для показа: подряд идущие дни с
 * одинаковыми окнами схлопываются в одну строку («вс–чт · 08:00–20:00»).
 * Это и есть замена свободному тексту `hours`: гость видит ровно то
 * расписание, по которому строится сетка.
 */
export function weeklyHoursRows(schedule: ReserveSchedule): HoursRow[] {
  const rows: HoursRow[] = []
  for (let d = 0; d < 7; d += 1) {
    const windows = schedule.weekly[String(d)] ?? []
    const key = JSON.stringify(windows)
    const last = rows[rows.length - 1]
    if (last && JSON.stringify(last.windows) === key) {
      last.days.push(d)
    } else {
      rows.push({ days: [d], windows })
    }
  }
  return rows
}
