import { describe, it, expect } from 'vitest'
import { varianceRows, varianceTotals } from './variance'
import type { StockReportRow } from './api'

function row(over: Partial<StockReportRow>): StockReportRow {
  return {
    menu_item_id: null,
    supply_item_id: 's1',
    kind: 'supply',
    name: 'Молоко',
    unit: 'мл',
    opening: 0,
    sold: 0,
    returned: 0,
    waste: 0,
    received: 0,
    count_adj: 0,
    counts: 0,
    sold_value: 0,
    returned_value: 0,
    waste_value: 0,
    received_value: 0,
    count_value: 0,
    closing: 0,
    closing_value: null,
    stock_now: null,
    ...over,
  }
}

describe('varianceRows — теория vs факт', () => {
  it('недостача: инвентаризация съела больше теории', () => {
    // Продано 1000, списано 200; инвентаризация нашла ещё −100 (count_adj)
    const [r] = varianceRows([
      row({ sold: 1000, waste: 200, count_adj: -100, counts: 1, count_value: -800 }),
    ])
    expect(r.expected).toBe(1200)
    expect(r.diff).toBe(100)       // недостача
    expect(r.fact).toBe(1300)
    expect(r.diffValue).toBe(800)  // потеря в агоротах
    expect(r.counted).toBe(true)
    expect(r.diffPct).toBeCloseTo(100 / 1200)
  })

  it('излишек — отрицательное расхождение', () => {
    const [r] = varianceRows([row({ sold: 500, count_adj: 50, counts: 1, count_value: 400 })])
    expect(r.diff).toBe(-50)
    expect(r.fact).toBe(450)
    expect(r.diffValue).toBe(-400)
  })

  it('инвентаризация «сошлось» (counts>0, adj=0) отличается от «не проверяли»', () => {
    const rows = varianceRows([
      row({ supply_item_id: 'a', name: 'A', sold: 100, count_adj: 0, counts: 1 }),
      row({ supply_item_id: 'b', name: 'B', sold: 100, count_adj: 0, counts: 0 }),
    ])
    const a = rows.find((r) => r.name === 'A')!
    const b = rows.find((r) => r.name === 'B')!
    expect(a.counted).toBe(true)
    expect(b.counted).toBe(false)
  })

  it('void/split уменьшают теорию; чистый приход не шумит в отчёте', () => {
    const rows = varianceRows([
      row({ supply_item_id: 'a', name: 'A', sold: 100, returned: 30 }),
      row({ supply_item_id: 'b', name: 'B', received: 500 }), // только приход
    ])
    expect(rows.find((r) => r.name === 'A')!.expected).toBe(70)
    expect(rows.find((r) => r.name === 'B')).toBeUndefined()
  })

  it('сортировка: проверенные с большим расхождением в ₪ сверху, непроверенные внизу', () => {
    const rows = varianceRows([
      row({ supply_item_id: 'a', name: 'Небольшое', sold: 10, count_adj: -1, counts: 1, count_value: -50 }),
      row({ supply_item_id: 'b', name: 'Крупное', sold: 10, count_adj: -5, counts: 1, count_value: -900 }),
      row({ supply_item_id: 'c', name: 'Непроверенное', sold: 10, counts: 0 }),
    ])
    expect(rows.map((r) => r.name)).toEqual(['Крупное', 'Небольшое', 'Непроверенное'])
  })

  it('counts отсутствует (старый сервер без 085) — считаем непроверенным', () => {
    const [r] = varianceRows([row({ sold: 10, counts: undefined })])
    expect(r.counted).toBe(false)
  })
})

describe('varianceTotals', () => {
  it('недостачи и излишки в деньгах, счётчик непроверенных', () => {
    const totals = varianceTotals(
      varianceRows([
        row({ supply_item_id: 'a', name: 'A', sold: 10, count_adj: -2, counts: 1, count_value: -300 }),
        row({ supply_item_id: 'b', name: 'B', sold: 10, count_adj: 1, counts: 1, count_value: 100 }),
        row({ supply_item_id: 'c', name: 'C', sold: 10, counts: 0 }),
      ])
    )
    expect(totals.shortageValue).toBe(300)
    expect(totals.surplusValue).toBe(100)
    expect(totals.uncounted).toBe(1)
  })
})
