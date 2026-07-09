import { useEffect, useState } from 'react'

/**
 * Напоминание о закрытии смены (настройка точки: Смена → close_reminder,
 * 'HH:MM' локального времени). Пора напоминать, когда смена открыта и
 * назначенное время сегодня уже прошло. Смена, открытая ПОСЛЕ этого
 * времени (например, вечерняя), напоминание не получает.
 */
export function closeReminderDue(
  openedAt: string | undefined,
  reminder: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!openedAt || !reminder) return false
  const [h, m] = reminder.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false
  const target = new Date(now)
  target.setHours(h, m, 0, 0)
  return now >= target && new Date(openedAt) < target
}

/** Реактивная версия: пересчитывается раз в минуту */
export function useCloseReminder(
  openedAt: string | undefined,
  reminder: string | null | undefined
): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return closeReminderDue(openedAt, reminder, new Date(now))
}
