import type { Lang } from './i18n'

/**
 * Все денежные суммы в системе — ЦЕЛЫЕ агороты (1₪ = 100 агорот).
 * Float-математика для денег запрещена: 0.1 + 0.2 !== 0.3.
 * Конвертация в шекели — только на границе отображения.
 */
export type Agorot = number

/** 1250 агорот → "12.50 ₪" */
export function formatMoney(agorot: Agorot, lang: Lang): string {
  const shekels = agorot / 100
  return `${shekels.toLocaleString(lang === 'he' ? 'he-IL' : 'ru-RU', {
    minimumFractionDigits: agorot % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })} ₪`
}

/** Список сумм → "10/12/14 ₪" (символ валюты один раз в конце) */
export function formatMoneyList(agorotList: Agorot[], lang: Lang): string {
  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  const nums = agorotList.map((a) =>
    (a / 100).toLocaleString(locale, {
      minimumFractionDigits: a % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    })
  )
  return `${nums.join('/')} ₪`
}

/** Пользовательский ввод "12.50" → 1250 агорот */
export function parseMoney(input: string): Agorot | null {
  const normalized = input.replace(',', '.').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
  return Math.round(parseFloat(normalized) * 100)
}

/** Процент от суммы, округление до агорота */
export function percentOf(agorot: Agorot, pct: number): Agorot {
  return Math.round((agorot * pct) / 100)
}

/**
 * Разделить сумму на n равных долей БЕЗ потери агорот: первые
 * (total mod n) долей на 1 агорот больше, поэтому сумма частей
 * точно равна total (деньги — целые агороты, инвариант №1).
 * Пример: splitEvenly(10000, 3) → [3334, 3333, 3333].
 */
export function splitEvenly(total: Agorot, n: number): Agorot[] {
  if (n < 1) return [total]
  const base = Math.floor(total / n)
  const remainder = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0))
}

/**
 * Подгонка чаевых: итог к оплате (total + tip) — целое число шекелей
 * (ближайший шекель). Чаевые не бывают отрицательными.
 *
 * enabled (Square: Allow Round-up Tipping) — настройка кассы. Выкл:
 * возвращаем чаевые как есть (округляем до агорота), без подгонки итога.
 */
export function roundTipToWholeTotal(total: Agorot, tip: Agorot, enabled = true): Agorot {
  if (!enabled) return Math.max(Math.round(tip), 0)
  return Math.max(Math.round((total + tip) / 100) * 100 - total, 0)
}
