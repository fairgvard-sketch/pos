import { describe, it, expect } from 'vitest'
import { historySince } from './api'

/**
 * Границы периодов истории (113): 'today' — с локальной полуночи,
 * скользящие окна — ровно N суток назад от «сейчас».
 */
describe('historySince', () => {
  const now = new Date('2026-07-28T15:30:00+03:00')

  it('today — локальная полночь, а не UTC', () => {
    const since = new Date(historySince('today', now))
    expect(since.getFullYear()).toBe(now.getFullYear())
    expect(since.getMonth()).toBe(now.getMonth())
    expect(since.getDate()).toBe(now.getDate())
    expect(since.getHours()).toBe(0)
    expect(since.getMinutes()).toBe(0)
    expect(since.getSeconds()).toBe(0)
  })

  it('today не в будущем и не старше суток', () => {
    const diff = now.getTime() - Date.parse(historySince('today', now))
    expect(diff).toBeGreaterThanOrEqual(0)
    expect(diff).toBeLessThan(24 * 3600_000)
  })

  it('7d и 30d — ровно N суток назад', () => {
    expect(now.getTime() - Date.parse(historySince('7d', now))).toBe(7 * 24 * 3600_000)
    expect(now.getTime() - Date.parse(historySince('30d', now))).toBe(30 * 24 * 3600_000)
  })

  it('более длинный период всегда начинается раньше', () => {
    const today = Date.parse(historySince('today', now))
    const d7 = Date.parse(historySince('7d', now))
    const d30 = Date.parse(historySince('30d', now))
    expect(d7).toBeLessThan(today)
    expect(d30).toBeLessThan(d7)
  })
})
