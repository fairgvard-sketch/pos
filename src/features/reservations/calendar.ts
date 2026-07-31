/**
 * Файл календаря для брони (118): «добавить в календарь» без обращения к
 * серверу и без сторонних сервисов.
 *
 * Событие пишется в UTC (`...Z`), поэтому VTIMEZONE не нужен: у брони есть
 * абсолютный момент, а не «локальное время неизвестно чьей зоны». Это же
 * снимает целый класс ошибок с переводом часов — календарь гостя покажет
 * визит в СВОЕЙ зоне, но в правильный момент.
 *
 * RFC 5545: строки складываются по 75 октетов, спецсимволы экранируются.
 */

export interface IcsEvent {
  /** Стабильный идентификатор события — токен брони */
  uid: string
  start: Date
  /** Длительность визита, мин (по умолчанию 90) */
  durationMin?: number
  summary: string
  location?: string | null
  description?: string | null
  /** «Сейчас» — параметром ради воспроизводимых тестов */
  now?: Date
}

/** UTC-метка формата RFC 5545: 20260801T170000Z */
export function icsStamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

/** Экранирование значения свойства: обратный слэш, точка с запятой, запятая, перенос */
export function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * Складывание длинной строки. Резать надо по ОКТЕТАМ, а не по символам:
 * иврит в UTF-8 занимает по два байта, и наивный срез по 75 символам даёт
 * строки длиннее лимита, а срез посреди символа — битую кодировку.
 */
export function icsFold(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line

  const out: string[] = []
  let current = ''
  let currentBytes = 0
  // Первая строка — 75 октетов, продолжения начинаются с пробела, поэтому
  // полезной нагрузки в них 74.
  let limit = 75

  for (const char of line) {
    const size = encoder.encode(char).length
    if (currentBytes + size > limit) {
      out.push(current)
      current = ''
      currentBytes = 0
      limit = 74
    }
    current += char
    currentBytes += size
  }
  if (current) out.push(current)
  return out.join('\r\n ')
}

/** Текст .ics одного события визита */
export function buildIcs(event: IcsEvent): string {
  const start = event.start
  const end = new Date(start.getTime() + (event.durationMin ?? 90) * 60_000)
  const stamp = icsStamp(event.now ?? new Date())

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ANGLE//Reserve//HE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsEscape(event.uid)}@angle.co.il`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(event.summary)}`,
  ]
  if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`)
  if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`)
  lines.push('END:VEVENT', 'END:VCALENDAR')

  return lines.map(icsFold).join('\r\n') + '\r\n'
}

/** Имя файла: латиница и цифры, чтобы не зависеть от кодировки заголовка */
export function icsFileName(uid: string): string {
  return `reservation-${uid.slice(0, 8)}.ics`
}

/**
 * Скачивание файла. Отдельная функция, потому что путь через Blob URL
 * должен быть один: iOS Safari открывает .ics во встроенном просмотрщике
 * только при осмысленном MIME.
 */
export function downloadIcs(event: IcsEvent): void {
  const blob = new Blob([buildIcs(event)], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = icsFileName(event.uid)
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Освобождаем не сразу: Safari успевает открыть файл асинхронно.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
