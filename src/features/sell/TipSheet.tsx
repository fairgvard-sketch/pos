import { useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney, roundTipToWholeTotal } from '../../lib/money'
import NumPad from '../../components/NumPad'

/** Вариант чаевых: процент (percent задан) или фиксированная сумма (умный режим) */
export interface TipOption {
  percent?: number
  amount: number
}

interface Props {
  /** Итог заказа (с НДС) — для шапки и подгонки под круглый итог */
  total: number
  /** База процента (итог с НДС или без — настройка кассы), для «своей суммы» в % */
  percentBase: number
  /** Готовые варианты (проценты от базы или фиксированные суммы — считает вызывающий) */
  options: TipOption[]
  /** Кнопка «Своя сумма» (настройка кассы) */
  allowCustom: boolean
  onCancel: () => void
  /** tip в агоротах; 0 = без чаевых */
  onDone: (tip: number) => void
  busy: boolean
}

/**
 * Шаг чаевых перед оплатой (Square: Collect Tips). Скорость прежде всего:
 * 1 тап по пресету или «Без чаевых» — сразу дальше, к способу оплаты.
 * Планшет разворачивается к гостю — суммы крупные, выбор очевиден.
 */
export default function TipSheet({ total, percentBase, options, allowCustom, onCancel, onDone, busy }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [custom, setCustom] = useState(false)
  // Своя сумма: процент от базы или фикс. сумма в ₪
  const [customType, setCustomType] = useState<'percent' | 'fixed'>('fixed')
  const [customStr, setCustomStr] = useState('')

  // Процент — целое 1..100; итог подгоняется до целых шекелей (как пресеты)
  const customPct = /^\d{1,3}$/.test(customStr.trim()) ? parseInt(customStr, 10) : null
  const pctValid = customPct !== null && customPct > 0 && customPct <= 100
  const customTip =
    customType === 'percent'
      ? pctValid
        ? roundTipToWholeTotal(total, Math.round((percentBase * customPct!) / 100))
        : null
      : customStr
        ? parseMoney(customStr)
        : null

  const shown = options.filter((o) => o.amount > 0)

  function resetCustom(type: 'percent' | 'fixed') {
    setCustomType(type)
    setCustomStr('')
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-[rise-in_0.2s_ease-out]">

        {/* Шапка: заголовок + сумма заказа + закрыть */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{t(lang, 'tipTitle')}</h2>
          <div className="flex items-center gap-4">
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-gray-500">{t(lang, 'toPay')}</span>
              <span className="text-2xl font-black text-gray-900 tabular-nums">{formatMoney(total, lang)}</span>
            </div>
            <button
              onClick={onCancel}
              disabled={busy}
              aria-label={t(lang, 'close')}
              className="w-11 h-11 -me-2 rounded-full flex items-center justify-center text-gray-400
                         hover:bg-gray-100 hover:text-gray-900 transition-all active:scale-[0.94]"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 5L15 15M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-6 flex flex-col gap-4">
          {!custom ? (
            <>
              {/* Пресеты: 1 тап = выбрано, сразу к оплате. Процент крупно +
                  сумма подписью; в умном режиме — сразу сумма крупно */}
              <div className="grid grid-cols-3 gap-2">
                {shown.map((o, i) => (
                  <button
                    key={i}
                    onClick={() => onDone(o.amount)}
                    disabled={busy}
                    className="h-20 rounded-2xl border border-gray-200 hover:border-gray-900 flex flex-col
                               items-center justify-center gap-1 transition-all active:scale-[0.96]"
                  >
                    {o.percent !== undefined ? (
                      <>
                        <span className="text-xl font-black text-gray-900">{o.percent}%</span>
                        <span className="text-sm text-gray-500 tabular-nums">{formatMoney(o.amount, lang)}</span>
                      </>
                    ) : (
                      <span className="text-xl font-black text-gray-900 tabular-nums">{formatMoney(o.amount, lang)}</span>
                    )}
                  </button>
                ))}
              </div>

              {allowCustom && (
                <button
                  onClick={() => setCustom(true)}
                  disabled={busy}
                  className="btn-secondary w-full !py-3 !rounded-2xl"
                >
                  {t(lang, 'tipCustom')}
                </button>
              )}

              <button
                onClick={() => onDone(0)}
                disabled={busy}
                className="btn-primary w-full !py-4 !text-base !rounded-2xl"
              >
                {t(lang, 'tipNone')}
              </button>
            </>
          ) : (
            <>
              {/* Своя сумма чаевых: процент от базы или ₪, нумпадом */}
              <div className="grid grid-cols-2 gap-1 bg-gray-50 border border-gray-100 rounded-xl p-0.5">
                {(['percent', 'fixed'] as const).map((tp) => (
                  <button
                    key={tp}
                    onClick={() => resetCustom(tp)}
                    disabled={busy}
                    className={`h-11 rounded-lg text-sm font-semibold transition-all ${
                      customType === tp
                        ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                        : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    {tp === 'percent' ? t(lang, 'discountPercent') + ' %' : t(lang, 'discountFixed') + ' ₪'}
                  </button>
                ))}
              </div>

              <div className="flex items-baseline justify-between px-1">
                {customType === 'percent' ? (
                  <span className={`text-3xl font-black tabular-nums ${pctValid ? 'text-gray-900' : 'text-gray-300'}`}>
                    {customStr || '0'}%
                  </span>
                ) : (
                  <span className="text-sm text-gray-500">{t(lang, 'tipTitle')}</span>
                )}
                <span className={`text-3xl font-black tabular-nums ${customTip ? 'text-gray-900' : 'text-gray-300'}`}>
                  {formatMoney(customTip ?? 0, lang)}
                </span>
              </div>

              <NumPad value={customStr} onChange={setCustomStr} decimal={customType === 'fixed'} />

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => { setCustom(false); setCustomStr('') }}
                  disabled={busy}
                  className="btn-secondary !py-4 !rounded-2xl"
                >
                  {t(lang, 'back')}
                </button>
                <button
                  onClick={() => customTip !== null && customTip > 0 && onDone(customTip)}
                  disabled={busy || !customTip}
                  className="btn-primary !py-4 !text-base !rounded-2xl"
                >
                  {t(lang, 'apply')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
