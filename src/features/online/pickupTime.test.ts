import { describe, expect, it } from 'vitest'
import { pickupTimeToIso } from './pickupTime'

/**
 * Гость в 23:50 выбирает 00:30 — это ночь, а не «23 часа назад».
 * Раньше подставлялась сегодняшняя дата, и сервер трактовал такой заказ
 * как «как можно скорее».
 */
describe('pickupTimeToIso', () => {
  const at = (iso: string) => new Date(iso)

  it('время позже текущего — сегодня', () => {
    const now = at('2026-07-27T10:00:00')
    const r = pickupTimeToIso('14:30', now)
    expect(new Date(r!).getDate()).toBe(27)
    expect(new Date(r!).getHours()).toBe(14)
  })

  it('время за полночь переносится на завтра', () => {
    const now = at('2026-07-27T23:50:00')
    const r = pickupTimeToIso('00:30', now)
    const d = new Date(r!)
    expect(d.getDate()).toBe(28)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(30)
  })

  it('только что прошедшее время остаётся сегодняшним', () => {
    // Гость выбрал 12:00, пока заполнял контакты — стало 12:02
    const now = at('2026-07-27T12:02:00')
    const r = pickupTimeToIso('12:00', now)
    expect(new Date(r!).getDate()).toBe(27)
  })

  it('давно прошедшее время — завтра', () => {
    const now = at('2026-07-27T18:00:00')
    const r = pickupTimeToIso('09:00', now)
    expect(new Date(r!).getDate()).toBe(28)
  })

  it('мусор и невозможное время отвергаются', () => {
    const now = at('2026-07-27T10:00:00')
    expect(pickupTimeToIso('', now)).toBeNull()
    expect(pickupTimeToIso('25:00', now)).toBeNull()
    expect(pickupTimeToIso('12:70', now)).toBeNull()
    expect(pickupTimeToIso('abc', now)).toBeNull()
  })
})
