import { t, type TranslationKey } from '../../lib/i18n'
import type { DrawerReason } from './api'

/** Подпись причины открытия ящика (журнал смены, будущие отчёты) */
export function drawerReasonLabel(lang: 'ru' | 'he', reason: DrawerReason): string {
  const key: Record<DrawerReason, TranslationKey> = {
    sale: 'drawerReasonSale',
    refund: 'drawerReasonRefund',
    cash_in: 'drawerReasonCashIn',
    cash_out: 'drawerReasonCashOut',
    shift_open: 'drawerReasonShiftOpen',
    shift_close: 'drawerReasonShiftClose',
    no_sale: 'drawerReasonNoSale',
    test: 'drawerReasonTest',
  }
  return t(lang, key[reason])
}
