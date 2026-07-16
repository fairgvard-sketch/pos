import { describe, it, expect } from 'vitest'
import { tipPercentBase, buildTipOptions, type TipConfig } from './tipMath'

const base: TipConfig = {
  presets: [10, 15, 20],
  beforeTax: false,
  roundUp: false,
  smartAmounts: false,
  smartThreshold: 5000,
  smartFixed: [200, 300, 500],
}

describe('tipPercentBase', () => {
  it('с НДС — база равна итогу', () => {
    expect(tipPercentBase(11800, 18, false)).toBe(11800)
  })
  it('без НДС — вычитает включённый НДС по ставке точки', () => {
    // 11800 при 18% → НДС 1800, база 10000
    expect(tipPercentBase(11800, 18, true)).toBe(10000)
  })
})

describe('buildTipOptions', () => {
  it('проценты от итога, без подгонки', () => {
    expect(buildTipOptions(10000, 18, base)).toEqual([
      { percent: 10, amount: 1000 },
      { percent: 15, amount: 1500 },
      { percent: 20, amount: 2000 },
    ])
  })
  it('проценты от базы без НДС', () => {
    // база 10000 → 10% = 1000, а не 1180
    expect(buildTipOptions(11800, 18, { ...base, beforeTax: true })[0]).toEqual({ percent: 10, amount: 1000 })
  })
  it('roundUp подгоняет total+tip до целого шекеля', () => {
    // total 1230 + 10% (123) = 1353 → 1400 → tip 170
    expect(buildTipOptions(1230, 18, { ...base, roundUp: true })[0]).toEqual({ percent: 10, amount: 170 })
  })
  it('нулевые пресеты отфильтровываются', () => {
    expect(buildTipOptions(1000, 18, { ...base, presets: [0, 10] })).toHaveLength(1)
  })
  it('умный режим: мелкий заказ — фиксированные суммы без percent', () => {
    const opts = buildTipOptions(3000, 18, { ...base, smartAmounts: true })
    expect(opts).toEqual([{ amount: 200 }, { amount: 300 }, { amount: 500 }])
  })
  it('умный режим: заказ выше порога — обычные проценты', () => {
    const opts = buildTipOptions(6000, 18, { ...base, smartAmounts: true })
    expect(opts[0]).toEqual({ percent: 10, amount: 600 })
  })
  it('умный режим + roundUp: фиксированная сумма тоже подгоняется', () => {
    // total 1230 + 200 = 1430 → 1400 → tip 170
    expect(buildTipOptions(1230, 18, { ...base, smartAmounts: true, roundUp: true })[0]).toEqual({ amount: 170 })
  })
})
