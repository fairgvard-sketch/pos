import type { TranslationKey } from '../../lib/i18n'

/**
 * Реестр настроек v2: категории левой навигации + плоский индекс
 * строк для поиска. Клик по результату поиска ведёт в категорию
 * (и деталь, если настройка живёт в drill-down).
 *
 * На терминале остаются device-scoped настройки (эта касса: оплата у
 * стойки, печать, безопасность устройства) плюс лояльность: программу
 * правят прямо за кассой, где ею и пользуются (113). Остальное уровня
 * точки/бизнеса — НДС, сотрудники, онлайн-заказы, брони, реквизиты
 * чека, смена, UF-экспорт — живёт в веб-кабинете ANGLE.
 */

export type CategoryId = 'payments' | 'receipts' | 'loyalty' | 'device'

export type DetailId = 'tipping' | 'quick-amounts' | 'pay-methods'

export const CATEGORIES: { id: CategoryId; label: TranslationKey }[] = [
  { id: 'payments', label: 'catPayments' },
  { id: 'receipts', label: 'catReceipts' },
  { id: 'loyalty', label: 'catLoyalty' },
  { id: 'device', label: 'catDevice' },
]

export interface SearchEntry {
  cat: CategoryId
  detail?: DetailId
  path?: string
  label: TranslationKey
  hint?: TranslationKey
}

export const SEARCH_INDEX: SearchEntry[] = [
  { cat: 'payments', detail: 'pay-methods', label: 'payMethodsTitle', hint: 'payMethodsHint' },
  { cat: 'payments', detail: 'quick-amounts', label: 'quickAmountsTitle', hint: 'quickAmountsHint' },
  { cat: 'payments', label: 'paymentSoundTitle', hint: 'paymentSoundHint' },
  { cat: 'payments', label: 'offlinePayTitle', hint: 'offlinePayHint' },
  { cat: 'payments', detail: 'tipping', label: 'tipTitle', hint: 'collectTipsHint' },
  { cat: 'payments', detail: 'tipping', label: 'tipPresetsTitle' },
  { cat: 'payments', detail: 'tipping', label: 'tipSmartTitle' },
  { cat: 'receipts', label: 'printModeTitle', hint: 'printModeHint' },
  { cat: 'receipts', label: 'autoPrintTitle', hint: 'autoPrintHint' },
  { cat: 'receipts', label: 'receiptPromptTitle', hint: 'receiptPromptHint' },
  { cat: 'receipts', label: 'kitchenTicketTitle', hint: 'kitchenTicketHint' },
  { cat: 'loyalty', label: 'loyaltyTitle', hint: 'loyaltyHint' },
  { cat: 'loyalty', label: 'stampsGoalLabel', hint: 'stampsGoalHint' },
  { cat: 'loyalty', label: 'pointsPercentLabel', hint: 'pointsPercentHint' },
  { cat: 'loyalty', label: 'minRedeemLabel' },
  { cat: 'loyalty', path: '/guests', label: 'guestsTitle', hint: 'guestsSearchHint' },
  { cat: 'device', label: 'autoLock', hint: 'autoLockHint' },
  { cat: 'device', label: 'lockAfterSale', hint: 'lockAfterSaleHint' },
  { cat: 'device', label: 'deviceName', hint: 'deviceNameHint' },
  { cat: 'device', label: 'printBridgeStatus' },
  { cat: 'device', label: 'testPrint' },
  { cat: 'device', label: 'appVersion' },
  { cat: 'device', label: 'changePassword', hint: 'devicePasswordHint' },
  { cat: 'device', path: '/settings/floor-plan', label: 'floorPlanTitle', hint: 'floorPlanSettingsHint' },
  { cat: 'device', path: '/settings/go-live', label: 'goLiveTitle', hint: 'goLiveSearchHint' },
  { cat: 'device', label: 'signOutDevice' },
]
