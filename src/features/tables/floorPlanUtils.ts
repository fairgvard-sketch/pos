import type { CSSProperties } from 'react'
import type { Table, TableShape } from '../../types'

/** Следующее имя стола продолжает числовую схему зоны: 6→7, T6→T7. */
export function nextTableLabel(tables: { label: string }[]): string {
  const numbered = tables
    .map((table) => /^(.*?)(\d+)$/.exec(table.label.trim()))
    .filter((match): match is RegExpExecArray => match !== null)

  if (numbered.length > 0) {
    const prefix = numbered[0][1]
    const sameSeries = numbered.filter((match) => match[1] === prefix)
    if (sameSeries.length === numbered.length) {
      const max = Math.max(...sameSeries.map((match) => Number.parseInt(match[2], 10)))
      return `${prefix}${max + 1}`
    }
  }

  return String(tables.length + 1)
}

/**
 * Геометрия плана зала — одна на кассу и на кабинет.
 *
 * Холст в обоих продуктах имеет пропорции 16/10, а координаты столов
 * хранятся в ПРОЦЕНТАХ (017): план тянется под любой экран и держит
 * взаимное расположение. Раскладка, сделанная в кабинете, обязана
 * выглядеть на кассе так же — иначе владелец расставляет зал дважды.
 *
 * Правила ниже — зеркало `anglesite/backoffice/src/floorplan-layout.js`
 * (импортировать нечего: это разные приложения).
 */

/** Пропорции холста: из них считается высота круглого стола */
export const CANVAS_ASPECT = 16 / 10
export const DEFAULT_TABLE_WIDTH = 10
export const DEFAULT_TABLE_HEIGHT = 10

/** Стол с позицией и размером на холсте (проценты) */
export interface TableBox {
  x: number
  y: number
  w: number
  h: number
  shape: TableShape
}

export interface PlacedTable extends TableBox {
  table: Table
  /** false — координат в базе нет, стол лежит в полосе «нерасставленные» */
  placed: boolean
}

/**
 * Разложить столы, у которых координат ещё нет.
 *
 * Так выглядят все столы, заведённые до появления плана: pos_x/pos_y =
 * NULL (017). Нерасставленные складываются полосой ВНИЗУ холста, а не
 * поверх уже расставленного зала: иначе новый стол появляется на чужом
 * месте, и кажется, что план сломался.
 */
export function withDefaultPositions(tables: Table[]): PlacedTable[] {
  let index = 0
  return tables.map((table) => {
    const w = Number(table.width) || DEFAULT_TABLE_WIDTH
    const h = Number(table.height) || DEFAULT_TABLE_HEIGHT
    const shape: TableShape = table.shape || 'square'
    if (table.pos_x !== null && table.pos_y !== null) {
      return { table, x: Number(table.pos_x), y: Number(table.pos_y), w, h, shape, placed: true }
    }
    const col = index % 7
    const row = Math.floor(index / 7)
    index += 1
    return { table, x: 10 + col * 13, y: 90 - row * 12, w, h, shape, placed: false }
  })
}

/**
 * Высота стола на холсте с поправкой на форму.
 *
 * Круглый стол должен быть круглым: холст не квадратный, и одинаковые
 * проценты по ширине и высоте дали бы овал. Высота круга в процентах —
 * ширина, умноженная на пропорции холста.
 */
export function boxHeight(box: Pick<TableBox, 'w' | 'h' | 'shape'>): number {
  return box.shape === 'circle' ? box.w * CANVAS_ASPECT : box.h
}

/** Позиция и размер стола на холсте: центр в (x, y) */
export function tableBoxStyle(box: TableBox): CSSProperties {
  return {
    left: `${box.x}%`,
    top: `${box.y}%`,
    width: `${box.w}%`,
    height: `${boxHeight(box)}%`,
    transform: 'translate(-50%, -50%)',
  }
}
