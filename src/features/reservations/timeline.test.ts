import { describe, expect, it } from 'vitest'
import { normalizeSchedule } from './schedule'
import {
  blockState, bookingsForDay, buildRows, dayBounds, groupByZone, hourTicks,
  nowMarkerPct, occupancySummary, positionOf, timelineWindow,
  type TimelineBooking, type TimelineTable,
} from './timeline'

/**
 * Раскладка таймлайна. Проверяется геометрия и правила, а не разметка:
 * если блок налезает на соседний или конфликт не подсвечен, это должно
 * падать здесь, а не обнаруживаться хостес в час пик.
 */

const TZ = 'Asia/Jerusalem'
const DATE = '2027-03-14' // воскресенье, зимнее время (+02:00)
const at = (h: number, m = 0) => Date.UTC(2027, 2, 14, h - 2, m) // локальное → UTC

const SCHEDULE = normalizeSchedule({
  schedule: {
    weekly: { '0': [['08:00', '20:00']] },
    exceptions: {}, lead_min: 30, horizon_days: 30,
  },
} as never)

function table(id: string, label: string, over: Partial<TimelineTable> = {}): TimelineTable {
  return {
    id, label, seats: 4, zoneId: 'z1', zoneName: 'Зал',
    sortOrder: Number(label), blocked: false, ...over,
  }
}

function booking(
  id: string, tableIds: string[], fromH: number, toH: number,
  over: Partial<TimelineBooking> = {},
): TimelineBooking {
  return {
    id, tableIds, startMs: at(fromH), endMs: at(toH),
    state: 'confirmed', guestName: 'Гость', partySize: 2,
    posSeated: false, zoneName: 'Зал', note: null, ...over,
  }
}

describe('окно дня', () => {
  it('строится от расписания точки, а не от суток', () => {
    const win = timelineWindow(DATE, TZ, SCHEDULE)
    // 08:00 − 30 мин запаса = 07:30; 20:00 + 90 мин = 21:30
    expect(win.startMs).toBe(at(7, 30))
    expect(win.endMs).toBe(at(21, 30))
  })

  it('расширяется под бронь вне расписания — ручная бронь не исчезает', () => {
    const win = timelineWindow(DATE, TZ, SCHEDULE, [booking('b1', ['t1'], 5, 6)])
    expect(win.startMs).toBe(at(5))
    expect(win.endMs).toBe(at(21, 30))
  })

  it('закрытый день не даёт вырожденного окна', () => {
    const closed = normalizeSchedule({
      schedule: { weekly: { '0': [] }, exceptions: {}, lead_min: 30, horizon_days: 30 },
    } as never)
    const win = timelineWindow(DATE, TZ, closed)
    expect(win.endMs).toBeGreaterThan(win.startMs)
  })
})

describe('сутки не смешиваются', () => {
  // Брони приходят с запасом в сутки назад — окно обязано их отфильтровать
  const prevAt = (h: number, m = 0) => Date.UTC(2027, 2, 13, h - 2, m)
  const nextAt = (h: number, m = 0) => Date.UTC(2027, 2, 15, h - 2, m)
  const overnight = normalizeSchedule({
    schedule: {
      weekly: { '0': [['18:00', '02:00']] },
      exceptions: {}, lead_min: 30, horizon_days: 30,
    },
  } as never)

  it('границы дня — от полуночи до полуночи в зоне точки', () => {
    const bounds = dayBounds(DATE, TZ, SCHEDULE)
    expect(bounds.startMs).toBe(at(0))
    expect(bounds.endMs).toBe(nextAt(0))
  })

  it('ночная смена продлевает границы дня за полночь', () => {
    const bounds = dayBounds(DATE, TZ, overnight)
    expect(bounds.endMs).toBe(nextAt(3, 30)) // 02:00 + 90 минут запаса
  })

  it('вчерашняя бронь не растягивает полотно на чужие сутки', () => {
    const leaked = { ...booking('leaked', ['t1'], 0, 0), startMs: prevAt(14), endMs: prevAt(15, 30) }
    const win = timelineWindow(DATE, TZ, SCHEDULE, [leaked])
    expect(win.startMs).toBe(at(7, 30))
    expect(win.endMs).toBe(at(21, 30))
  })

  it('вчерашняя бронь не попадает в строки таймлайна', () => {
    const leaked = { ...booking('leaked', ['t1'], 0, 0), startMs: prevAt(14), endMs: prevAt(15, 30) }
    const mine = booking('mine', ['t1'], 12, 13)
    const win = timelineWindow(DATE, TZ, SCHEDULE, [leaked, mine])
    const rows = buildRows([table('t1', '1')], [leaked, mine], win)
    expect(rows[0].blocks.map((b) => b.booking.id)).toEqual(['mine'])
  })

  it('визит через полночь остаётся видимым и помечается обрезанным', () => {
    const night = { ...booking('night', ['t1'], 0, 0), startMs: prevAt(23), endMs: at(2) }
    const win = timelineWindow(DATE, TZ, SCHEDULE, [night])
    expect(win.startMs).toBe(at(0))
    const rows = buildRows([table('t1', '1')], [night], win)
    expect(rows[0].blocks[0].clipsStart).toBe(true)
    expect(rows[0].blocks[0].leftPct).toBe(0)
  })

  it('ночная смена показывает свой визит после полуночи целиком', () => {
    const night = { ...booking('night', ['t1'], 0, 0), startMs: at(23), endMs: nextAt(1) }
    const win = timelineWindow(DATE, TZ, overnight, [night])
    const rows = buildRows([table('t1', '1')], [night], win)
    expect(rows[0].blocks[0].clipsEnd).toBe(false)
  })

  it('длинный визит не выносит правую границу за сутки', () => {
    const long = { ...booking('long', ['t1'], 0, 0), startMs: at(20), endMs: nextAt(4) }
    const win = timelineWindow(DATE, TZ, SCHEDULE, [long])
    expect(win.endMs).toBe(nextAt(0))
    const rows = buildRows([table('t1', '1')], [long], win)
    expect(rows[0].blocks[0].clipsEnd).toBe(true)
  })

  it('bookingsForDay отбирает по пересечению, а не по дате начала', () => {
    const bounds = dayBounds(DATE, TZ, SCHEDULE)
    const kept = bookingsForDay([
      { ...booking('yesterday', ['t1'], 0, 0), startMs: prevAt(14), endMs: prevAt(15, 30) },
      { ...booking('crossing', ['t1'], 0, 0), startMs: prevAt(23), endMs: at(1) },
      booking('today', ['t1'], 12, 13),
    ], bounds)
    expect(kept.map((b) => b.id)).toEqual(['crossing', 'today'])
  })

  it('день перевода часов: границы 23 часа, ключи отметок уникальны', () => {
    // Израиль: 26 марта 2027, 02:00 → 03:00
    const dst = '2027-03-26'
    const bounds = dayBounds(dst, TZ, null)
    expect((bounds.endMs - bounds.startMs) / 3_600_000).toBe(23)
    const ticks = hourTicks(bounds, TZ)
    expect(new Set(ticks.map((t) => t.ts)).size).toBe(ticks.length)
  })

  it('день возврата на зимнее время: подписи повторяются, ключи — нет', () => {
    // Израиль: 31 октября 2027, 02:00 → 01:00
    const dst = '2027-10-31'
    const bounds = dayBounds(dst, TZ, null)
    expect((bounds.endMs - bounds.startMs) / 3_600_000).toBe(25)
    const ticks = hourTicks(bounds, TZ)
    expect(new Set(ticks.map((t) => t.label)).size).toBeLessThan(ticks.length)
    expect(new Set(ticks.map((t) => t.ts)).size).toBe(ticks.length)
  })
})

describe('позиционирование', () => {
  const win = { startMs: at(8), endMs: at(20) } // 12 часов

  it('час занимает свою долю ширины', () => {
    const p = positionOf(at(9), at(10), win)
    expect(p.leftPct).toBeCloseTo(100 / 12, 5)
    expect(p.widthPct).toBeCloseTo(100 / 12, 5)
    expect(p.clipsStart).toBe(false)
    expect(p.clipsEnd).toBe(false)
  })

  it('визит, начавшийся до окна, обрезается и помечается', () => {
    const p = positionOf(at(6), at(9), win)
    expect(p.leftPct).toBe(0)
    expect(p.widthPct).toBeCloseTo(100 / 12, 5)
    expect(p.clipsStart).toBe(true)
  })

  it('визит, уходящий за окно, обрезается справа', () => {
    const p = positionOf(at(19), at(23), win)
    expect(p.leftPct + p.widthPct).toBeCloseTo(100, 5)
    expect(p.clipsEnd).toBe(true)
  })

  it('метка «сейчас» вне окна не рисуется', () => {
    expect(nowMarkerPct(at(12), win)).toBeCloseTo((4 / 12) * 100, 5)
    expect(nowMarkerPct(at(7), win)).toBeNull()
    expect(nowMarkerPct(at(21), win)).toBeNull()
  })

  it('часовые отметки идут по круглым часам внутри окна', () => {
    const ticks = hourTicks({ startMs: at(8, 30), endMs: at(11) }, TZ)
    expect(ticks.map((t) => t.label)).toEqual(['09:00', '10:00', '11:00'])
    expect(ticks[0].leftPct).toBeGreaterThan(0)
  })
})

describe('строки и блоки', () => {
  const win = { startMs: at(8), endMs: at(20) }
  const tables = [table('t1', '1'), table('t2', '2'), table('t3', '3')]

  it('бронь попадает на все свои столы — объединение видно целиком', () => {
    const rows = buildRows(tables, [booking('b1', ['t1', 't2'], 12, 14)], win)
    expect(rows[0].blocks).toHaveLength(1)
    expect(rows[1].blocks).toHaveLength(1)
    expect(rows[2].blocks).toHaveLength(0)
    expect(rows[0].blocks[0].combined).toBe(true)
  })

  it('пустой стол остаётся строкой — это и есть «свободно»', () => {
    const rows = buildRows(tables, [], win)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.blocks.length === 0)).toBe(true)
  })

  it('брони вне окна дня не показываются', () => {
    const rows = buildRows(tables, [booking('b1', ['t1'], 2, 4)], win)
    expect(rows[0].blocks).toHaveLength(0)
  })

  it('пересечение живых броней помечается конфликтом на обоих блоках', () => {
    const rows = buildRows(tables, [
      booking('b1', ['t1'], 12, 14),
      booking('b2', ['t1'], 13, 15),
    ], win)
    expect(rows[0].blocks.map((b) => b.conflict)).toEqual([true, true])
  })

  it('завершённый визит не конфликтует со следующим', () => {
    const rows = buildRows(tables, [
      booking('b1', ['t1'], 12, 14, { state: 'done' }),
      booking('b2', ['t1'], 13, 15),
    ], win)
    expect(rows[0].blocks.every((b) => !b.conflict)).toBe(true)
  })

  it('смежные брони встык конфликтом не считаются', () => {
    const rows = buildRows(tables, [
      booking('b1', ['t1'], 12, 14),
      booking('b2', ['t1'], 14, 16),
    ], win)
    expect(rows[0].blocks.every((b) => !b.conflict)).toBe(true)
  })

  it('блоки отсортированы по времени независимо от порядка данных', () => {
    const rows = buildRows(tables, [
      booking('late', ['t1'], 18, 19),
      booking('early', ['t1'], 9, 10),
    ], win)
    expect(rows[0].blocks.map((b) => b.booking.id)).toEqual(['early', 'late'])
  })
})

describe('зоны', () => {
  it('строки группируются по зонам, «без зоны» уходит вниз', () => {
    const rows = buildRows([
      table('t1', '1', { zoneId: null, zoneName: null }),
      table('t2', '2', { zoneId: 'z1', zoneName: 'Зал' }),
      table('t3', '3', { zoneId: 'z2', zoneName: 'Терраса' }),
    ], [], { startMs: at(8), endMs: at(20) })
    const zones = groupByZone(rows)
    expect(zones.map((z) => z.name)).toEqual(['Зал', 'Терраса', null])
  })
})

describe('сводка занятости', () => {
  const win = { startMs: at(8), endMs: at(20) }
  const tables = [
    table('t1', '1', { seats: 2 }),
    table('t2', '2', { seats: 4 }),
    table('t3', '3', { seats: 6, blocked: true }),
  ]

  it('считает занятые столы и свободные места на текущий момент', () => {
    const rows = buildRows(tables, [booking('b1', ['t1'], 12, 14)], win)
    const s = occupancySummary(rows, at(13))
    expect(s.busyTables).toBe(1)
    expect(s.totalTables).toBe(2) // выключенный стол не считается
    expect(s.freeSeats).toBe(4)
    expect(s.totalSeats).toBe(6)
  })

  it('объединённая бронь не считается дважды в «скоро»', () => {
    const rows = buildRows(tables, [booking('b1', ['t1', 't2'], 14, 16)], win)
    expect(occupancySummary(rows, at(13, 30)).soon).toBe(1)
  })

  it('заявки, ждущие решения, попадают в счётчик', () => {
    const rows = buildRows(tables, [booking('b1', ['t1'], 15, 17, { state: 'pending' })], win)
    expect(occupancySummary(rows, at(12)).pending).toBe(1)
  })
})

describe('состояние блока', () => {
  it('выводится из статуса, посадки и POS-заказа', () => {
    expect(blockState('new', null, null)).toBe('pending')
    expect(blockState('confirmed', null, null)).toBe('confirmed')
    expect(blockState('confirmed', '2027-03-14T10:00:00Z', null)).toBe('arrived')
    // Посадка на кассе — то же состояние, что и отметка хостес
    expect(blockState('confirmed', null, 'order-1')).toBe('arrived')
    expect(blockState('completed', null, null)).toBe('done')
    expect(blockState('no_show', null, null)).toBe('noshow')
  })
})

describe('объём реального ресторана', () => {
  // Acceptance фазы: 50 столов и 200 броней в день таймлайн обязан
  // переваривать. Считаем раскладку, а не рендер: если чистая функция
  // тормозит на этом объёме, никакая оптимизация DOM уже не спасёт.
  const win = { startMs: at(8), endMs: at(24) }
  const many = Array.from({ length: 50 }, (_, i) =>
    table(`t${i}`, String(i + 1), { zoneId: `z${i % 4}`, zoneName: `Зона ${i % 4}` }))
  const load = Array.from({ length: 200 }, (_, i) => {
    const hour = 8 + (i % 15)
    return booking(`b${i}`, [`t${i % 50}`], hour, hour + 2)
  })

  it('раскладка 50 столов и 200 броней укладывается в кадр', () => {
    const started = performance.now()
    const rows = buildRows(many, load, win)
    const zones = groupByZone(rows)
    const summary = occupancySummary(rows, at(13))
    const ms = performance.now() - started

    expect(rows).toHaveLength(50)
    expect(zones).toHaveLength(4)
    expect(summary.totalTables).toBe(50)
    // Порог с большим запасом: интересует порядок величины, а неточность
    expect(ms).toBeLessThan(100)
  })

  it('каждая бронь попала ровно на свой стол', () => {
    const rows = buildRows(many, load, win)
    const placed = rows.reduce((sum, r) => sum + r.blocks.length, 0)
    expect(placed).toBe(200)
  })
})
