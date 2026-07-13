import { useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t, formatDate, type Lang } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import type { Location } from '../../types'
import { fetchReceipt, type Receipt } from './api'
import { autoPrintReceipt, autoPrintLocalReceipt } from './printService'
import ReceiptSheet from './ReceiptSheet'
import Icon from '../../components/Icon'
import NumPad from '../../components/NumPad'

interface Props {
  orderId: string
  location?: Location
  /** Офлайн: временный чек уже собран на кассе — не ходим за ним в сеть */
  receipt?: Receipt
  /** Выбор сделан (или чек закрыт) — продолжить поток продажи */
  onDone: () => void
}

/** Телефон → формат wa.me: только цифры, израильский 05x → 9725x */
function waPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0')) return '972' + digits.slice(1)
  return digits
}

/** Текстовая версия чека для отправки в мессенджер */
function buildReceiptText(r: Receipt, location: Location | undefined, lang: Lang): string {
  const out: string[] = []
  const biz = location?.receipt_business_name || location?.name
  if (biz) out.push(biz)
  if (location?.receipt_tax_id) out.push(`${t(lang, 'taxId')} ${location.receipt_tax_id}`)
  if (r.receipt_number !== null) out.push(`${t(lang, 'receiptNo')} №${r.receipt_number}`)
  out.push(formatDate(r.paid_at ?? r.created_at, lang))
  out.push('—'.repeat(16))
  for (const l of r.lines) {
    const name = l.variant_name ? `${l.name} · ${l.variant_name}` : l.name
    out.push(`${l.qty}× ${name}  ${formatMoney(l.line_total, lang)}`)
    for (const m of l.modifiers) out.push(`   + ${m.name}`)
  }
  out.push('—'.repeat(16))
  if (r.discount_amount > 0) out.push(`${t(lang, 'discount')}: -${formatMoney(r.discount_amount, lang)}`)
  if (r.loyalty_discount > 0) out.push(`${t(lang, 'loyaltyLabel')}: -${formatMoney(r.loyalty_discount, lang)}`)
  out.push(`${t(lang, 'toPay')}: ${formatMoney(r.total, lang)}`)
  out.push(`${t(lang, 'vatIncl')} ${r.vat_rate}%: ${formatMoney(r.vat_amount, lang)}`)
  if (location?.receipt_footer) out.push(location.receipt_footer)
  return out.join('\n')
}

/**
 * После оплаты: «Как выдать чек?» — печать / на телефон (WhatsApp) / без чека.
 * Включается настройкой кассы receiptPrompt (заменяет автопечать).
 */
export default function ReceiptChoiceSheet({ orderId, location, receipt: localReceipt, onDone }: Props) {
  const lang = useLangStore((s) => s.lang)
  const printMode = useDeviceStore((s) => s.printMode)
  // 'receipt' — тихая печать не удалась, показываем чек с браузерной печатью
  const [step, setStep] = useState<'choose' | 'phone' | 'receipt'>('choose')
  const [phoneStr, setPhoneStr] = useState('')
  const [busy, setBusy] = useState(false)

  async function choosePaper() {
    setBusy(true)
    const ok = localReceipt
      ? await autoPrintLocalReceipt(localReceipt, location, printMode === 'rawbt')
      : await autoPrintReceipt(orderId, location, printMode === 'rawbt')
    setBusy(false)
    if (ok) onDone()
    else setStep('receipt') // тихого пути нет — чек с кнопкой печати
  }

  async function sendToPhone() {
    const phone = waPhone(phoneStr)
    if (phone.length < 11) return
    setBusy(true)
    try {
      const receipt = localReceipt ?? (await fetchReceipt(orderId))
      const text = buildReceiptText(receipt, location, lang)
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank')
      onDone()
    } catch {
      setBusy(false)
    }
  }

  if (step === 'receipt') {
    return <ReceiptSheet orderId={orderId} receipt={localReceipt} onClose={onDone} />
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 animate-[rise-in_0.2s_ease-out]">
        <h2 className="text-lg font-bold text-gray-900 text-center mb-5">
          {step === 'choose' ? t(lang, 'receiptHowTitle') : t(lang, 'customerPhone')}
        </h2>

        {step === 'choose' && (
          <div className="space-y-2">
            <button
              onClick={choosePaper}
              disabled={busy}
              className="w-full h-16 rounded-2xl bg-gray-900 text-white flex items-center gap-4 px-5
                         font-semibold transition-all active:scale-[0.97] disabled:opacity-60"
            >
              <Icon name="note" size={24} />
              {t(lang, 'receiptPaper')}
            </button>
            <button
              onClick={() => setStep('phone')}
              disabled={busy}
              className="w-full h-16 rounded-2xl border border-gray-200 hover:border-gray-900 text-gray-900
                         flex items-center gap-4 px-5 font-semibold transition-all active:scale-[0.97]"
            >
              <Icon name="customers" size={24} />
              <span className="flex-1 text-start">{t(lang, 'receiptByPhone')}</span>
              <span className="text-xs font-medium text-gray-400">{t(lang, 'receiptByPhoneHint')}</span>
            </button>
            <button
              onClick={onDone}
              disabled={busy}
              className="w-full h-14 rounded-2xl text-gray-500 hover:bg-gray-50 hover:text-gray-900
                         font-semibold transition-all active:scale-[0.97]"
            >
              {t(lang, 'receiptNone')}
            </button>
          </div>
        )}

        {step === 'phone' && (
          <div className="space-y-4">
            {/* Номер набирается нумпадом — LTR даже в иврите */}
            <div
              dir="ltr"
              className={`h-14 rounded-2xl bg-gray-50 border border-gray-200 flex items-center justify-center
                          text-2xl font-bold tabular-nums tracking-wider ${phoneStr ? 'text-gray-900' : 'text-gray-300'}`}
            >
              {phoneStr || '05_-___-____'}
            </div>

            <NumPad
              value={phoneStr}
              onChange={(v) => v.length <= 15 && setPhoneStr(v)}
              decimal={false}
              allowLeadingZeros
            />

            <button
              onClick={sendToPhone}
              disabled={busy || waPhone(phoneStr).length < 11}
              className="btn-primary w-full !py-4 !text-base !rounded-2xl"
            >
              {t(lang, 'sendReceipt')}
            </button>
            <button
              onClick={() => setStep('choose')}
              disabled={busy}
              className="btn-ghost w-full"
            >
              {t(lang, 'back')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
