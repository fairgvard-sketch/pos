import type { TranslationKey } from '../../lib/i18n'

/**
 * Реестр настроек v2: категории левой навигации + плоский индекс
 * строк для поиска. Клик по результату поиска ведёт в категорию
 * (и деталь, если настройка живёт в drill-down).
 */

export type CategoryId =
  | 'payments'
  | 'receipts'
  | 'service'
  | 'shift'
  | 'loyalty'
  | 'staff'
  | 'security'
  | 'business'
  | 'device'

export type DetailId = 'tipping' | 'tables' | 'guests' | 'perms' | 'receipt-details' | 'quick-amounts'

export const CATEGORIES: { id: CategoryId; label: TranslationKey }[] = [
  { id: 'payments', label: 'catPayments' },
  { id: 'receipts', label: 'catReceipts' },
  { id: 'service', label: 'catService' },
  { id: 'shift', label: 'catShift' },
  { id: 'loyalty', label: 'catLoyalty' },
  { id: 'staff', label: 'catStaff' },
  { id: 'security', label: 'catSecurity' },
  { id: 'business', label: 'catBusiness' },
  { id: 'device', label: 'catDevice' },
]

export interface SearchEntry {
  cat: CategoryId
  detail?: DetailId
  label: TranslationKey
  hint?: TranslationKey
}

export const SEARCH_INDEX: SearchEntry[] = [
  { cat: 'payments', label: 'firstPayTitle', hint: 'firstPayHint' },
  { cat: 'payments', detail: 'quick-amounts', label: 'quickAmountsTitle', hint: 'quickAmountsHint' },
  { cat: 'payments', label: 'paymentSoundTitle', hint: 'paymentSoundHint' },
  { cat: 'payments', label: 'serviceChargeTitle', hint: 'serviceChargeHint' },
  { cat: 'payments', label: 'offlinePayTitle', hint: 'offlinePayHint' },
  { cat: 'payments', label: 'customerMgmtTitle', hint: 'customerMgmtHint' },
  { cat: 'payments', detail: 'tipping', label: 'tipTitle', hint: 'collectTipsHint' },
  { cat: 'payments', detail: 'tipping', label: 'tipPresetsTitle' },
  { cat: 'payments', detail: 'tipping', label: 'tipSmartTitle' },
  { cat: 'receipts', label: 'printModeTitle', hint: 'printModeHint' },
  { cat: 'receipts', label: 'autoPrintTitle', hint: 'autoPrintHint' },
  { cat: 'receipts', label: 'receiptPromptTitle', hint: 'receiptPromptHint' },
  { cat: 'receipts', label: 'kitchenTicketTitle', hint: 'kitchenTicketHint' },
  { cat: 'receipts', label: 'printModifiersTitle', hint: 'printModifiersHint' },
  { cat: 'receipts', label: 'receiptCopiesTitle', hint: 'receiptCopiesHint' },
  { cat: 'service', label: 'serviceModeTitle', hint: 'serviceModeHint' },
  { cat: 'service', detail: 'tables', label: 'tablesManage' },
  { cat: 'shift', label: 'defaultFloatTitle', hint: 'defaultFloatHint' },
  { cat: 'shift', label: 'closeReminderTitle', hint: 'closeReminderHint' },
  { cat: 'shift', label: 'cashWarnTitle', hint: 'cashWarnHint' },
  { cat: 'loyalty', label: 'loyaltyTitle', hint: 'loyaltyHint' },
  { cat: 'loyalty', detail: 'guests', label: 'guestsTitle' },
  { cat: 'staff', label: 'staffTitle', hint: 'staffHint' },
  { cat: 'staff', detail: 'perms', label: 'permsTitle', hint: 'permsHint' },
  { cat: 'security', label: 'autoLock', hint: 'autoLockHint' },
  { cat: 'security', label: 'lockAfterSale', hint: 'lockAfterSaleHint' },
  { cat: 'business', label: 'vatRateTitle', hint: 'vatRateHint' },
  { cat: 'business', detail: 'receipt-details', label: 'receiptDetailsTitle', hint: 'receiptDetailsHint' },
  { cat: 'device', label: 'deviceName', hint: 'deviceNameHint' },
  { cat: 'device', label: 'printBridgeStatus' },
  { cat: 'device', label: 'testPrint' },
  { cat: 'device', label: 'appVersion' },
  { cat: 'device', label: 'signOutDevice' },
]
