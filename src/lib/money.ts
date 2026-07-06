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
