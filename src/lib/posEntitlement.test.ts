import { describe, expect, it } from 'vitest'
import { interpretPosEntitlement } from './posEntitlement'

/**
 * Гейт активации POS (Phase 5 product separation): блокирует кассу только
 * уверенный отрицательный ответ сервера. Всё неоднозначное — 'unknown':
 * офлайн-касса продолжает работать по кэшу, границей остаются серверные
 * RPC-гейты (module_disabled).
 */
describe('interpretPosEntitlement', () => {
  it('true → ok', () => {
    expect(interpretPosEntitlement(true, null)).toBe('ok')
  })

  it('false → missing (продукт pos не активирован/приостановлен)', () => {
    expect(interpretPosEntitlement(false, null)).toBe('missing')
  })

  it('ошибка сети/RPC не блокирует кассу', () => {
    expect(interpretPosEntitlement(null, { code: 'PGRST301' })).toBe('unknown')
  })

  it('база до 105 (функции нет) не блокирует кассу', () => {
    expect(interpretPosEntitlement(null, { code: '42883' })).toBe('unknown')
  })

  it('неожиданный payload не блокирует кассу', () => {
    expect(interpretPosEntitlement('yes', null)).toBe('unknown')
    expect(interpretPosEntitlement(null, null)).toBe('unknown')
    expect(interpretPosEntitlement(undefined, null)).toBe('unknown')
  })
})
