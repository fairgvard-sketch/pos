import { describe, expect, it } from 'vitest'
import { addLine, freeze, linesCount, linesTotal, sendItems, setQty, unfreeze, type NewLine } from './draft'

const salad: NewLine = {
  itemId: 'salad', name: 'Salad', variantId: null, variantName: null,
  basePrice: 3000, mods: [], notes: '', course: 1,
}
const steak: NewLine = {
  itemId: 'steak', name: 'Steak', variantId: 'big', variantName: 'Big',
  basePrice: 9000, mods: [{ id: 'm1', name: 'Medium', priceDelta: 500 }], notes: 'no salt', course: 2,
}

let n = 0
const uuid = () => `u${++n}`

describe('черновик стола', () => {
  it('одинаковые блюда схлопываются в количество', () => {
    let lines = addLine([], salad, 'a')
    lines = addLine(lines, salad, 'b')
    lines = addLine(lines, { ...salad, course: 2 }, 'c')
    expect(lines.map((l) => [l.key, l.qty, l.course])).toEqual([['a', 2, 1], ['c', 1, 2]])
  })

  it('итог считает модификаторы, количество обнуляется удалением', () => {
    let lines = addLine([], steak, 'a')
    lines = setQty(lines, 'a', 2)
    expect(linesTotal(lines)).toBe(19000)
    expect(linesCount(setQty(lines, 'a', 0))).toBe(0)
  })
})

describe('заморозка отправки', () => {
  it('id строк и op_uuid выданы до первой попытки и не меняются при повторе', () => {
    const p = freeze(addLine(addLine([], salad, 'a'), steak, 'b'), uuid, new Date('2026-10-09T10:00:00Z'))
    expect(p.opUuid).toBeTruthy()
    expect(new Set(p.lines.map((l) => l.lineId)).size).toBe(2)
    expect(sendItems(p)).toEqual(sendItems(p))
  })

  it('p_items без цены: только каталог, модификаторы, курс и заметка', () => {
    const items = sendItems(freeze(addLine([], steak, 'a'), uuid))
    expect(items[0]).toEqual({
      id: expect.any(String), menu_item_id: 'steak', variant_id: 'big',
      modifier_ids: ['m1'], qty: 1, notes: 'no salt', course: 2,
    })
    expect(items[0]).not.toHaveProperty('unit_price_override')
  })

  it('явный отказ сервера возвращает замороженное в черновик вместе с новыми блюдами', () => {
    const pending = freeze(addLine([], salad, 'a'), uuid)
    const draft = unfreeze({ lines: addLine(addLine([], salad, 'x'), steak, 'y'), pending })
    expect(draft.pending).toBeNull()
    expect(draft.lines.map((l) => [l.itemId, l.qty])).toEqual([['salad', 2], ['steak', 1]])
    expect(draft.lines[0]).not.toHaveProperty('lineId')
  })
})
