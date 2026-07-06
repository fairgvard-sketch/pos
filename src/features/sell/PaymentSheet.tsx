import { useMemo, useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { PaymentInput } from './api'

interface Props {
  total: number
  onCancel: () => void
  onPay: (payments: PaymentInput[]) => void
  busy: boolean
}

/** Быстрые купюры для расчёта сдачи (₪): округления вверх + типовые банкноты */
function quickCashOptions(total: number): number[] {
  const shekels = total / 100
  const opts = new Set<number>()
  opts.add(total) // без сдачи
  // Ближайшие «круглые» суммы вверх
  for (const step of [10, 20, 50, 100, 200]) {
    const rounded = Math.ceil(shekels / step) * step
    if (rounded * 100 >= total) opts.add(rounded * 100)
  }
  return [...opts].sort((a, b) => a - b).slice(0, 5)
}

export default function PaymentSheet({ total, onCancel, onPay, busy }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [mode, setMode] = useState<'choose' | 'cash'>('choose')
  const [tenderedStr, setTenderedStr] = useState('')

  const quick = useMemo(() => quickCashOptions(total), [total])
  const tendered = tenderedStr ? parseMoney(tenderedStr) : null
  const change = tendered !== null && tendered >= total ? tendered - total : null

  function payCard() {
    onPay([{ method: 'card', amount: total }])
  }

  function payCash(tenderedAmount: number) {
    onPay([{
      method: 'cash',
      amount: total,
      tendered: tenderedAmount,
      change_due: tenderedAmount - total,
    }])
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-md p-6 animate-[rise-in_0.2s_ease-out]">
        <div className="flex justify-between items-baseline mb-5">
          <span className="text-sm text-gray-400">{t(lang, 'toPay')}</span>
          <span className="text-3xl font-black text-gray-900 tabular-nums">{formatMoney(total, lang)}</span>
        </div>

        {mode === 'choose' && (
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMode('cash')}
              disabled={busy}
              className="rounded-2xl border-2 border-gray-200 hover:border-gray-900 py-8 flex flex-col items-center gap-2 transition-all active:scale-[0.97]"
            >
              <span className="text-3xl">💵</span>
              <span className="font-bold text-gray-900">{t(lang, 'payCash')}</span>
            </button>
            <button
              onClick={payCard}
              disabled={busy}
              className="rounded-2xl border-2 border-gray-200 hover:border-gray-900 py-8 flex flex-col items-center gap-2 transition-all active:scale-[0.97]"
            >
              <span className="text-3xl">💳</span>
              <span className="font-bold text-gray-900">{t(lang, 'payCard')}</span>
            </button>
          </div>
        )}

        {mode === 'cash' && (
          <div className="space-y-4">
            {/* Быстрые суммы */}
            <div className="grid grid-cols-3 gap-2">
              {quick.map((amt) => (
                <button
                  key={amt}
                  onClick={() => payCash(amt)}
                  disabled={busy}
                  className="rounded-xl border border-gray-200 hover:border-gray-900 py-3 font-bold text-gray-900 tabular-nums transition-all active:scale-[0.96]"
                >
                  {amt === total ? t(lang, 'exactAmount') : formatMoney(amt, lang)}
                </button>
              ))}
            </div>

            {/* Ручной ввод полученной суммы */}
            <div>
              <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'tendered')}</label>
              <input
                className="input tabular-nums text-lg"
                inputMode="decimal"
                autoFocus
                placeholder="0"
                value={tenderedStr}
                onChange={(e) => setTenderedStr(e.target.value)}
              />
            </div>

            {change !== null && (
              <div className="flex justify-between items-baseline px-1">
                <span className="text-sm text-gray-500">{t(lang, 'change')}</span>
                <span className="text-2xl font-black text-emerald-600 tabular-nums">{formatMoney(change, lang)}</span>
              </div>
            )}

            <button
              onClick={() => tendered !== null && tendered >= total && payCash(tendered)}
              disabled={busy || tendered === null || tendered < total}
              className="btn-primary w-full !py-3.5 !rounded-2xl"
            >
              {t(lang, 'confirmPayment')}
            </button>
          </div>
        )}

        <button onClick={onCancel} disabled={busy} className="btn-ghost w-full mt-3">
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  )
}
