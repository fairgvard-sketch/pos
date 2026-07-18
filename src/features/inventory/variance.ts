import type { StockReportRow, StockKind } from './api'

/**
 * «Теория vs факт» (P2): ожидаемый расход позиции складывается из продаж по
 * рецептурам (sold − returned) и учтённых списаний (waste); фактический —
 * то же плюс инвентаризационные поправки (count). Расхождение = −count_adj:
 * положительное — недостача (факт съел больше теории), отрицательное —
 * излишек. Позиция без единой count-строки в периоде честно помечается
 * «не проверялось», а не выглядит идеально сошедшейся (counts, 085).
 */

export interface VarianceRow {
  key: string
  name: string
  kind: StockKind
  unit: string | null
  /** Ожидаемый расход: sold − returned + waste */
  expected: number
  /** Фактический расход: expected + diff */
  fact: number
  /** Расхождение: >0 недостача, <0 излишек */
  diff: number
  /** Доля расхождения от ожидаемого расхода; null, если expected = 0 */
  diffPct: number | null
  /** Расхождение в деньгах, агороты (>0 — потеря) */
  diffValue: number
  /** Была ли инвентаризация позиции в периоде */
  counted: boolean
}

export function varianceRows(rows: StockReportRow[]): VarianceRow[] {
  return rows
    .map((r): VarianceRow => {
      const expected = r.sold - r.returned + r.waste
      const diff = -r.count_adj
      return {
        key: r.supply_item_id ?? r.menu_item_id ?? r.name,
        name: r.name,
        kind: r.kind,
        unit: r.unit,
        expected,
        fact: expected + diff,
        diff,
        diffPct: expected !== 0 ? diff / expected : null,
        diffValue: -r.count_value,
        counted: (r.counts ?? 0) > 0,
      }
    })
    // Позиции без расхода и без проверки — шум (чистые приходы и т.п.)
    .filter((r) => r.expected !== 0 || r.counted || r.diff !== 0)
    // Проверенные с наибольшим расхождением в деньгах — сверху; непроверенные — вниз
    .sort((a, b) => {
      if (a.counted !== b.counted) return a.counted ? -1 : 1
      return (
        Math.abs(b.diffValue) - Math.abs(a.diffValue) ||
        Math.abs(b.diff) - Math.abs(a.diff) ||
        a.name.localeCompare(b.name)
      )
    })
}

export interface VarianceTotals {
  /** Сумма недостач, агороты */
  shortageValue: number
  /** Сумма излишков, агороты */
  surplusValue: number
  /** Позиции периода без инвентаризации */
  uncounted: number
}

export function varianceTotals(rows: VarianceRow[]): VarianceTotals {
  return {
    shortageValue: rows.reduce((s, r) => s + Math.max(0, r.diffValue), 0),
    surplusValue: rows.reduce((s, r) => s + Math.max(0, -r.diffValue), 0),
    uncounted: rows.filter((r) => !r.counted).length,
  }
}
