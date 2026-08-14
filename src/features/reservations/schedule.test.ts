import { describe, expect, it } from 'vitest'
import {
  dayWindows, formatWindows, hmToMin, isOpenAt, localTimeExists, minToHm,
  normalizeSchedule, slotGrid, weeklyHoursRows, zonedToUtc,
} from './schedule'

/**
 * Сетка слотов брони: клиентская половина того же движка, что и SQL 117.
 * До 117 у страницы не было ни одного теста, а считала она по одной паре
 * open/close в часовом поясе устройства — отсюда и субботние слоты у
 * закрытого по субботам заведения.
 *
 * Даты фиксированные: сетка чистая функция, «сейчас» приходит параметром.
 */

const TZ = 'Asia/Jerusalem'
// 2027-03-14 — воскресенье, 2027-03-13 — суббота, 2027-03-12 — пятница.
const NOW = Date.UTC(2027, 2, 10, 9, 0)

const BULOCHKA = {
  schedule: {
    weekly: {
      '0': [['08:00', '20:00']], '1': [['08:00', '20:00']], '2': [['08:00', '20:00']],
      '3': [['08:00', '20:00']], '4': [['08:00', '20:00']],
      '5': [['08:00', '15:00']], '6': [],
    },
    exceptions: {},
    lead_min: 30,
    horizon_days: 30,
  },
}

function grid(dateStr: string, source: unknown = BULOCHKA, stepMin = 15, nowMs = NOW) {
  return slotGrid({
    schedule: normalizeSchedule(source as never),
    dateStr, tz: TZ, stepMin, nowMs,
  })
}

describe('разбор времени', () => {
  it('читает HH:MM и отвергает мусор', () => {
    expect(hmToMin('08:00')).toBe(480)
    expect(hmToMin('8:05')).toBe(485)
    expect(hmToMin('24:00')).toBeNull()
    expect(hmToMin('08:60')).toBeNull()
    expect(hmToMin('')).toBeNull()
    expect(hmToMin(null)).toBeNull()
  })

  it('минуты за сутками сворачиваются по модулю (ночная смена)', () => {
    expect(minToHm(1500)).toBe('01:00')
    expect(minToHm(0)).toBe('00:00')
  })
})

describe('нормализация расписания', () => {
  it('legacy open/close разворачивается в семь одинаковых дней', () => {
    const s = normalizeSchedule({ open: '08:00', close: '20:00' })
    expect(s.weekly['6']).toEqual([['08:00', '20:00']])
    expect(s.weekly['0']).toEqual([['08:00', '20:00']])
    expect(s.leadMin).toBe(30)
    expect(s.horizonDays).toBe(30)
  })

  it('без настроек — прежние дефолты 07:00–23:45', () => {
    expect(normalizeSchedule(null).weekly['3']).toEqual([['07:00', '23:45']])
  })

  it('битые окна не роняют разбор, а считаются закрытым днём', () => {
    const s = normalizeSchedule({
      schedule: { weekly: { '0': [['ерунда', '20:00']], '1': [['08:00', '20:00']] } },
    } as never)
    expect(s.weekly['0']).toEqual([])
    expect(s.weekly['1']).toEqual([['08:00', '20:00']])
  })

  it('битые числа lead/horizon дают дефолт', () => {
    const s = normalizeSchedule({
      schedule: { weekly: {}, lead_min: 'мусор', horizon_days: 9999 },
    } as never)
    expect(s.leadMin).toBe(30)
    expect(s.horizonDays).toBe(365)
  })
})

describe('закрытый день (продовый случай «Булочки»)', () => {
  it('суббота не даёт ни одного слота', () => {
    expect(grid('2027-03-13')).toHaveLength(0)
  })

  it('воскресенье 08:00–20:00 — 49 слотов', () => {
    expect(grid('2027-03-14')).toHaveLength(49)
  })

  it('пятница обрывается в 15:00, а не в 20:00', () => {
    const slots = grid('2027-03-12')
    expect(slots).toHaveLength(29)
    expect(slots[slots.length - 1].time).toBe('15:00')
  })

  it('legacy-точка без schedule ведёт себя как раньше — суббота открыта', () => {
    expect(grid('2027-03-13', { open: '08:00', close: '20:00' })).toHaveLength(49)
  })
})

describe('разрыв смен', () => {
  const split = {
    schedule: {
      weekly: { '0': [['12:00', '15:00'], ['18:00', '22:00']] },
      exceptions: {}, lead_min: 30, horizon_days: 30,
    },
  }

  it('обед и ужин дают две группы слотов без промежутка', () => {
    const times = grid('2027-03-14', split).map((s) => s.time)
    expect(times).toHaveLength(30)
    expect(times).toContain('12:00')
    expect(times).toContain('15:00')
    expect(times).toContain('18:00')
    expect(times).toContain('22:00')
    expect(times).not.toContain('16:00')
    expect(times).not.toContain('17:45')
  })
})

describe('исключения по дате', () => {
  const withExceptions = {
    schedule: {
      weekly: BULOCHKA.schedule.weekly,
      exceptions: { '2027-03-14': [], '2027-03-15': [['18:00', '23:00']] },
      lead_min: 30, horizon_days: 30,
    },
  }

  it('закрытие по дате перекрывает открытый день недели', () => {
    expect(grid('2027-03-14', withExceptions)).toHaveLength(0)
  })

  it('особые часы замещают недельное окно, а не дополняют его', () => {
    const times = grid('2027-03-15', withExceptions).map((s) => s.time)
    expect(times).toHaveLength(21)
    expect(times[0]).toBe('18:00')
    expect(times).not.toContain('09:00')
  })

  it('дата без исключения живёт по неделе', () => {
    expect(grid('2027-03-16', withExceptions)).toHaveLength(49)
  })

  it('dayWindows отдаёт окна исключения напрямую', () => {
    const s = normalizeSchedule(withExceptions as never)
    expect(dayWindows(s, '2027-03-14')).toEqual([])
    expect(dayWindows(s, '2027-03-15')).toEqual([['18:00', '23:00']])
  })
})

describe('окно через полночь', () => {
  const night = {
    schedule: {
      weekly: { '0': [['20:00', '02:00']] },
      exceptions: {}, lead_min: 30, horizon_days: 30,
    },
  }

  it('ночная смена продолжается за полночь', () => {
    const slots = grid('2027-03-14', night)
    expect(slots).toHaveLength(25)
    expect(slots[0].time).toBe('20:00')
    expect(slots[slots.length - 1].time).toBe('02:00')
  })

  it('заполночный слот несёт момент СЛЕДУЮЩИХ суток', () => {
    const slot = grid('2027-03-14', night).find((s) => s.time === '01:00')!
    // 01:00 15 марта по Иерусалиму = 23:00 UTC 14 марта (зимнее время, +2)
    expect(slot.at.toISOString()).toBe('2027-03-14T23:00:00.000Z')
  })
})

describe('часовой пояс точки, а не устройства', () => {
  it('локальное время точки переводится в абсолютный момент', () => {
    // Зима: Иерусалим +02:00
    expect(zonedToUtc('2027-03-14', 10 * 60, TZ).toISOString())
      .toBe('2027-03-14T08:00:00.000Z')
    // Лето: Иерусалим +03:00
    expect(zonedToUtc('2027-07-14', 10 * 60, TZ).toISOString())
      .toBe('2027-07-14T07:00:00.000Z')
  })

  it('результат не зависит от зоны устройства (сравнение с явным UTC)', () => {
    const at = zonedToUtc('2027-03-14', 12 * 60, TZ)
    expect(at.getTime()).toBe(Date.UTC(2027, 2, 14, 10, 0))
  })
})

describe('переход на летнее время, Asia/Jerusalem', () => {
  // 2027-03-26, 02:00 → 03:00: локальных 02:00–02:45 не существует.
  it('несуществующее локальное время распознаётся', () => {
    expect(localTimeExists('2027-03-26', 1 * 60 + 45, TZ)).toBe(true)
    expect(localTimeExists('2027-03-26', 2 * 60, TZ)).toBe(false)
    expect(localTimeExists('2027-03-26', 2 * 60 + 45, TZ)).toBe(false)
    expect(localTimeExists('2027-03-26', 3 * 60, TZ)).toBe(true)
  })

  it('фантомные слоты выброшены, и два слота не указывают на один момент', () => {
    const dst = {
      schedule: {
        weekly: { '5': [['00:00', '06:00']] },
        exceptions: {}, lead_min: 30, horizon_days: 30,
      },
    }
    const slots = grid('2027-03-26', dst, 15, Date.UTC(2027, 2, 20, 9, 0))
    expect(slots).toHaveLength(21) // 25 минус четыре несуществующих
    expect(slots.map((s) => s.time)).not.toContain('02:00')
    expect(new Set(slots.map((s) => s.at.getTime())).size).toBe(slots.length)
  })
})

describe('lead time и горизонт записи', () => {
  it('слоты ближе lead_min не предлагаются', () => {
    // «Сейчас» — 09:40 по Иерусалиму того же дня, lead 30 мин
    const now = Date.UTC(2027, 2, 14, 7, 40)
    const times = grid('2027-03-14', BULOCHKA, 15, now).map((s) => s.time)
    expect(times).not.toContain('10:00')
    expect(times[0]).toBe('10:15')
  })

  it('дальше горизонта записи слотов нет', () => {
    const times = grid('2027-04-20', BULOCHKA, 15, NOW)
    expect(times).toHaveLength(0)
  })
})

describe('показ часов работы', () => {
  it('подряд идущие одинаковые дни схлопываются в одну строку', () => {
    const rows = weeklyHoursRows(normalizeSchedule(BULOCHKA as never))
    expect(rows).toHaveLength(3)
    expect(rows[0].days).toEqual([0, 1, 2, 3, 4])
    expect(rows[0].windows).toEqual([['08:00', '20:00']])
    expect(rows[1].days).toEqual([5])
    expect(rows[2].days).toEqual([6])
    expect(rows[2].windows).toEqual([]) // суббота закрыта
  })

  it('показанные часы и сетка слотов происходят из одной структуры', () => {
    const s = normalizeSchedule(BULOCHKA as never)
    const saturdayRow = weeklyHoursRows(s).find((r) => r.days.includes(6))!
    expect(saturdayRow.windows).toEqual([])
    // Ровно то, чего не было до 117: «закрыто» на витрине = 0 слотов в сетке
    expect(grid('2027-03-13')).toHaveLength(0)
  })
})

/**
 * «Открыто сейчас» в полосе часов на первом экране. Точка обязана
 * совпадать с тем, что реально можно забронировать: показать зелёное
 * «открыто» и тут же не дать ни одного слота — та же рассинхронизация,
 * ради которой в 117 свободный текст часов заменили расписанием.
 */
describe('isOpenAt — состояние «открыто сейчас»', () => {
  const s = normalizeSchedule(BULOCHKA as never)

  it('внутри окна дня — открыто, до и после — закрыто', () => {
    expect(isOpenAt(s, '2027-03-14', 8 * 60)).toBe(true) // ровно 08:00, граница включительна
    expect(isOpenAt(s, '2027-03-14', 12 * 60)).toBe(true)
    expect(isOpenAt(s, '2027-03-14', 20 * 60)).toBe(true) // ровно 20:00
    expect(isOpenAt(s, '2027-03-14', 7 * 60 + 59)).toBe(false)
    expect(isOpenAt(s, '2027-03-14', 20 * 60 + 1)).toBe(false)
  })

  it('в закрытый день закрыто в любое время', () => {
    expect(isOpenAt(s, '2027-03-13', 12 * 60)).toBe(false) // суббота
  })

  it('короткий день пятницы заканчивается в 15:00', () => {
    expect(isOpenAt(s, '2027-03-12', 14 * 60)).toBe(true)
    expect(isOpenAt(s, '2027-03-12', 16 * 60)).toBe(false)
  })

  it('ночная смена: в час ночи открыто по ВЧЕРАШНЕМУ окну', () => {
    // Бар до 02:00: окно принадлежит дате начала и продолжается за 24:00 —
    // ровно как в сетке слотов. Без учёта вчерашнего окна страница писала
    // бы «закрыто» гостю, который стоит в открытом зале.
    const night = normalizeSchedule({
      schedule: {
        weekly: {
          '0': [['18:00', '02:00']], '1': [['18:00', '02:00']], '2': [['18:00', '02:00']],
          '3': [['18:00', '02:00']], '4': [['18:00', '02:00']],
          '5': [['18:00', '02:00']], '6': [['18:00', '02:00']],
        },
        exceptions: {},
      },
    } as never)
    expect(isOpenAt(night, '2027-03-14', 1 * 60)).toBe(true) // 01:00 — вчерашнее окно
    expect(isOpenAt(night, '2027-03-14', 19 * 60)).toBe(true) // 19:00 — сегодняшнее
    expect(isOpenAt(night, '2027-03-14', 15 * 60)).toBe(false) // день — закрыто
  })

  it('исключение по дате замещает недельное правило', () => {
    const holiday = normalizeSchedule({
      schedule: {
        weekly: { '0': [['08:00', '20:00']] },
        exceptions: { '2027-03-14': [] },
      },
    } as never)
    expect(isOpenAt(holiday, '2027-03-14', 12 * 60)).toBe(false)
  })
})

describe('formatWindows', () => {
  it('склеивает окна дня, пустой день даёт пустую строку', () => {
    expect(formatWindows([['08:00', '20:00']])).toBe('08:00–20:00')
    expect(formatWindows([['08:00', '12:00'], ['18:00', '23:00']]))
      .toBe('08:00–12:00, 18:00–23:00')
    expect(formatWindows([])).toBe('')
  })
})
