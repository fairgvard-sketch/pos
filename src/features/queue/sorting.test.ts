import { describe, it, expect } from 'vitest'
import { sortQueueOrders, sortItemsByStation } from './sorting'

/**
 * 087: срочные заказы всплывают наверх очереди (внутри групп — FIFO),
 * строки карточки идут в порядке станций из Меню → Станции.
 */

describe('sortQueueOrders', () => {
  const o = (id: string, created_at: string, is_urgent?: boolean) => ({ id, created_at, is_urgent })

  it('без срочных — прежний FIFO по created_at', () => {
    const res = sortQueueOrders([o('b', '2026-07-20T10:05'), o('a', '2026-07-20T10:00')])
    expect(res.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('срочный всплывает наверх, остальные сохраняют FIFO', () => {
    const res = sortQueueOrders([
      o('a', '2026-07-20T10:00'),
      o('b', '2026-07-20T10:05'),
      o('c', '2026-07-20T10:10', true),
    ])
    expect(res.map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('несколько срочных — FIFO между собой', () => {
    const res = sortQueueOrders([
      o('a', '2026-07-20T10:00'),
      o('c', '2026-07-20T10:10', true),
      o('b', '2026-07-20T10:05', true),
    ])
    expect(res.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('эхо офлайн-заказа (без is_urgent) сортируется как несрочное', () => {
    const res = sortQueueOrders([
      { id: 'echo', created_at: '2026-07-20T09:00' },
      o('u', '2026-07-20T10:00', true),
    ])
    expect(res.map((x) => x.id)).toEqual(['u', 'echo'])
  })
})

describe('sortItemsByStation', () => {
  const stations = [{ id: 'bar' }, { id: 'kitchen' }]
  const i = (id: string, station_id: string | null) => ({ id, station_id })

  it('строки идут в порядке станций, без станции — в конец', () => {
    const res = sortItemsByStation(
      [i('cake', 'kitchen'), i('water', null), i('espresso', 'bar')],
      stations
    )
    expect(res.map((x) => x.id)).toEqual(['espresso', 'cake', 'water'])
  })

  it('внутри станции сохраняется порядок добавления', () => {
    const res = sortItemsByStation(
      [i('latte', 'bar'), i('cake', 'kitchen'), i('espresso', 'bar')],
      stations
    )
    expect(res.map((x) => x.id)).toEqual(['latte', 'espresso', 'cake'])
  })

  it('без станций порядок не меняется', () => {
    const items = [i('a', null), i('b', null)]
    expect(sortItemsByStation(items, [])).toEqual(items)
  })

  it('удалённая станция позиции не роняет сортировку (в конец)', () => {
    const res = sortItemsByStation([i('x', 'ghost'), i('espresso', 'bar')], stations)
    expect(res.map((x) => x.id)).toEqual(['espresso', 'x'])
  })
})
