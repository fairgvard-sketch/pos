import { describe, expect, it } from 'vitest'
import { buildIcs, icsEscape, icsFileName, icsFold, icsStamp } from './calendar'

const START = new Date('2026-08-01T17:00:00.000Z')
const NOW = new Date('2026-07-31T09:30:00.000Z')

describe('метка времени', () => {
  it('пишется в UTC — календарь гостя сам покажет её в своей зоне', () => {
    expect(icsStamp(START)).toBe('20260801T170000Z')
    expect(icsStamp(new Date('2026-01-05T03:07:09.000Z'))).toBe('20260105T030709Z')
  })
})

describe('экранирование', () => {
  it('спецсимволы RFC 5545 не ломают строку свойства', () => {
    expect(icsEscape('Кафе, стол; 5\\место')).toBe('Кафе\\, стол\\; 5\\\\место')
    expect(icsEscape('строка\nвторая')).toBe('строка\\nвторая')
  })
})

describe('складывание строк', () => {
  it('короткая строка не трогается', () => {
    expect(icsFold('SUMMARY:קפה')).toBe('SUMMARY:קפה')
  })

  it('длинная режется по 75 октетам, продолжение — с пробела', () => {
    const folded = icsFold(`SUMMARY:${'a'.repeat(200)}`)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0].length).toBe(75)
    for (const part of parts.slice(1)) expect(part.startsWith(' ')).toBe(true)
  })

  it('иврит режется по байтам и не рвёт символ', () => {
    // Каждая буква — 2 октета, поэтому наивный срез по символам дал бы
    // строки вдвое длиннее лимита.
    const folded = icsFold(`SUMMARY:${'ש'.repeat(120)}`)
    const encoder = new TextEncoder()
    for (const part of folded.split('\r\n')) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75)
      expect(part).not.toContain('�')
    }
    // Символы не потерялись
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'ש'.repeat(120)}`)
  })
})

describe('файл события', () => {
  const ics = buildIcs({
    uid: 'a1b2c3d4-0000-4000-8000-000000000001',
    start: START,
    durationMin: 90,
    summary: 'הזמנת מקום · לחמנייה',
    location: 'כתובת 1, תל אביב',
    description: '2 אורחים',
    now: NOW,
  })

  it('содержит один корректно обрамлённый VEVENT', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true)
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    expect(ics.match(/END:VEVENT/g)).toHaveLength(1)
  })

  it('конец визита считается от длительности', () => {
    expect(ics).toContain('DTSTART:20260801T170000Z')
    expect(ics).toContain('DTEND:20260801T183000Z')
  })

  it('длительность по умолчанию — 90 минут', () => {
    const def = buildIcs({ uid: 'x', start: START, summary: 's', now: NOW })
    expect(def).toContain('DTEND:20260801T183000Z')
  })

  it('UID стабилен — повторное добавление не плодит события', () => {
    expect(ics).toContain('UID:a1b2c3d4-0000-4000-8000-000000000001@angle.co.il')
  })

  it('строки разделены CRLF, как требует формат', () => {
    expect(ics.includes('\r\n')).toBe(true)
    expect(/[^\r]\n/.test(ics)).toBe(false)
  })

  it('пустые адрес и описание не создают пустых свойств', () => {
    const bare = buildIcs({ uid: 'x', start: START, summary: 's', location: null, now: NOW })
    expect(bare).not.toContain('LOCATION:')
    expect(bare).not.toContain('DESCRIPTION:')
  })
})

describe('имя файла', () => {
  it('латиница и цифры — не зависит от кодировки заголовка', () => {
    expect(icsFileName('a1b2c3d4-0000-4000-8000-000000000001')).toBe('reservation-a1b2c3d4.ics')
  })
})
