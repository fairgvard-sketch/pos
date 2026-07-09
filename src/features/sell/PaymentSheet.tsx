import { useMemo, useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { PaymentInput } from './api'
import Icon from '../../components/Icon'
import NumPad from '../../components/NumPad'

interface Props {
  /** К оплате, уже ВКЛЮЧАЯ чаевые */
  total: number
  /** Чаевые внутри total — только для строки в шапке */
  tip?: number
  startMode?: 'choose' | 'cash'
  onCancel: () => void
  onPay: (payments: PaymentInput[]) => void
  /** Разделить по позициям (отдельные чеки). Не передан — кнопка скрыта. */
  onSplitItems?: () => void
  busy: boolean
}

type Method = 'card' | 'cash' | 'mixed'

/**
 * Быстрые купюры для расчёта сдачи (Square: Quick amounts), по режиму кассы:
 *  smart  — авто по сумме: «без сдачи» + округления вверх до круглых банкнот
 *  manual — «без сдачи» + заданные суммы, отсекая те, что меньше итога
 *  off    — только «без сдачи» (ровно к оплате)
 * Первая опция всегда = total (кнопка «Без сдачи»).
 */
function quickCashOptions(total: number, mode: 'smart' | 'manual' | 'off', manual: number[]): number[] {
  const opts = new Set<number>([total])
  if (mode === 'smart') {
    const shekels = total / 100
    for (const step of [10, 20, 50, 100, 200]) {
      const rounded = Math.ceil(shekels / step) * step
      if (rounded * 100 >= total) opts.add(rounded * 100)
    }
  } else if (mode === 'manual') {
    for (const a of manual) if (a >= total) opts.add(a)
  }
  return [...opts].sort((a, b) => a - b).slice(0, 5)
}

export default function PaymentSheet({ total, tip = 0, startMode = 'choose', onCancel, onPay, onSplitItems, busy }: Props) {
  const lang = useLangStore((s) => s.lang)
  // Первый способ настраивается на кассе (Настройки → Оплата); «Наличные» с кнопки перебивают
  const firstPayMethod = useDeviceStore((s) => s.firstPayMethod)
  const quickAmountsMode = useDeviceStore((s) => s.quickAmountsMode)
  const quickAmountsManual = useDeviceStore((s) => s.quickAmountsManual)
  const [method, setMethod] = useState<Method>(startMode === 'cash' ? 'cash' : firstPayMethod)
  const [tenderedStr, setTenderedStr] = useState('')
  // Смешанная оплата: сумма наличными; карта добирает остаток
  const [mixedCashStr, setMixedCashStr] = useState('')

  const quick = useMemo(
    () => quickCashOptions(total, quickAmountsMode, quickAmountsManual),
    [total, quickAmountsMode, quickAmountsManual]
  )
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

  const card = { id: 'card', icon: 'card', label: t(lang, 'payCard') } as const
  const cash = { id: 'cash', icon: 'cash', label: t(lang, 'payCash') } as const
  const methods: { id: Method; icon: 'card' | 'cash'; label: string }[] = [
    ...(firstPayMethod === 'cash' ? [cash, card] : [card, cash]),
    { id: 'mixed', icon: 'card', label: t(lang, 'payMixed') },
  ]

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden animate-[rise-in_0.2s_ease-out]">

        {/* Шапка: заголовок + сумма + закрыть */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{t(lang, 'payment')}</h2>
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-gray-500">{t(lang, 'toPay')}</span>
                <span className="text-2xl font-black text-gray-900 tabular-nums">{formatMoney(total, lang)}</span>
              </div>
              {tip > 0 && (
                <span className="text-xs text-gray-500 tabular-nums">
                  {t(lang, 'tipIncluded')} {formatMoney(tip, lang)}
                </span>
              )}
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

        <div className="grid sm:grid-cols-[248px_1fr]">

          {/* Способы оплаты — всегда на виду */}
          <div className="flex sm:flex-col gap-2 p-4 bg-gray-50 sm:border-e border-b sm:border-b-0 border-gray-100">
            {methods.map((m) => {
              const selected = method === m.id
              return (
                <button
                  key={m.id}
                  onClick={() => setMethod(m.id)}
                  disabled={busy}
                  className={`flex-1 sm:flex-none h-14 px-4 rounded-2xl flex items-center gap-3 font-semibold text-sm
                              transition-all active:scale-[0.97] ${
                    selected
                      ? 'bg-gray-900 text-white shadow-sm'
                      : 'bg-white text-gray-900 border border-gray-200 hover:border-gray-400'
                  }`}
                >
                  <Icon name={m.icon} size={22} />
                  <span className="truncate">{m.label}</span>
                </button>
              )
            })}

            {onSplitItems && (
              <>
                <div className="hidden sm:block mt-auto pt-3 border-t border-gray-200" />
                {/* Такой же вес, как у способов оплаты — кассир должен её видеть */}
                <button
                  onClick={onSplitItems}
                  disabled={busy}
                  className="flex-1 sm:flex-none h-14 px-4 rounded-2xl flex items-center gap-3 font-semibold text-sm
                             bg-white text-gray-900 border border-gray-200 hover:border-gray-400
                             transition-all active:scale-[0.97]"
                >
                  <Icon name="refund" size={22} />
                  <span className="truncate">{t(lang, 'splitShort')}</span>
                </button>
              </>
            )}
          </div>

          {/* Контекстная панель выбранного способа */}
          <div className="p-6 min-h-[520px] flex flex-col">
            <div className="w-full max-w-[360px] mx-auto flex-1 flex flex-col">

              {method === 'card' && (
                <>
                  <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
                    <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center text-gray-900">
                      <Icon name="card" size={36} />
                    </div>
                    <div className="text-4xl font-black text-gray-900 tabular-nums">{formatMoney(total, lang)}</div>
                    <p className="text-sm text-gray-500">{t(lang, 'cardHint')}</p>
                  </div>
                  <button
                    onClick={payCard}
                    disabled={busy}
                    className="btn-primary w-full !py-4 !text-base !rounded-2xl"
                  >
                    {busy ? '…' : `${t(lang, 'confirmPayment')} · ${formatMoney(total, lang)}`}
                  </button>
                </>
              )}

              {method === 'cash' && (
                <div className="flex-1 flex flex-col gap-4">
                  {/* Быстрые купюры: 1 тап = оплачено */}
                  <div className="grid grid-cols-3 gap-2">
                    {quick.map((amt) => (
                      <button
                        key={amt}
                        onClick={() => payCash(amt)}
                        disabled={busy}
                        className="h-11 rounded-xl border border-gray-200 hover:border-gray-900 font-bold text-sm
                                   text-gray-900 tabular-nums transition-all active:scale-[0.96]"
                      >
                        {amt === total ? t(lang, 'exactAmount') : formatMoney(amt, lang)}
                      </button>
                    ))}
                  </div>

                  {/* Получено (набирается нумпадом) */}
                  <div className="flex items-baseline justify-between px-1">
                    <span className="text-sm text-gray-500">{t(lang, 'tendered')}</span>
                    <span className={`text-3xl font-black tabular-nums ${tendered !== null ? 'text-gray-900' : 'text-gray-300'}`}>
                      {tendered !== null ? formatMoney(tendered, lang) : formatMoney(0, lang)}
                    </span>
                  </div>

                  <NumPad value={tenderedStr} onChange={setTenderedStr} />

                  {/* Сдача — строка всегда на месте, чтобы вёрстка не прыгала */}
                  <div className="flex items-baseline justify-between px-1">
                    <span className="text-sm text-gray-500">{t(lang, 'change')}</span>
                    <span className={`text-2xl font-black tabular-nums ${change !== null ? 'text-emerald-600' : 'text-gray-300'}`}>
                      {change !== null ? formatMoney(change, lang) : '—'}
                    </span>
                  </div>

                  <button
                    onClick={() => tendered !== null && tendered >= total && payCash(tendered)}
                    disabled={busy || tendered === null || tendered < total}
                    className="btn-primary w-full !py-4 !text-base !rounded-2xl mt-auto"
                  >
                    {t(lang, 'confirmPayment')}
                  </button>
                </div>
              )}

              {method === 'mixed' && (
                <div className="flex-1 flex flex-col gap-4">
                  <p className="text-sm text-gray-500">{t(lang, 'mixedHint')}</p>

                  <div className="flex items-baseline justify-between px-1">
                    <span className="text-sm text-gray-500 flex items-center gap-1.5">
                      <Icon name="cash" size={14} /> {t(lang, 'payCash')}
                    </span>
                    <span className={`text-3xl font-black tabular-nums ${mixedCash !== null ? 'text-gray-900' : 'text-gray-300'}`}>
                      {mixedCash !== null ? formatMoney(mixedCash, lang) : formatMoney(0, lang)}
                    </span>
                  </div>

                  <NumPad value={mixedCashStr} onChange={setMixedCashStr} />

                  {/* Карта добирает остаток автоматически */}
                  <div className="flex items-baseline justify-between px-1">
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
                    className="btn-primary w-full !py-4 !text-base !rounded-2xl mt-auto"
                  >
                    {t(lang, 'confirmPayment')}
                  </button>
                </div>
              )}

            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
