import { describe, expect, it } from 'vitest'
import {
  createdVia, dayRel, filterReservations, groupByDay, matchesQuery, paginate,
  sortByTime, tableIdsOf, visitState, zoneOf,
} from './list'
import type { Reservation } from './api'

const TZ = 'Asia/Jerusalem'

function res(over: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r1',
    customer_name: 'Дана',
    customer_phone: '0501234567',
    party_size: 2,
    reserved_at: '2026-08-04T17:00:00.000Z',
    status: 'confirmed',
    table_id: null,
    order_id: null,
    note: null,
    ...over,
  } as Reservation
}

describe('состояние визита', () => {
  it('отказ и отмена — отдельные состояния, а не «подтверждена»', () => {
    expect(visitState(res({ status: 'rejected' }))).toBe('rejected')
    expect(visitState(res({ status: 'cancelled' }))).toBe('cancelled')
  })

  it('посадка считается по факту: отметка хостес или счёт кассы', () => {
    expect(visitState(res({ arrived_at: '2026-08-04T17:05:00.000Z' }))).toBe('arrived')
    expect(visitState(res({ order_id: 'o1' }))).toBe('arrived')
    expect(visitState(res({ status: 'new' }))).toBe('pending')
  })
})

describe('путь заведения', () => {
  it('незаписанный путь не выдаётся за гостевой', () => {
    expect(createdVia(res())).toBe('unknown')
    expect(createdVia(res({ created_via: null }))).toBe('unknown')
    expect(createdVia(res({ created_via: 'pos' }))).toBe('pos')
  })
})

describe('зона визита', () => {
  const zoneByTable = new Map<string, string | null>([['t1', 'z-hall'], ['t2', null]])

  it('считается по рассадке, а потом уже по пожеланию гостя', () => {
    expect(zoneOf(res({ table_id: 't1' }), zoneByTable)).toBe('z-hall')
    expect(zoneOf(res({ table_id: 't2', zone_id: 'z-wish' }), zoneByTable)).toBe('z-wish')
    expect(zoneOf(res(), zoneByTable)).toBe(null)
  })

  it('столы визита собираются из связи, основного и объединённых', () => {
    const r = res({
      table_id: 't1',
      hold_table_ids: ['t2'],
      tables_link: [{ table_id: 't1', is_primary: true }],
    })
    expect(tableIdsOf(r)).toEqual(['t1', 't2'])
  })
})

describe('поиск и отбор', () => {
  it('телефон ищется по цифрам, имя — по подстроке', () => {
    expect(matchesQuery(res(), '1234')).toBe(true)
    expect(matchesQuery(res(), 'дан')).toBe(true)
    expect(matchesQuery(res(), 'ор')).toBe(false)
    // Пустой запрос — «всё», а не «ничего»
    expect(matchesQuery(res(), '  ')).toBe(true)
  })

  it('пустой фильтр не срезает ленту', () => {
    const rows = [res({ id: 'a' }), res({ id: 'b', status: 'new' })]
    expect(filterReservations(rows)).toHaveLength(2)
    expect(filterReservations(rows, { state: 'pending' }).map((r) => r.id)).toEqual(['b'])
  })
})

describe('порядок', () => {
  it('обратим и стабилен при одинаковом времени', () => {
    const early = res({ id: 'e', reserved_at: '2026-08-04T15:00:00.000Z' })
    const late = res({ id: 'l', reserved_at: '2026-08-04T19:00:00.000Z' })
    const sameA = res({ id: 's1', customer_name: 'Алекс', reserved_at: '2026-08-04T19:00:00.000Z' })
    expect(sortByTime([late, early]).map((r) => r.id)).toEqual(['e', 'l'])
    expect(sortByTime([early, late], 'desc').map((r) => r.id)).toEqual(['l', 'e'])
    expect(sortByTime([late, sameA]).map((r) => r.id)).toEqual(['s1', 'l'])
  })
})

describe('дни', () => {
  it('группа считается в сутках точки, а не устройства', () => {
    // 21:30 UTC — это уже следующий день в Иерусалиме (UTC+3)
    const groups = groupByDay([res({ reserved_at: '2026-08-04T21:30:00.000Z' })], TZ, '2026-08-05')
    expect(groups[0].key).toBe('2026-08-05')
    expect(groups[0].rel).toBe('today')
  })

  it('соседние дни подписываются словами, остальные — датой', () => {
    expect(dayRel('2026-08-05', '2026-08-04')).toBe('tomorrow')
    expect(dayRel('2026-08-03', '2026-08-04')).toBe('yesterday')
    expect(dayRel('2026-08-09', '2026-08-04')).toBe(null)
  })
})

describe('страницы', () => {
  const rows = Array.from({ length: 30 }, (_, i) => i)

  it('номер приводится к существующему после сужения отбора', () => {
    const slice = paginate(rows.slice(0, 5), 3, 25)
    expect(slice.page).toBe(1)
    expect(slice.items).toHaveLength(5)
  })

  it('подпись считает строки, а не индексы', () => {
    const slice = paginate(rows, 2, 25)
    expect([slice.from, slice.to, slice.total, slice.pages]).toEqual([26, 30, 30, 2])
  })

  it('пустая лента не обещает первой строки', () => {
    expect(paginate([], 1, 25).from).toBe(0)
  })
})
