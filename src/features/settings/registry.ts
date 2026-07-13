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
  | 'staff'
  | 'business'
  | 'device'

export type DetailId = 'tipping' | 'service-mode' | 'online-orders' | 'reservations' | 'loyalty' | 'guests' | 'perms' | 'receipt-details' | 'quick-amounts' | 'pay-methods' | 'profile'

export const CATEGORIES: { id: CategoryId; label: TranslationKey }[] = [
  { id: 'payments', label: 'catPayments' },
  { id: 'receipts', label: 'catReceipts' },
  { id: 'service', label: 'catService' },
  { id: 'shift', label: 'catShift' },
  { id: 'staff', label: 'catStaff' },
  { id: 'business', label: 'catBusiness' },
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
  { cat: 'payments', label: 'serviceChargeTitle', hint: 'serviceChargeHint' },
  { cat: 'payments', label: 'offlinePayTitle', hint: 'offlinePayHint' },
  { cat: 'payments', label: 'customerMgmtTitle', hint: 'customerMgmtHint' },
  { cat: 'payments', detail: 'tipping', label: 'tipTitle', hint: 'collectTipsHint' },
  { cat: 'payments', detail: 'tipping', label: 'tipPresetsTitle' },
  { cat: 'payments', detail: 'tipping', label: 'tipSmartTitle' },
  { cat: 'payments', detail: 'loyalty', label: 'loyaltyTitle', hint: 'loyaltyHint' },
  { cat: 'payments', detail: 'guests', label: 'guestsTitle' },
  { cat: 'payments', label: 'vatRateTitle', hint: 'vatRateHint' },
  { cat: 'receipts', label: 'printModeTitle', hint: 'printModeHint' },
  { cat: 'receipts', label: 'autoPrintTitle', hint: 'autoPrintHint' },
  { cat: 'receipts', label: 'receiptPromptTitle', hint: 'receiptPromptHint' },
  { cat: 'receipts', label: 'kitchenTicketTitle', hint: 'kitchenTicketHint' },
  { cat: 'receipts', label: 'printModifiersTitle', hint: 'printModifiersHint' },
  { cat: 'receipts', label: 'receiptCopiesTitle', hint: 'receiptCopiesHint' },
  { cat: 'service', detail: 'service-mode', label: 'serviceModeTitle', hint: 'serviceModeHint' },
  { cat: 'service', path: '/settings/floor-plan', label: 'floorPlanTitle', hint: 'floorPlanSettingsHint' },
  { cat: 'service', detail: 'online-orders', label: 'onlineOrders', hint: 'onlineSettingsToggleHint' },
  { cat: 'service', detail: 'online-orders', label: 'onlineLinkTitle', hint: 'onlineLinkHint' },
  { cat: 'service', detail: 'reservations', label: 'reservationsTitle', hint: 'reservationsToggleHint' },
  { cat: 'service', detail: 'reservations', label: 'reserveLinkTitle', hint: 'reserveLinkHint' },
  { cat: 'shift', label: 'defaultFloatTitle', hint: 'defaultFloatHint' },
  { cat: 'shift', label: 'closeReminderTitle', hint: 'closeReminderHint' },
  { cat: 'shift', label: 'cashWarnTitle', hint: 'cashWarnHint' },
  { cat: 'staff', label: 'staffTitle', hint: 'staffHint' },
  { cat: 'staff', detail: 'perms', label: 'permsTitle', hint: 'permsHint' },
  { cat: 'device', label: 'autoLock', hint: 'autoLockHint' },
  { cat: 'device', label: 'lockAfterSale', hint: 'lockAfterSaleHint' },
  { cat: 'business', detail: 'profile', label: 'profileTitle', hint: 'profileHint' },
  { cat: 'business', detail: 'receipt-details', label: 'receiptDetailsTitle', hint: 'receiptDetailsHint' },
  { cat: 'business', label: 'menu', hint: 'menuAdminHint' },
  { cat: 'business', label: 'dashboard', hint: 'dashboardHint' },
  { cat: 'device', label: 'deviceName', hint: 'deviceNameHint' },
  { cat: 'device', label: 'printBridgeStatus' },
  { cat: 'device', label: 'testPrint' },
  { cat: 'device', label: 'appVersion' },
  { cat: 'device', label: 'signOutDevice' },
]
