import type { StaffHours, StaffHoursEntry } from './api'

/**
 * Чистая арифметика и форматы табеля: группировка смен по календарному дню,
 * краткая строка «01.08.2026 א 07:00 - 15:00» и выгрузка для Excel.
 *
 * Модуль без React и без Supabase — та же нарезка нужна экрану кассы,
 * печатной ленте и кабинету, а расходиться им нельзя (день недели и
 * суммы обязаны совпасть на бумаге и на экране).
 *
 * День смены считает СЕРВЕР (143) в часовом поясе точки и присылает
 * готовыми полями `day`/`dow`. Здесь их только показывают: пересчёт на
 * клиенте вернул бы ночную смену на соседний день у владельца, открывшего
 * кабинет из другого пояса.
 */

/** Дни недели на иврите: 0 = воскресенье. Печать чеков — только иврит. */
export const HEBREW_DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'] as const

/** Дни недели по-русски — для экрана и выгрузки, не для печати */
export const RU_DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const

export interface HoursDay {
  /** YYYY-MM-DD */
  day: string
  /** 0 = воскресенье */
  dow: number
  entries: StaffHoursEntry[]
  seconds: number
  /** В дне есть незакрытая смена — час считается «до сих пор» */
  hasOpen: boolean
}

/** Смены сотрудника → дни по возрастанию (сервер уже отдаёт их в порядке) */
export function groupByDay(entries: StaffHoursEntry[]): HoursDay[] {
  const days = new Map<string, HoursDay>()
  for (const e of entries) {
    const d = days.get(e.day) ?? { day: e.day, dow: e.dow, entries: [], seconds: 0, hasOpen: false }
    d.entries.push(e)
    d.seconds += e.seconds
    d.hasOpen = d.hasOpen || e.is_open
    days.set(e.day, d)
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** YYYY-MM-DD → DD.MM.YYYY (формат табеля, одинаковый в обоих языках) */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-')
  return `${d}.${m}.${y}`
}

/**
 * Время смены в поясе ТОЧКИ, а не браузера. Касса стоит в Израиле и
 * разницы не заметит, кабинет открывают откуда угодно — без явного пояса
 * распечатка сотрудника и экран владельца показали бы разные часы.
 */
export function formatTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso))
  } catch {
    // Пояс не знаком движку (старый ICU на терминале) — местное время
    // устройства: оно и есть время точки.
    const d = new Date(iso)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}`
  }
}

/** Секунды → «Ч:ММ» (8:30, не 8.5 — так читают табель) */
export function formatHm(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Секунды → десятичные часы для Excel («8,50» — запятая, ru-Excel) */
export function decimalHours(seconds: number): string {
  return (Math.max(0, seconds) / 3600).toFixed(2).replace('.', ',')
}

/** «07:00 - 15:00» или «07:00 - 11:00, 12:00 - 15:00»; открытая смена — «…» */
export function formatRanges(day: HoursDay, tz: string, openMark = '…'): string {
  return day.entries
    .map((e) => `${formatTime(e.clock_in, tz)} - ${e.clock_out ? formatTime(e.clock_out, tz) : openMark}`)
    .join(', ')
}

/**
 * Краткая строка табеля: «01.08.2026 א 07:00 - 15:00».
 * Именно этот формат отдают бухгалтеру — день, буква недели, интервал.
 */
export function formatDayLine(day: HoursDay, tz: string, dowLetters: readonly string[] = HEBREW_DOW): string {
  return `${formatDay(day.day)} ${dowLetters[day.dow] ?? ''} ${formatRanges(day, tz)}`.trim()
}

/** Итог по дням: сумма секунд и число отработанных дней */
export function sumDays(days: HoursDay[]): { seconds: number; days: number } {
  return { seconds: days.reduce((s, d) => s + d.seconds, 0), days: days.length }
}

// ── Кто ещё есть в штате ────────────────────────────────────

/** Строка штата: минимум, по которому решают, показывать ли человека */
export interface RosterMember {
  id: string
  name: string
  is_active: boolean
  location_id: string | null
}

/**
 * Сотрудники точки, которых НЕТ в отчёте за период — их дописывают в
 * список нулевой строкой.
 *
 * Отчёт отвечает «кто сколько отработал», поэтому человека в отпуске, в
 * выходной или забывшего отметиться в нём не существует. А открыть надо
 * именно его: посмотреть другой месяц или дописать пропущенную смену.
 *
 * Уволенные не добавляются — но если у них есть смены периода, они уже
 * пришли из отчёта и останутся: часы отработаны, из табеля их не
 * вычёркивают. Сотрудник без точки работает на всех, включая эту.
 */
export function idleStaff(
  worked: { staff_id: string }[],
  roster: RosterMember[],
  locationId: string | null = null,
): RosterMember[] {
  const seen = new Set(worked.map((w) => w.staff_id))
  return roster
    .filter((s) => s.is_active && !seen.has(s.id))
    .filter((s) => !locationId || !s.location_id || s.location_id === locationId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ── Выгрузка для Excel ──────────────────────────────────────

export interface HoursCsvLabels {
  employee: string
  date: string
  weekday: string
  clockIn: string
  clockOut: string
  hours: string
  decimal: string
  location: string
  note: string
  total: string
  days: string
  shifts: string
}

/**
 * CSV для Excel: BOM (иврит и кириллица не рассыпаются), разделитель «;»,
 * десятичные часы с запятой. Одна строка = одна смена; в конце — итоги по
 * сотрудникам, чтобы файл можно было отдать в зарплату как есть.
 */
export function buildHoursCsv(
  staff: StaffHours[],
  tz: string,
  labels: HoursCsvLabels,
  dowLetters: readonly string[] = RU_DOW,
): string {
  const esc = (v: string) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const row = (cells: string[]) => cells.map(esc).join(';')
  const lines: string[] = [
    row([
      labels.employee, labels.date, labels.weekday, labels.clockIn, labels.clockOut,
      labels.hours, labels.decimal, labels.location, labels.note,
    ]),
  ]

  for (const person of staff) {
    for (const day of groupByDay(person.entries)) {
      for (const e of day.entries) {
        lines.push(row([
          person.name,
          formatDay(day.day),
          dowLetters[day.dow] ?? '',
          formatTime(e.clock_in, tz),
          e.clock_out ? formatTime(e.clock_out, tz) : '',
          formatHm(e.seconds),
          decimalHours(e.seconds),
          e.location_name ?? '',
          e.note ?? '',
        ]))
      }
    }
  }

  lines.push('')
  lines.push(row([labels.employee, labels.days, labels.shifts, labels.hours, labels.decimal]))
  for (const person of staff) {
    lines.push(row([
      person.name,
      String(person.days),
      String(person.shifts),
      formatHm(person.seconds),
      decimalHours(person.seconds),
    ]))
  }
  const totalSeconds = staff.reduce((s, p) => s + p.seconds, 0)
  lines.push(row([labels.total, '', '', formatHm(totalSeconds), decimalHours(totalSeconds)]))

  return '\uFEFF' + lines.join('\r\n')
}

/** Скачать выгрузку файлом (создаёт и отзывает object URL) */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// ── Периоды ─────────────────────────────────────────────────

/** Первый и последний день месяца (локальные даты, без UTC-сдвига) */
export function monthRange(year: number, month: number): [Date, Date] {
  return [new Date(year, month, 1), new Date(year, month + 1, 0)]
}

/** Название месяца для заголовка и имени файла */
export function monthTitle(year: number, month: number, locale: string): string {
  return new Date(year, month, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' })
}
