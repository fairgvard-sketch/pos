import { describe, expect, it } from 'vitest'
import { cleanDeviceLabel, normalizePairCode, pairErrorCode, randomPassword } from './waiter-pair'

describe('normalizePairCode', () => {
  it('принимает код в любом регистре, с пробелами и дефисами', () => {
    expect(normalizePairCode('abcd-efgh')).toBe('ABCDEFGH')
    expect(normalizePairCode(' K7M2 P9QR ')).toBe('K7M2P9QR')
  })

  it('отвергает похожие символы, длину и не-строки', () => {
    expect(normalizePairCode('ABCDEFG0')).toBeNull() // 0 нет в алфавите
    expect(normalizePairCode('ABCDEFGI')).toBeNull() // I нет в алфавите
    expect(normalizePairCode('ABCDEFG')).toBeNull()
    expect(normalizePairCode('ABCDEFGHJ')).toBeNull()
    expect(normalizePairCode(null)).toBeNull()
    expect(normalizePairCode('A'.repeat(100))).toBeNull()
  })
})

describe('cleanDeviceLabel', () => {
  it('одна строка без управляющих символов, до 60 знаков', () => {
    expect(cleanDeviceLabel('iPhone\n\tSafari')).toBe('iPhone Safari')
    expect(cleanDeviceLabel('x'.repeat(80))).toHaveLength(60)
    expect(cleanDeviceLabel(42)).toBe('')
  })
})

describe('pairErrorCode', () => {
  it('известные ошибки отдаются кодом, остальное — unknown', () => {
    expect(pairErrorCode('invalid_code')).toBe('invalid_code')
    expect(pairErrorCode('ERROR: module_disabled')).toBe('module_disabled')
    expect(pairErrorCode('duplicate key value')).toBe('unknown')
  })
})

describe('randomPassword', () => {
  it('64 hex-символа и каждый раз новый', () => {
    const a = randomPassword()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(randomPassword()).not.toBe(a)
  })
})
