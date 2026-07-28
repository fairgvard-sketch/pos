import { describe, expect, it } from 'vitest'
import { buildPickupSlots, type Hours } from './pickupSlots'

/**
 * Слоты строятся в таймзоне ТОЧКИ и только внутри часов работы: гость
 * не должен иметь возможности выбрать время, на которое заведение
 * закрыто (112). Даты в тестах — реальные дни недели:
 * 2026-07-27 — понедельник (dow=1), 2026-07-28 — вторник (dow=2).
 */
describe('buildPickupSlots', () => {
  const TZ = 'Asia/Jerusalem'
  /** Момент по израильскому времени (летом UTC+3) */
  const at = (iso: string) => new Date(`${iso}+03:00`)

  /** «HH:MM» слота в таймзоне точки */
  const labels = (slots: { label: string }[]) => slots.map((s) => s.label)

  it('слоты только внутри окна работы', () => {
    const hours: Hours = { 1: [['08:00', '20:00']] }
    const slots = buildPickupSlots(hours, TZ, at('2026-07-27T18:00:00'))
    const today = slots.filter((s) => s.day === 'today')

    expect(labels(today)[0]).toBe('18:15')
    expect(labels(today).at(-1)).toBe('19:45')
    // 20:00 — момент закрытия, слот на него не предлагается
    expect(labels(today)).not.toContain('20:00')
    expect(labels(today)).not.toContain('23:30')
  })

  it('прошедшие слоты отброшены', () => {
    const hours: Hours = { 1: [['08:00', '20:00']] }
    const slots = buildPickupSlots(hours, TZ, at('2026-07-27T18:00:00'))
    expect(labels(slots)).not.toContain('08:00')
    expect(labels(slots)).not.toContain('17:45')
  })

  it('после закрытия предлагаются слоты на завтра', () => {
    const hours: Hours = { 1: [['08:00', '20:00']], 2: [['09:00', '17:00']] }
    // 21:00 понедельника — сегодня уже закрыто
    const slots = buildPickupSlots(hours, TZ, at('2026-07-27T21:00:00'))

    expect(slots.every((s) => s.day === 'tomorrow')).toBe(true)
    expect(labels(slots)[0]).toBe('09:00')
    expect(labels(slots).at(-1)).toBe('16:45')
  })

  it('день без окон — закрыт, слотов нет', () => {
    // Вторник не описан: завтра закрыто, сегодня уже прошло
    const hours: Hours = { 1: [['08:00', '20:00']] }
    const slots = buildPickupSlots(hours, TZ, at('2026-07-27T21:00:00'))
    expect(slots).toEqual([])
  })

  it('окно через полночь не рвётся на границе суток', () => {
    const hours: Hours = { 1: [['20:00', '02:00']] }
    const slots = buildPickupSlots(hours, TZ, at('2026-07-27T23:00:00'))

    expect(labels(slots)).toContain('23:15')
    expect(labels(slots)).toContain('00:30')
    expect(labels(slots).at(-1)).toBe('01:45')
    // Слот после полуночи относится к завтрашней дате
    const after = slots.find((s) => s.label === '00:30')!
    expect(after.day).toBe('tomorrow')
    expect(new Date(after.iso).getUTCDate()).toBe(27) // 00:30 IDT = 21:30 UTC 27-го
  })

  it('несколько окон в одном дне (перерыв на обед)', () => {
    const hours: Hours = { 1: [['08:00', '12:00'], ['16:00', '20:00']] }
    const slots = buildPickupSlots(hours, TZ, at('2026-07-27T10:00:00'))
    const today = labels(slots.filter((s) => s.day === 'today'))

    expect(today).toContain('11:45')
    // Перерыв: с 12:00 до 16:00 слотов нет
    expect(today).not.toContain('12:00')
    expect(today).not.toContain('14:00')
    expect(today).toContain('16:00')
  })

  it('без расписания — приём в любое время', () => {
    const slots = buildPickupSlots(null, TZ, at('2026-07-27T18:00:00'))
    expect(labels(slots)).toContain('23:45')
    expect(slots.length).toBeGreaterThan(0)
  })

  it('битые окна пропускаются, а не роняют список', () => {
    const hours = {
      1: [['ерунда', '20:00'], ['18:00', '20:00']],
    } as unknown as Hours
    const slots = buildPickupSlots(hours, TZ, at('2026-07-27T17:00:00'))
    expect(labels(slots.filter((s) => s.day === 'today'))[0]).toBe('18:00')
  })

  it('слот отдаётся моментом времени, а не строкой «HH:MM»', () => {
    const hours: Hours = { 1: [['08:00', '20:00']] }
    const slots = buildPickupSlots(hours, TZ, at('2026-07-27T18:00:00'))
    // 18:15 по Израилю летом = 15:15 UTC
    expect(new Date(slots[0].iso).toISOString()).toBe('2026-07-27T15:15:00.000Z')
  })
})
