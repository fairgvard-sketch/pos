import { describe, it, expect } from 'vitest'
import { shiftOverdue } from './overdue'

/** Локальная дата без TZ-сюрпризов ISO-строк */
function d(y: number, mo: number, day: number, h: number, m = 0): Date {
  return new Date(y, mo - 1, day, h, m)
}

describe('shiftOverdue — границы операционного дня', () => {
  const opened = d(2026, 7, 17, 20, 0).toISOString() // вечерняя смена 20:00

  it('до границы (03:59) — не просрочена', () => {
    expect(shiftOverdue(opened, '04:00', d(2026, 7, 18, 3, 59)).daysCrossed).toBe(0)
  })

  it('после границы (04:01) — один операционный день', () => {
    const info = shiftOverdue(opened, '04:00', d(2026, 7, 18, 4, 1))
    expect(info.daysCrossed).toBe(1)
    expect(info.hours).toBe(8) // 20:00 → 04:01
  })

  it('вторая граница — два дня', () => {
    expect(shiftOverdue(opened, '04:00', d(2026, 7, 19, 4, 1)).daysCrossed).toBe(2)
  })

  it('смена, открытая ПОСЛЕ границы (05:00), ждёт границу следующего дня', () => {
    const morning = d(2026, 7, 18, 5, 0).toISOString()
    expect(shiftOverdue(morning, '04:00', d(2026, 7, 18, 23, 0)).daysCrossed).toBe(0)
    expect(shiftOverdue(morning, '04:00', d(2026, 7, 19, 4, 1)).daysCrossed).toBe(1)
  })

  it('кастомная граница 06:00 сдвигает порог', () => {
    expect(shiftOverdue(opened, '06:00', d(2026, 7, 18, 5, 0)).daysCrossed).toBe(0)
    expect(shiftOverdue(opened, '06:00', d(2026, 7, 18, 6, 1)).daysCrossed).toBe(1)
  })

  it('null/битый cutoff — дефолт 04:00', () => {
    expect(shiftOverdue(opened, null, d(2026, 7, 18, 4, 1)).daysCrossed).toBe(1)
    expect(shiftOverdue(opened, 'мусор', d(2026, 7, 18, 4, 1)).daysCrossed).toBe(1)
  })

  it('нет смены / битая дата — нули', () => {
    expect(shiftOverdue(undefined, '04:00')).toEqual({ daysCrossed: 0, hours: 0 })
    expect(shiftOverdue('not-a-date', '04:00')).toEqual({ daysCrossed: 0, hours: 0 })
  })
})
