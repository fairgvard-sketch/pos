import { useEffect, useState } from 'react'
import { captureMessage } from '../../lib/telemetry'

/**
 * Защита от висящих смен (P1): смена не закрывается автоматически, но и не
 * должна тихо жить днями. Граница операционного дня — settings.shift.day_cutoff
 * ('HH:MM', по умолчанию 04:00): открытая смена, пересёкшая границу, считается
 * просроченной — бейдж на всех рабочих экранах, баннер на странице смены,
 * телеметрия shift_overdue.
 */

export const DEFAULT_DAY_CUTOFF = '04:00'

export interface ShiftOverdueInfo {
  /** Сколько границ операционного дня пересекла открытая смена (0 = всё ок) */
  daysCrossed: number
  /** Длительность смены, полных часов */
  hours: number
}

const NONE: ShiftOverdueInfo = { daysCrossed: 0, hours: 0 }

/** Чистая математика границ — для расчёта и тестов */
export function shiftOverdue(
  openedAt: string | undefined,
  cutoff: string | null | undefined,
  now: Date = new Date()
): ShiftOverdueInfo {
  if (!openedAt) return NONE
  const opened = new Date(openedAt)
  if (Number.isNaN(opened.getTime()) || now <= opened) return NONE

  const [h, m] = (cutoff || DEFAULT_DAY_CUTOFF).split(':').map(Number)
  const cutH = Number.isFinite(h) ? h : 4
  const cutM = Number.isFinite(m) ? m : 0

  // Первая граница опердня строго ПОСЛЕ открытия смены
  const first = new Date(opened)
  first.setHours(cutH, cutM, 0, 0)
  if (first <= opened) first.setDate(first.getDate() + 1)

  const daysCrossed =
    now < first ? 0 : 1 + Math.floor((now.getTime() - first.getTime()) / 86_400_000)
  const hours = Math.floor((now.getTime() - opened.getTime()) / 3_600_000)
  return { daysCrossed, hours }
}

/**
 * Реактивная версия: пересчёт раз в минуту; при пересечении границы шлёт
 * shift_overdue в телеметрию (fingerprint дедупит повторы того же дня).
 */
export function useShiftOverdue(
  openedAt: string | undefined,
  cutoff: string | null | undefined
): ShiftOverdueInfo {
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const info = shiftOverdue(openedAt, cutoff, new Date(nowTs))

  const { daysCrossed } = info
  useEffect(() => {
    if (daysCrossed >= 1 && openedAt) {
      captureMessage('shift', `shift_overdue: days=${daysCrossed} opened_at=${openedAt}`)
    }
  }, [daysCrossed, openedAt])

  return info
}
