import { describe, expect, it } from 'vitest'
import { codeFromHash, normalizePairCode, phoneLabel } from './pairCode'

describe('код допуска', () => {
  it('из QR-фрагмента и ручного ввода в любом регистре', () => {
    expect(codeFromHash('#K7M2-P9QR')).toBe('K7M2P9QR')
    expect(normalizePairCode(' k7m2 p9qr ')).toBe('K7M2P9QR')
  })

  it('похожие символы и неверная длина не проходят', () => {
    expect(normalizePairCode('K7M2P9Q0')).toBeNull()
    expect(normalizePairCode('K7M2P9Q')).toBeNull()
    expect(codeFromHash('')).toBeNull()
  })
})

describe('подпись телефона', () => {
  it('устройство и браузер', () => {
    expect(phoneLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
    expect(phoneLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36')).toBe('Android · Chrome')
    expect(phoneLabel('curl/8')).toBe('Browser')
  })
})
