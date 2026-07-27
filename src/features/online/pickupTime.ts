/**
 * Время самовывоза «HH:MM» → ISO.
 *
 * Раньше подставлялась всегда сегодняшняя дата: гость, заказывающий в
 * 23:50 на 00:30, получал время на 23 часа В ПРОШЛОМ — сервер трактовал
 * это как «как можно скорее», хотя человек имел в виду ночь.
 *
 * Прошедшее время считаем завтрашним. Небольшой допуск назад оставляем:
 * гость мог выбрать «через 5 минут», пока заполнял контакты, и минута
 * разницы не должна переносить заказ на сутки вперёд.
 */

/** Насколько время может отстать от «сейчас» и всё ещё считаться сегодняшним */
const PAST_TOLERANCE_MS = 5 * 60_000

export function pickupTimeToIso(time: string, now = new Date()): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null

  const target = new Date(now)
  target.setHours(hours, minutes, 0, 0)

  if (target.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    target.setDate(target.getDate() + 1)
  }

  return target.toISOString()
}
