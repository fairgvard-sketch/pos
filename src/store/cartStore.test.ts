import { describe, it, expect, beforeEach } from 'vitest'
import {
  useCartStore,
  lineUnitPrice,
  cartSubtotal,
  discountAmount,
  loyaltyAmount,
  cartTotal,
  type CartLine,
} from './cartStore'

function line(over: Partial<CartLine> = {}): CartLine {
  return {
    key: over.key ?? Math.random().toString(36).slice(2),
    itemId: 'item-1',
    name: 'Капучино',
    variantId: null,
    variantName: null,
    basePrice: 1200,
    mods: [],
    qty: 1,
    notes: '',
    priceOverride: null,
    ...over,
  }
}

describe('lineUnitPrice', () => {
  it('база + дельты модификаторов', () => {
    const l = line({ basePrice: 1200, mods: [{ id: 'm1', name: 'сироп', priceDelta: 200 }, { id: 'm2', name: 'овсяное', priceDelta: -100 }] })
    expect(lineUnitPrice(l)).toBe(1300)
  })
  it('ручная цена перебивает базу и моды', () => {
    const l = line({ basePrice: 1200, mods: [{ id: 'm1', name: 'сироп', priceDelta: 200 }], priceOverride: 500 })
    expect(lineUnitPrice(l)).toBe(500)
  })
})

describe('cartSubtotal', () => {
  it('сумма unit × qty по строкам', () => {
    expect(cartSubtotal([line({ basePrice: 1200, qty: 2 }), line({ basePrice: 500 })])).toBe(2900)
  })
})

describe('discountAmount / cartTotal — зеркало round_order_total (034)', () => {
  const lines = [line({ basePrice: 1230 })]

  it('без скидки итог не округляется', () => {
    expect(cartTotal(lines)).toBe(1230)
    expect(discountAmount(1230, null)).toBe(0)
  })

  it('процентная скидка забирает «хвост» до целого шекеля', () => {
    // 1230 − 10% (123) = 1107 → 1100; показанная скидка 130
    const d = { type: 'percent' as const, value: 10, reason: '' }
    expect(cartTotal(lines, d)).toBe(1100)
    expect(discountAmount(1230, d)).toBe(130)
    expect(1230 - discountAmount(1230, d)).toBe(cartTotal(lines, d))
  })

  it('фиксированная скидка не больше подытога', () => {
    const d = { type: 'fixed' as const, value: 99999, reason: '' }
    expect(cartTotal(lines, d)).toBe(0)
    expect(discountAmount(1230, d)).toBe(1230)
  })

  it('округление вверх ограничено суммой до вычета (скидка не уходит в минус)', () => {
    // 1052 − 1 = 1051 → округлилось бы к 1100 > 1052 → потолок 1052, скидка к показу 0
    const small = [line({ basePrice: 1052 })]
    const d = { type: 'fixed' as const, value: 1, reason: '' }
    expect(cartTotal(small, d)).toBe(1052)
    expect(discountAmount(1052, d)).toBe(0)
  })
})

describe('loyaltyAmount — приоритет «хвоста» за лояльностью', () => {
  const lines = [line({ basePrice: 1230 })]

  it('без скидки: вычет лояльности забирает хвост', () => {
    // 1230 − 200 = 1030 → 1000; показанный вычет 230
    const r = { type: 'stamps' as const, amount: 200 }
    expect(cartTotal(lines, null, r)).toBe(1000)
    expect(loyaltyAmount(1230, null, r)).toBe(230)
    expect(discountAmount(1230, null, r)).toBe(0)
  })

  it('скидка + лояльность: скидка показывается «сырой», хвост у лояльности', () => {
    // 2460 − 10% (246) = 2214; − 300 = 1914 → 1900
    const big = [line({ basePrice: 2460 })]
    const d = { type: 'percent' as const, value: 10, reason: '' }
    const r = { type: 'points' as const, amount: 300 }
    expect(discountAmount(2460, d, r)).toBe(246)
    expect(loyaltyAmount(2460, d, r)).toBe(314)
    expect(cartTotal(big, d, r)).toBe(1900)
    // Строки корзины сходятся с итогом
    expect(2460 - 246 - 314).toBe(1900)
  })

  it('вычет лояльности не больше остатка после скидки', () => {
    const d = { type: 'fixed' as const, value: 900, reason: '' }
    const r = { type: 'points' as const, amount: 500 }
    const small = [line({ basePrice: 1000 })]
    expect(loyaltyAmount(1000, d, r)).toBe(100)
    expect(cartTotal(small, d, r)).toBe(0)
  })
})

describe('addLine — схлопывание одинаковых конфигураций', () => {
  beforeEach(() => useCartStore.getState().clear())

  const cfg = {
    itemId: 'item-1',
    name: 'Капучино',
    variantId: 'v1',
    variantName: 'M',
    basePrice: 1200,
    mods: [{ id: 'm1', name: 'сироп', priceDelta: 200 }],
    notes: '',
    priceOverride: null,
  }

  it('одинаковая конфигурация увеличивает qty', () => {
    useCartStore.getState().addLine(cfg)
    useCartStore.getState().addLine(cfg)
    const lines = useCartStore.getState().lines
    expect(lines).toHaveLength(1)
    expect(lines[0].qty).toBe(2)
  })

  it('другой вариант или заметка — отдельная строка', () => {
    useCartStore.getState().addLine(cfg)
    useCartStore.getState().addLine({ ...cfg, variantId: 'v2', variantName: 'L' })
    useCartStore.getState().addLine({ ...cfg, notes: 'без пенки' })
    expect(useCartStore.getState().lines).toHaveLength(3)
  })

  it('ручная цена и свободные позиции не схлопываются', () => {
    useCartStore.getState().addLine({ ...cfg, priceOverride: 1000 })
    useCartStore.getState().addLine({ ...cfg, priceOverride: 1000 })
    useCartStore.getState().addLine({ ...cfg, itemId: null })
    useCartStore.getState().addLine({ ...cfg, itemId: null })
    expect(useCartStore.getState().lines).toHaveLength(4)
  })

  it('updateQty ≤ 0 удаляет строку', () => {
    useCartStore.getState().addLine(cfg)
    const key = useCartStore.getState().lines[0].key
    useCartStore.getState().updateQty(key, 0)
    expect(useCartStore.getState().lines).toHaveLength(0)
  })
})
