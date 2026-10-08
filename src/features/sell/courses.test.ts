import { describe, it, expect } from 'vitest'
import { fireTargets, heldLineKeys, nextCourse, nextHeldCourse, normalizeCourse } from './courses'

const line = (key: string, course: number | null) => ({ key, course })

describe('heldLineKeys — зеркало правила удержания append_to_order (179)', () => {
  it('закуска уходит, горячее и десерт ждут', () => {
    const held = heldLineKeys([], [line('salad', 1), line('steak', 2), line('cake', 3)])
    expect([...held].sort()).toEqual(['cake', 'steak'])
  })

  it('без закуски горячее уходит сразу, десерт ждёт горячее', () => {
    const held = heldLineKeys([], [line('steak', 2), line('cake', 3)])
    expect([...held]).toEqual(['cake'])
  })

  it('поздний дозаказ ждёт, если ранний курс уже в счёте', () => {
    expect([...heldLineKeys([{ course: 1 }], [line('steak', 2)])]).toEqual(['steak'])
  })

  it('без курса и курс 1 никогда не ждут', () => {
    expect(heldLineKeys([{ course: 3 }], [line('water', null), line('salad', 1)]).size).toBe(0)
  })

  it('счёт без курсов (кофейня) ничего не придерживает', () => {
    expect(heldLineKeys([{ course: null }], [line('latte', null)]).size).toBe(0)
  })

  it('строки старой очереди без поля course не ломают расчёт', () => {
    expect(heldLineKeys([{}], [{ key: 'old' }]).size).toBe(0)
  })
})

describe('выбор курса и цель Fire', () => {
  it('чип курса идёт по кругу', () => {
    expect([null, 1, 2, 3].map(nextCourse)).toEqual([1, 2, 3, null])
  })

  it('мусор из кэша не становится курсом', () => {
    expect(normalizeCourse(4)).toBeNull()
    expect(normalizeCourse('2')).toBeNull()
    expect(normalizeCourse(undefined)).toBeNull()
  })

  const bill = [
    { id: 'salad', course: 1, held: false },
    { id: 'steak', course: 2, held: true },
    { id: 'fish', course: 2, held: true },
    { id: 'cake', course: 3, held: true },
  ]

  it('самый ранний придержанный курс', () => {
    expect(nextHeldCourse(bill)).toBe(2)
    expect(nextHeldCourse([{ course: 1, held: false }])).toBeNull()
  })

  it('без выделения Fire отправляет весь ближайший курс', () => {
    expect(fireTargets(bill, new Set()).map((l) => l.id)).toEqual(['steak', 'fish'])
  })

  it('с выделением — только выделенное и только придержанное', () => {
    expect(fireTargets(bill, new Set(['cake', 'salad'])).map((l) => l.id)).toEqual(['cake'])
  })
})
