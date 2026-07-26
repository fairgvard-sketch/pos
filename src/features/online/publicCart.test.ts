import { beforeEach, describe, expect, it } from 'vitest'
import { publicCartKey, readPublicCart, writePublicCart } from './publicCart'

const line = {
  key: 'line-1',
  itemId: 'item-1',
  name: 'Coffee',
  variantId: null,
  variantName: null,
  modIds: [],
  modNames: [],
  unitPrice: 1200,
  qty: 1,
}

describe('public cart persistence', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a valid cart', () => {
    writePublicCart('loc-1', [line], 1_000)
    expect(readPublicCart('loc-1', 2_000)).toEqual([line])
  })

  it('drops an expired cart', () => {
    writePublicCart('loc-1', [line], 1_000)
    expect(readPublicCart('loc-1', 7 * 60 * 60 * 1000)).toEqual([])
    expect(localStorage.getItem(publicCartKey('loc-1'))).toBeNull()
  })

  it('drops malformed data instead of breaking the guest page', () => {
    localStorage.setItem(publicCartKey('loc-1'), JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      lines: [{ ...line, unitPrice: 12.5 }],
    }))
    expect(readPublicCart('loc-1')).toEqual([])
  })
})
