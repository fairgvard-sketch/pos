import { useMemo, useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { PaymentInput } from './api'
import Icon from '../../components/Icon'

interface Props {
  total: number
  startMode?: 'choose' | 'cash'
  onCancel: () => void
  onPay: (payments: PaymentInput[]) => void
  /** Разделить по позициям (отдельные чеки). Не передан — кнопка скрыта. */
  onSplitItems?: () => void
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

export default function PaymentSheet({ total, startMode = 'choose', onCancel, onPay, onSplitItems, busy }: Props) {
  const lang = useLangStore((s) => s.lang)
  const [mode, setMode] = useState<'choose' | 'cash' | 'mixed'>(startMode)
  const [tenderedStr, setTenderedStr] = useState('')
  // Смешанная оплата: сумма наличными; карта добирает остаток
  const [mixedCashStr, setMixedCashStr] = useState('')

  const quick = useMemo(() => quickCashOptions(total), [total])
  const tendered = tenderedStr ? parseMoney(tenderedStr) : null
  const change = tendered !== null && tendered >= total ? tendered - total : null

  const mixedCash = mixedCashStr ? parseMoney(mixedCashStr) : null
  const mixedCard = mixedCash !== null && mixedCash >= 0 && mixedCash <= total ? total - mixedCash : null
  const mixedValid = mixedCash !== null && mixedCash > 0 && mixedCash < total

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

  function payMixed() {
    if (!mixedValid || mixedCard === null) return
    onPay([
      { method: 'cash', amount: mixedCash!, tendered: mixedCash!, change_due: 0 },
      { method: 'card', amount: mixedCard },
    ])
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-md p-6 animate-[rise-in_0.2s_ease-out]">
        <div className="flex justify-between items-baseline mb-5">
          <span className="text-sm text-gray-400">{t(lang, 'toPay')}</span>
          <span className="text-3xl font-black text-gray-900 tabular-nums">{formatMoney(total, lang)}</span>
        </div>

        {mode === 'choose' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setMode('cash')}
                disabled={busy}
                className="rounded-2xl border-2 border-gray-200 hover:border-gray-900 py-8 flex flex-col items-center gap-3 transition-all active:scale-[0.97]"
              >
                <Icon name="cash" size={32} />
                <span className="font-bold text-gray-900">{t(lang, 'payCash')}</span>
              </button>
              <button
                onClick={payCard}
                disabled={busy}
                className="rounded-2xl border-2 border-gray-200 hover:border-gray-900 py-8 flex flex-col items-center gap-3 transition-all active:scale-[0.97]"
              >
                <Icon name="card" size={32} />
                <span className="font-bold text-gray-900">{t(lang, 'payCard')}</span>
              </button>
            </div>
            <div className={`grid gap-2 ${onSplitItems ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <button
                onClick={() => setMode('mixed')}
                disabled={busy}
                className="rounded-2xl border border-gray-200 hover:border-gray-900 py-3.5 text-sm font-semibold text-gray-900 transition-all active:scale-[0.98]"
              >
                {t(lang, 'payMixed')}
              </button>
              {onSplitItems && (
                <button
                  onClick={onSplitItems}
                  disabled={busy}
                  className="rounded-2xl border border-gray-200 hover:border-gray-900 py-3.5 text-sm font-semibold text-gray-900 transition-all active:scale-[0.98]"
                >
                  {t(lang, 'splitByItems')}
                </button>
              )}
            </div>
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

        {mode === 'mixed' && (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-1.5">
                <Icon name="cash" size={14} /> {t(lang, 'payCash')}
              </label>
              <input
                className="input tabular-nums text-lg"
                inputMode="decimal"
                autoFocus
                placeholder="0"
                value={mixedCashStr}
                onChange={(e) => setMixedCashStr(e.target.value)}
              />
            </div>

            {/* Карта добирает остаток автоматически */}
            <div className="flex justify-between items-baseline px-1">
              <span className="text-sm text-gray-500 flex items-center gap-1.5">
                <Icon name="card" size={14} /> {t(lang, 'payCard')}
              </span>
              <span className="text-2xl font-black text-gray-900 tabular-nums">
                {mixedCard !== null ? formatMoney(mixedCard, lang) : '—'}
              </span>
            </div>

            <button
              onClick={payMixed}
              disabled={busy || !mixedValid}
              className="btn-primary w-full !py-3.5 !rounded-2xl"
            >
              {t(lang, 'confirmPayment')}
            </button>
            <button onClick={() => setMode('choose')} disabled={busy} className="btn-ghost w-full">
              {t(lang, 'back')}
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
