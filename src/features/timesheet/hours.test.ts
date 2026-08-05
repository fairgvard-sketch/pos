import { describe, it, expect } from 'vitest'
import {
  groupByDay, formatDay, formatTime, formatHm, decimalHours,
  formatRanges, formatDayLine, sumDays, buildHoursCsv, monthRange, idleStaff,
  dayBounds, dayBreakSeconds, HEBREW_DOW, RU_DOW,
} from './hours'
import type { StaffHours, StaffHoursEntry } from './api'

const TZ = 'Asia/Jerusalem'

function entry(over: Partial<StaffHoursEntry> = {}): StaffHoursEntry {
  return {
    id: 'e1',
    day: '2026-08-01',
    dow: 6, // 01.08.2026 — суббота
    clock_in: '2026-08-01T04:00:00Z', // 07:00 в Израиле (UTC+3 летом)
    clock_out: '2026-08-01T12:00:00Z', // 15:00
    seconds: 8 * 3600,
    is_open: false,
    note: null,
    edited_at: null,
    edited_by_name: null,
    location_id: 'loc',
    location_name: 'Главная',
    ...over,
  }
}

describe('группировка по дням', () => {
  it('складывает смены одного дня и считает секунды', () => {
    const days = groupByDay([
      entry({ id: 'a', seconds: 4 * 3600 }),
      entry({ id: 'b', clock_in: '2026-08-01T13:00:00Z', clock_out: '2026-08-01T15:00:00Z', seconds: 2 * 3600 }),
    ])
    expect(days).toHaveLength(1)
    expect(days[0].entries).toHaveLength(2)
    expect(days[0].seconds).toBe(6 * 3600)
  })

  it('сортирует дни по возрастанию независимо от порядка ответа', () => {
    const days = groupByDay([
      entry({ id: 'b', day: '2026-08-03', dow: 1 }),
      entry({ id: 'a', day: '2026-08-02', dow: 0 }),
    ])
    expect(days.map((d) => d.day)).toEqual(['2026-08-02', '2026-08-03'])
  })

  it('помечает день с незакрытой сменой', () => {
    const days = groupByDay([entry({ clock_out: null, is_open: true })])
    expect(days[0].hasOpen).toBe(true)
  })
})

describe('форматы', () => {
  it('дата табеля — DD.MM.YYYY', () => {
    expect(formatDay('2026-08-01')).toBe('01.08.2026')
  })

  it('время берётся в поясе точки, а не браузера', () => {
    // 04:00 UTC = 07:00 в Иерусалиме летом и 05:00 в Лондоне
    expect(formatTime('2026-08-01T04:00:00Z', TZ)).toBe('07:00')
    expect(formatTime('2026-08-01T04:00:00Z', 'Europe/London')).toBe('05:00')
  })

  it('часы показываются как Ч:ММ, а не десятичной дробью', () => {
    expect(formatHm(8 * 3600)).toBe('8:00')
    expect(formatHm(8 * 3600 + 30 * 60)).toBe('8:30')
    expect(formatHm(0)).toBe('0:00')
    expect(formatHm(-5)).toBe('0:00')
  })

  it('десятичные часы — с запятой для Excel', () => {
    expect(decimalHours(8 * 3600 + 30 * 60)).toBe('8,50')
  })

  it('несколько смен в дне склеиваются через запятую', () => {
    const [day] = groupByDay([
      entry({ id: 'a' }),
      entry({ id: 'b', clock_in: '2026-08-01T13:00:00Z', clock_out: '2026-08-01T15:00:00Z' }),
    ])
    expect(formatRanges(day, TZ)).toBe('07:00 - 15:00, 16:00 - 18:00')
  })

  it('незакрытая смена печатается многоточием, а не пустотой', () => {
    const [day] = groupByDay([entry({ clock_out: null, is_open: true })])
    expect(formatRanges(day, TZ)).toBe('07:00 - …')
  })

  it('краткая строка — дата, буква недели, интервал', () => {
    const [day] = groupByDay([entry({ day: '2026-08-02', dow: 0 })])
    expect(formatDayLine(day, TZ)).toBe('02.08.2026 א 07:00 - 15:00')
    expect(formatDayLine(day, TZ, RU_DOW)).toBe('02.08.2026 вс 07:00 - 15:00')
  })

  it('буквы недели начинаются с воскресенья', () => {
    expect(HEBREW_DOW[0]).toBe('א')
    expect(HEBREW_DOW[6]).toBe('ש')
  })
})

describe('границы дня и перерыв', () => {
  it('день из одной смены: приход и уход её же, перерыва нет', () => {
    const [day] = groupByDay([entry()])
    expect(dayBounds(day)).toEqual({ in: '2026-08-01T04:00:00Z', out: '2026-08-01T12:00:00Z' })
    expect(dayBreakSeconds(day)).toBe(0)
  })

  it('разрыв между сменами дня и есть перерыв', () => {
    // 07:00–11:00 и 12:00–15:00: на работе 8 часов, отработано 7, перерыв час
    const [day] = groupByDay([
      entry({ id: 'a', clock_in: '2026-08-01T04:00:00Z', clock_out: '2026-08-01T08:00:00Z', seconds: 4 * 3600 }),
      entry({ id: 'b', clock_in: '2026-08-01T09:00:00Z', clock_out: '2026-08-01T12:00:00Z', seconds: 3 * 3600 }),
    ])
    expect(dayBounds(day)).toEqual({ in: '2026-08-01T04:00:00Z', out: '2026-08-01T12:00:00Z' })
    expect(dayBreakSeconds(day)).toBe(3600)
    expect(day.seconds).toBe(7 * 3600)
  })

  it('границы берутся по времени, а не по порядку в ответе', () => {
    const [day] = groupByDay([
      entry({ id: 'b', clock_in: '2026-08-01T09:00:00Z', clock_out: '2026-08-01T12:00:00Z', seconds: 3 * 3600 }),
      entry({ id: 'a', clock_in: '2026-08-01T04:00:00Z', clock_out: '2026-08-01T08:00:00Z', seconds: 4 * 3600 }),
    ])
    expect(dayBounds(day).in).toBe('2026-08-01T04:00:00Z')
    expect(dayBreakSeconds(day)).toBe(3600)
  })

  it('незакрытый день перерыва не показывает — он ещё не кончился', () => {
    const [day] = groupByDay([entry({ clock_out: null, is_open: true })])
    expect(dayBounds(day).out).toBeNull()
    expect(dayBreakSeconds(day)).toBe(0)
  })
})

describe('итоги', () => {
  it('суммирует дни и секунды', () => {
    const days = groupByDay([
      entry({ id: 'a', day: '2026-08-01', seconds: 8 * 3600 }),
      entry({ id: 'b', day: '2026-08-02', dow: 0, seconds: 7 * 3600 }),
    ])
    expect(sumDays(days)).toEqual({ seconds: 15 * 3600, days: 2 })
  })
})

describe('выгрузка для Excel', () => {
  const labels = {
    employee: 'Сотрудник', date: 'Дата', weekday: 'День', clockIn: 'Приход',
    clockOut: 'Уход', breakTime: 'Перерыв', hours: 'Часы', decimal: 'Часы (дес.)',
    ranges: 'Смены', location: 'Точка', note: 'Комментарий',
    total: 'Итого', days: 'Дней', shifts: 'Смен',
  }
  const person: StaffHours = {
    staff_id: 's1', name: 'Аня', role: 'barista', is_active: true,
    seconds: 8 * 3600, days: 1, shifts: 1, has_open: false,
    entries: [entry()],
  }

  it('начинается с BOM — иначе Excel рассыпает иврит и кириллицу', () => {
    expect(buildHoursCsv([person], TZ, labels).startsWith('﻿')).toBe(true)
  })

  it('строка дня: приход, уход, перерыв и часы в двух видах', () => {
    const csv = buildHoursCsv([person], TZ, labels)
    expect(csv).toContain('Аня;01.08.2026;сб;07:00;15:00;0:00;8:00;8,00;;Главная;')
  })

  it('день с перерывом остаётся ОДНОЙ строкой — как на экране и на бумаге', () => {
    const split: StaffHours = {
      ...person,
      seconds: 7 * 3600,
      shifts: 2,
      entries: [
        entry({ id: 'a', clock_in: '2026-08-01T04:00:00Z', clock_out: '2026-08-01T08:00:00Z', seconds: 4 * 3600 }),
        entry({ id: 'b', clock_in: '2026-08-01T09:00:00Z', clock_out: '2026-08-01T12:00:00Z', seconds: 3 * 3600 }),
      ],
    }
    const rows = buildHoursCsv([split], TZ, labels).split('\r\n')
    // Шапка + одна строка дня до пустой строки перед блоком итогов
    expect(rows[1]).toContain('07:00;15:00;1:00;7:00;7,00')
    // Интервалы целиком — иначе не понять, откуда взялся час перерыва
    expect(rows[1]).toContain('07:00 - 11:00, 12:00 - 15:00')
    expect(rows[2]).toBe('')
  })

  it('экранирует точку с запятой в заметке', () => {
    const csv = buildHoursCsv(
      [{ ...person, entries: [entry({ note: 'забыл; отметиться' })] }],
      TZ, labels,
    )
    expect(csv).toContain('"забыл; отметиться"')
  })

  it('в итогах — строка сотрудника и общий итог', () => {
    const csv = buildHoursCsv([person], TZ, labels)
    expect(csv).toContain('Аня;1;1;8:00;8,00')
    expect(csv).toContain('Итого;;;8:00;8,00')
  })
})

describe('штат без смен', () => {
  const roster = [
    { id: 's1', name: 'Аня', is_active: true, location_id: null },
    { id: 's2', name: 'Борис', is_active: true, location_id: 'loc-1' },
    { id: 's3', name: 'Вика', is_active: true, location_id: 'loc-2' },
    { id: 's4', name: 'Гриша', is_active: false, location_id: 'loc-1' },
  ]

  it('добавляет тех, кого нет в отчёте — иначе их не открыть', () => {
    expect(idleStaff([], roster, 'loc-1').map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('отработавшего второй раз не добавляет', () => {
    expect(idleStaff([{ staff_id: 's2' }], roster, 'loc-1').map((s) => s.id)).toEqual(['s1'])
  })

  it('уволенного в список не поднимает', () => {
    expect(idleStaff([], roster, 'loc-1').some((s) => s.id === 's4')).toBe(false)
  })

  it('сотрудник чужой точки на этом терминале не показывается', () => {
    expect(idleStaff([], roster, 'loc-1').some((s) => s.id === 's3')).toBe(false)
  })

  it('сотрудник без точки работает на всех', () => {
    expect(idleStaff([], roster, 'loc-2').map((s) => s.id)).toEqual(['s1', 's3'])
  })

  it('без выбранной точки видно весь активный штат', () => {
    expect(idleStaff([], roster, null).map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('порядок — по имени, а не по дате приёма', () => {
    const shuffled = [roster[2], roster[0], roster[1]]
    expect(idleStaff([], shuffled, null).map((s) => s.name)).toEqual(['Аня', 'Борис', 'Вика'])
  })
})

describe('период месяца', () => {
  it('первый и последний календарный день, без сдвига в UTC', () => {
    const [from, to] = monthRange(2026, 7) // август
    expect(from.getDate()).toBe(1)
    expect(from.getMonth()).toBe(7)
    expect(to.getDate()).toBe(31)
    expect(to.getMonth()).toBe(7)
  })

  it('февраль високосного года заканчивается 29-м', () => {
    const [, to] = monthRange(2028, 1)
    expect(to.getDate()).toBe(29)
  })
})
