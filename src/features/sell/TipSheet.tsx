import { useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import NumPad from '../../components/NumPad'

interface Props {
  /** Итог заказа (с НДС) — база процентов */
  total: number
  /** Пресеты в процентах (Настройки → Касса) */
  presets: number[]
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
export default function TipSheet({ total, presets, onCancel, onDone, busy }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [custom, setCustom] = useState(false)
  const [customStr, setCustomStr] = useState('')

  const customTip = customStr ? parseMoney(customStr) : null
  const percents = presets.filter((p) => p > 0)

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
              {/* Пресеты: 1 тап = выбрано, сразу к оплате */}
              <div className="grid grid-cols-3 gap-2">
                {percents.map((p) => {
                  const amt = Math.round((total * p) / 100)
                  return (
                    <button
                      key={p}
                      onClick={() => onDone(amt)}
                      disabled={busy}
                      className="h-20 rounded-2xl border border-gray-200 hover:border-gray-900 flex flex-col
                                 items-center justify-center gap-1 transition-all active:scale-[0.96]"
                    >
                      <span className="text-xl font-black text-gray-900">{p}%</span>
                      <span className="text-sm text-gray-500 tabular-nums">{formatMoney(amt, lang)}</span>
                    </button>
                  )
                })}
              </div>

              <button
                onClick={() => setCustom(true)}
                disabled={busy}
                className="btn-secondary w-full !py-3 !rounded-2xl"
              >
                {t(lang, 'tipCustom')}
              </button>

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
              {/* Своя сумма чаевых (₪, нумпадом) */}
              <div className="flex items-baseline justify-between px-1">
                <span className="text-sm text-gray-500">{t(lang, 'tipTitle')}</span>
                <span className={`text-3xl font-black tabular-nums ${customTip ? 'text-gray-900' : 'text-gray-300'}`}>
                  {formatMoney(customTip ?? 0, lang)}
                </span>
              </div>

              <NumPad value={customStr} onChange={setCustomStr} />

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
