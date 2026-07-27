import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'
import { formatMoney } from '../lib/money'
import type { PosEntitlement } from '../lib/posEntitlement'

/**
 * Тонкая плашка о конце пробного периода или об идущем grace-периоде.
 *
 * Правила горячего потока (CLAUDE.md): не модалка и не оверлей — заказ
 * должен собираться в три тапа, ничего перехватывать нельзя. Плашка
 * занимает одну строку над контентом, ничего не перекрывает и появляется
 * только когда до конца доступа осталось мало (shouldWarn).
 */
export default function BillingBanner({ entitlement }: { entitlement: PosEntitlement }) {
  const lang = useLangStore((s) => s.lang)
  const { state, daysLeft, invoiceNumber, invoiceTotalAgorot } = entitlement

  const isGrace = state === 'grace'

  // Grace — серьёзнее триала: доступ уже за пределами оплаченного периода.
  const tone = isGrace
    ? 'bg-amber-50 text-amber-900 border-amber-200'
    : 'bg-gray-50 text-gray-700 border-gray-200'

  const message = isGrace
    ? daysLeft === null
      ? t(lang, 'billingGraceNoDays')
      : t(lang, 'billingGraceDays').replace('{days}', String(daysLeft))
    : daysLeft === null
      ? t(lang, 'billingTrialNoDays')
      : t(lang, 'billingTrialDays').replace('{days}', String(daysLeft))

  const invoiceHint =
    invoiceNumber && invoiceTotalAgorot !== null
      ? `${invoiceNumber} · ${formatMoney(invoiceTotalAgorot, lang)}`
      : null

  return (
    <div
      className={`flex items-center justify-center gap-3 border-b px-4 py-2 text-sm ${tone}`}
      role="status"
    >
      <span className="font-medium">{message}</span>
      {invoiceHint && <span className="text-xs opacity-75">{invoiceHint}</span>}
    </div>
  )
}
