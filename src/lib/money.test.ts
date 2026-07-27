import { describe, it, expect } from 'vitest'
import {
  parseMoney,
  percentOf,
  splitEvenly,
  roundTipToWholeTotal,
  formatMoney,
  formatMoneyPlain,
  formatMoneyList,
  formatMoneyDelta,
} from './money'

/**
 * Позиция ₪ раньше зависела от dir контейнера: в LTR-блоках выходило
 * "12 ₪", в RTL — "₪ 12". Формат задаётся функцией, поэтому и проверяется
 * здесь, а не глазами на каждом экране.
 */
describe('formatMoney: символ валюты слева', () => {
  /** Строка без bidi-изоляторов — их позиция проверяется отдельно */
  const bare = (s: string) => s.replace(/[⁦-⁩]/g, '')

  it('ставит ₪ перед суммой в обоих языках', () => {
    expect(bare(formatMoney(1250, 'he'))).toBe('₪ 12.50')
    expect(bare(formatMoney(1250, 'ru'))).toBe('₪ 12,50')
  })

  it('целые суммы без дробной части', () => {
    expect(bare(formatMoney(1200, 'he'))).toBe('₪ 12')
    expect(bare(formatMoney(0, 'he'))).toBe('₪ 0')
  })

  it('изолирует группу, чтобы ивритский текст не переставил символ', () => {
    const s = formatMoney(1200, 'he')
    expect(s.startsWith('⁦')).toBe(true)
    expect(s.endsWith('⁩')).toBe(true)
  })

  it('formatMoneyPlain — тот же порядок, но без управляющих символов', () => {
    // Уходит в WhatsApp и печать: изоляторы там показались бы мусором
    const s = formatMoneyPlain(1250, 'he')
    expect(s).toBe('₪ 12.50')
    expect(/[⁦-⁩]/.test(s)).toBe(false)
  })

  it('список сумм — один символ в начале', () => {
    expect(bare(formatMoneyList([1000, 1200, 1400], 'he'))).toBe('₪ 10/12/14')
  })

  it('надбавка модификатора: знак после числа и отделён от него', () => {
    expect(bare(formatMoneyDelta(200, 'he'))).toBe('₪ 2\u00a0+')
    expect(bare(formatMoneyDelta(-150, 'he'))).toBe('₪ 1.50\u00a0−')
    // Знак ВНУТРИ группы, иначе иврит уведёт его к названию модификатора
    expect(formatMoneyDelta(200, 'he')).toBe('⁦₪ 2\u00a0+⁩')
  })
})

describe('parseMoney', () => {
  it('парсит целые и дробные шекели в агороты', () => {
    expect(parseMoney('12')).toBe(1200)
    expect(parseMoney('12.5')).toBe(1250)
    expect(parseMoney('12.50')).toBe(1250)
    expect(parseMoney('0.01')).toBe(1)
  })
  it('принимает запятую как разделитель', () => {
    expect(parseMoney('12,50')).toBe(1250)
  })
  it('отвергает мусор и >2 знаков после точки', () => {
    expect(parseMoney('abc')).toBeNull()
    expect(parseMoney('12.345')).toBeNull()
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('-5')).toBeNull()
  })
})

describe('percentOf', () => {
  it('округляет до агорота', () => {
    expect(percentOf(1000, 10)).toBe(100)
    expect(percentOf(333, 10)).toBe(33) // 33.3 → 33
    expect(percentOf(335, 10)).toBe(34) // 33.5 → 34 (round half up)
  })
})

describe('splitEvenly', () => {
  it('делит без потери агорот — сумма частей == total', () => {
    for (const [total, n] of [[10000, 3], [1, 3], [999, 7], [12345, 4], [0, 5]] as const) {
      const parts = splitEvenly(total, n)
      expect(parts).toHaveLength(n)
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
      // Доли отличаются максимум на 1 агорот
      expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1)
    }
  })
  it('первые (total mod n) долей на 1 агорот больше', () => {
    expect(splitEvenly(10000, 3)).toEqual([3334, 3333, 3333])
  })
  it('n<1 возвращает [total]', () => {
    expect(splitEvenly(500, 0)).toEqual([500])
  })
})

describe('roundTipToWholeTotal', () => {
  it('подгоняет итог (total+tip) до целого шекеля', () => {
    // total=1230, tip≈70 → итог 1300 (13 ₪) → tip 70
    expect(roundTipToWholeTotal(1230, 70)).toBe(70)
    // total=1230, tip=50 → итог 1280 → ближайший шекель 1300 → tip 70
    expect(roundTipToWholeTotal(1230, 50)).toBe(70)
  })
  it('никогда не отрицательный', () => {
    expect(roundTipToWholeTotal(1300, -500)).toBe(0)
  })
  it('enabled=false — чаевые как есть, без подгонки', () => {
    expect(roundTipToWholeTotal(1230, 55, false)).toBe(55)
    expect(roundTipToWholeTotal(1230, -5, false)).toBe(0)
  })
})
