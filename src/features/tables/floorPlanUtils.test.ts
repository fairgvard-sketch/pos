import { describe, expect, it } from 'vitest'
import { nextTableLabel } from './floorPlanUtils'

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
