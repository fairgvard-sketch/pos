import { useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import { discountAmount, type CartDiscount } from '../../store/cartStore'
import NumPad from '../../components/NumPad'

interface Props {
  subtotal: number
  current: CartDiscount | null
  onApply: (d: CartDiscount | null) => void
  onCancel: () => void
}

/** Диалог скидки на весь заказ: % или фикс. сумма + необязательная причина. */
export default function DiscountSheet({ subtotal, current, onApply, onCancel }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [type, setType] = useState<'percent' | 'fixed'>(current?.type ?? 'percent')
  // percent храним как строку числа, fixed — как ₪-строку
  const [raw, setRaw] = useState(() => {
    if (!current) return ''
    return current.type === 'percent' ? String(current.value) : String(current.value / 100)
  })
  const [reason, setReason] = useState(current?.reason ?? '')

  // Значение в единицах type: percent → целые %, fixed → агороты
  const value =
    type === 'percent'
      ? (/^\d{1,3}$/.test(raw.trim()) ? parseInt(raw, 10) : null)
      : parseMoney(raw)

  const valid = value !== null && value > 0 && (type !== 'percent' || value <= 100)
  const preview = valid ? discountAmount(subtotal, { type, value: value!, reason }) : 0

  function apply() {
    if (!valid) return
    onApply({ type, value: value!, reason: reason.trim() })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-md p-6 animate-[rise-in_0.2s_ease-out]">
        <h2 className="text-lg font-black text-gray-900 mb-4">{t(lang, 'discountTitle')}</h2>

        {/* Переключатель типа */}
        <div className="grid grid-cols-2 gap-1 bg-gray-50 border border-gray-100 rounded-xl p-0.5 mb-4">
          {(['percent', 'fixed'] as const).map((tp) => (
            <button
              key={tp}
              onClick={() => { setType(tp); setRaw('') }}
              className={`h-11 rounded-lg text-sm font-semibold transition-all ${
                type === tp
                  ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              {tp === 'percent' ? t(lang, 'discountPercent') + ' %' : t(lang, 'discountFixed') + ' ₪'}
            </button>
          ))}
        </div>

        <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'discountValue')}</label>
        {/* Дисплей значения — крупный, редактируется нампадом ниже */}
        <div className="flex items-center justify-between rounded-2xl border border-gray-200 bg-gray-50 px-4 h-14 mb-3">
          <span className="text-2xl font-black text-gray-900 tabular-nums">{raw || '0'}</span>
          <span className="text-gray-400 font-semibold text-lg">{type === 'percent' ? '%' : '₪'}</span>
        </div>

        <NumPad value={raw} onChange={setRaw} decimal={type === 'fixed'} />

        <input
          className="input mt-4"
          placeholder={t(lang, 'discountReasonPh')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        {/* Предпросмотр вычета */}
        <div className="flex justify-between items-baseline my-4 px-1">
          <span className="text-sm text-gray-500">{t(lang, 'discountLabel')}</span>
          <span className="text-2xl font-black text-gray-900 tabular-nums">
            −{formatMoney(preview, lang)}
          </span>
        </div>

        <button onClick={apply} disabled={!valid} className="btn-primary w-full !py-3.5 !rounded-2xl">
          {t(lang, 'applyDiscount')}
        </button>
        {current && (
          <button onClick={() => onApply(null)} className="btn-ghost w-full mt-2 !text-red-500">
            {t(lang, 'removeDiscount')}
          </button>
        )}
        <button onClick={onCancel} className="btn-ghost w-full mt-1">
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  )
}
