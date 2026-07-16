import { roundTipToWholeTotal } from '../../lib/money'
import type { TipOption } from './TipSheet'

/**
 * Чистая математика чаевых (настройки кассы deviceStore → варианты TipSheet).
 * Вынесена из SellPage, чтобы тестироваться без React.
 */
export interface TipConfig {
  /** Проценты-пресеты (кнопки TipSheet) */
  presets: number[]
  /** База процента — итог без НДС (true) или с НДС (false) */
  beforeTax: boolean
  /** Подгонять каждый вариант так, чтобы total+tip был целым шекелем */
  roundUp: boolean
  /** Умный режим: на мелких заказах — фиксированные суммы вместо процентов */
  smartAmounts: boolean
  /** Порог «мелкого» заказа (агороты) */
  smartThreshold: number
  /** Фиксированные суммы умного режима (агороты) */
  smartFixed: number[]
}

/** База процента чаевых: итог с НДС или без (НДС включён в цену) */
export function tipPercentBase(total: number, vatRate: number, beforeTax: boolean): number {
  return beforeTax ? total - Math.round((total * vatRate) / (100 + vatRate)) : total
}

/**
 * Варианты чаевых для суммы: умный режим на мелких заказах — фиксированные ₪,
 * иначе проценты от базы. Каждый вариант подгоняется так, чтобы итог
 * к оплате (total + tip) был целым числом шекелей.
 */
export function buildTipOptions(total: number, vatRate: number, cfg: TipConfig): TipOption[] {
  if (cfg.smartAmounts && total <= cfg.smartThreshold) {
    return cfg.smartFixed
      .filter((a) => a > 0)
      .map((a) => ({ amount: roundTipToWholeTotal(total, a, cfg.roundUp) }))
  }
  const base = tipPercentBase(total, vatRate, cfg.beforeTax)
  return cfg.presets
    .filter((p) => p > 0)
    .map((p) => ({ percent: p, amount: roundTipToWholeTotal(total, Math.round((base * p) / 100), cfg.roundUp) }))
}
