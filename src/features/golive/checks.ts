import type { Location } from '../../types'
import type { TranslationKey } from '../../lib/i18n'

/**
 * Запуск точки (go-live, P3-13): критические пробелы, без которых первая
 * продажа заблокирована. Блок действует только до подтверждения запуска —
 * точки, продававшие до появления фичи, помечены confirmed миграцией 084
 * (source='grandfather') и не блокируются никогда.
 *
 * Критерии сознательно узкие: имя бизнеса и ИНН — без них фискальный чек
 * неполноценен; пустой каталог — продавать нечего. НДС не критичен
 * (у ставки есть валидный ноль — Эйлат), печать/мост — предупреждения:
 * их отказ не делает продажу юридически некорректной.
 */
export type GoLiveGap = 'businessName' | 'taxId' | 'catalog'

/** Человекочитаемые названия пробелов — чек-лист и блок-экран продажи */
export const GAP_LABELS: Record<GoLiveGap, TranslationKey> = {
  businessName: 'goLiveBusinessName',
  taxId: 'goLiveTaxId',
  catalog: 'goLiveCatalog',
}

export function goLiveConfirmed(location: Location | undefined): boolean {
  return !!location?.settings?.go_live?.confirmed_at
}

/** Критические пробелы. itemsCount = null — каталог ещё не загружен, судить рано */
export function goLiveGaps(location: Location, itemsCount: number | null): GoLiveGap[] {
  const gaps: GoLiveGap[] = []
  if (!location.receipt_business_name?.trim()) gaps.push('businessName')
  if (!location.receipt_tax_id?.trim()) gaps.push('taxId')
  if (itemsCount === 0) gaps.push('catalog')
  return gaps
}

/**
 * Блокировать продажу: запуск не подтверждён и есть критические пробелы.
 * До загрузки location/каталога не блокируем — решение только по фактам.
 */
export function goLiveBlocked(location: Location | undefined, itemsCount: number | null): boolean {
  if (!location) return false
  if (goLiveConfirmed(location)) return false
  return goLiveGaps(location, itemsCount).length > 0
}
