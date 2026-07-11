import type { Lang } from './i18n'
import { t } from './i18n'

/**
 * Способы оплаты (046). cash/card — базовые, всегда включены;
 * кошельки (Cibus / Tenbis / Bit) включаются на кассе
 * (Настройки → Оплата → Способы оплаты). Учётная версия: оплату
 * кошельком кассир проводит в стороннем приложении и фиксирует
 * способ здесь — сверка с выплатами по разбивке в X/Z-отчёте.
 */
export type PayMethodId = 'cash' | 'card' | 'cibus' | 'tenbis' | 'bit'

export const WALLET_METHODS: PayMethodId[] = ['cibus', 'tenbis', 'bit']

/** Название способа на языке интерфейса (незнакомый метод — как есть) */
export function payMethodLabel(lang: Lang, m: PayMethodId | string): string {
  switch (m) {
    case 'cash': return t(lang, 'payCash')
    case 'card': return t(lang, 'payCard')
    case 'cibus': return t(lang, 'payCibus')
    case 'tenbis': return t(lang, 'payTenbis')
    case 'bit': return t(lang, 'payBit')
    default: return String(m)
  }
}

/** Название способа на чеке — всегда иврит (фискальный документ) */
export function receiptMethodLabel(m: PayMethodId | string): string {
  switch (m) {
    case 'cash': return 'מזומן'
    case 'card': return 'אשראי'
    case 'cibus': return 'סיבוס'
    case 'tenbis': return 'תן ביס'
    case 'bit': return 'ביט'
    default: return String(m)
  }
}

/** Иконка способа (кошельки рисуются карточной иконкой) */
export function payMethodIcon(m: PayMethodId | string): 'cash' | 'card' {
  return m === 'cash' ? 'cash' : 'card'
}
