import { describe, expect, it } from 'vitest'
import { boxHeight, nextTableLabel, tableBoxStyle, withDefaultPositions } from './floorPlanUtils'
import type { Table } from '../../types'

describe('nextTableLabel', () => {
  it('continues numeric table labels', () => {
    expect(nextTableLabel([{ label: '1' }, { label: '2' }, { label: '5' }])).toBe('6')
  })

  it('keeps an automatic zone prefix', () => {
    expect(nextTableLabel([{ label: 'T1' }, { label: 'T2' }, { label: 'T8' }])).toBe('T9')
  })

  it('falls back to the table count for custom names', () => {
    expect(nextTableLabel([{ label: 'Окно' }, { label: 'Бар' }])).toBe('3')
  })
})

/** Минимальный стол: в раскладке участвуют только геометрические поля */
function table(over: Partial<Table> = {}): Table {
  return {
    id: 't1', label: '1', pos_x: null, pos_y: null,
    width: 10, height: 10, shape: 'square', seats: 2,
    ...over,
  } as Table
}

describe('withDefaultPositions', () => {
  it('сохранённые координаты не переписываются сеткой', () => {
    const [box] = withDefaultPositions([
      table({ pos_x: 33, pos_y: 44, width: 12, height: 8, shape: 'circle' }),
    ])
    expect([box.x, box.y, box.w, box.h, box.shape]).toEqual([33, 44, 12, 8, 'circle'])
    expect(box.placed).toBe(true)
  })

  it('столы без координат не сваливаются в одну точку', () => {
    const boxes = withDefaultPositions([table({ id: 'a' }), table({ id: 'b' })])
    expect([boxes[0].x, boxes[0].y]).not.toEqual([boxes[1].x, boxes[1].y])
    expect(boxes[0].placed).toBe(false)
  })

  it('нерасставленные лежат полосой внизу, а не поверх зала', () => {
    // Иначе новый стол появляется на чужом месте, и план кажется сломанным
    const boxes = withDefaultPositions([table({ id: 'a' }), table({ id: 'b', pos_x: 20, pos_y: 20 })])
    expect(boxes[0].y).toBeGreaterThan(80)
  })

  it('нулевой размер из старых данных заменяется дефолтом', () => {
    const [box] = withDefaultPositions([table({ pos_x: 10, pos_y: 10, width: 0, height: 0 })])
    expect([box.w, box.h]).toEqual([10, 10])
  })
})

describe('геометрия стола', () => {
  it('круг остаётся кругом на холсте 16/10, а не растекается овалом', () => {
    expect(boxHeight({ w: 10, h: 10, shape: 'circle' })).toBeCloseTo(16)
    expect(boxHeight({ w: 10, h: 6, shape: 'square' })).toBe(6)
  })

  it('стол центрируется в своей точке', () => {
    const style = tableBoxStyle({ x: 25, y: 40, w: 12, h: 8, shape: 'square' })
    expect(style).toMatchObject({
      left: '25%', top: '40%', width: '12%', height: '8%', transform: 'translate(-50%, -50%)',
    })
  })
})
