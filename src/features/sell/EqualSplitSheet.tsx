import { useMemo, useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t } from '../../lib/i18n'
import { formatMoney, splitEvenly } from '../../lib/money'
import type { PaymentInput } from './api'
import Icon from '../../components/Icon'

interface Props {
  /** Итог к оплате, уже включая чаевые */
  total: number
  onBack: () => void
  onCancel: () => void
  /** Все N долей собраны — оплатить одним чеком (массив платежей = pay_order) */
  onPay: (payments: PaymentInput[]) => void
  busy: boolean
}

const MAX_GUESTS = 10

/**
 * Разделить счёт ПОРОВНУ на N гостей (Square: Split evenly). Один чек:
 * итог делится без потери агорот (splitEvenly), кассир принимает N долей
 * подряд — каждый гость своим способом (нал/карта). После последней доли
 * один pay_order со всеми платежами. Отличается от «по позициям»
 * (SplitItemsSheet): там отдельные чеки на реальные позиции.
 */
export default function EqualSplitSheet({ total, onBack, onCancel, onPay, busy }: Props) {
  const lang = useLangStore((s) => s.lang)
  const payMethodOrder = useDeviceStore((s) => s.payMethodOrder)
  const firstMethod = payMethodOrder[0] ?? 'cash'

  // Число гостей и уже принятые доли (в порядке гостей)
  const [guests, setGuests] = useState(2)
  const [paid, setPaid] = useState<PaymentInput[]>([])
  // Способ текущей доли (по умолчанию — первый способ кассы)
  const [method, setMethod] = useState<'cash' | 'card'>(firstMethod)

  // Доли: первые (total mod n) на 1 агорот больше — сумма точно = total
  const shares = useMemo(() => splitEvenly(total, guests), [total, guests])
  const current = paid.length            // индекс текущего гостя (0-based)
  const done = current >= guests
  const currentShare = done ? 0 : shares[current]

  function payCurrent() {
    const share = shares[current]
    const next = [...paid, { method, amount: share }]
    setPaid(next)
    setMethod(firstMethod) // следующему — снова способ по умолчанию
    if (next.length >= guests) {
      // Все доли собраны — единый чек. change_due не считаем: доли точные
      onPay(next)
    }
  }

  const methodBtns = payMethodOrder.filter((m, i) => payMethodOrder.indexOf(m) === i)

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-[rise-in_0.2s_ease-out]">

        {/* Шапка: назад + заголовок + сумма + закрыть */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
          <button
            onClick={onBack}
            disabled={busy || paid.length > 0}
            aria-label={t(lang, 'back')}
            className="w-9 h-9 -ms-1 rounded-xl flex items-center justify-center text-gray-500 hover:text-gray-900
                       hover:bg-gray-50 transition-colors active:scale-[0.94] disabled:opacity-30"
          >
            <svg className="w-5 h-5 rtl:-scale-x-100" viewBox="0 0 20 20" fill="none" aria-hidden>
              <path d="M12.5 4l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-black text-gray-900 leading-tight">{t(lang, 'splitEqualTitle')}</h2>
            <p className="text-xs text-gray-500 tabular-nums">{t(lang, 'toPay')}: {formatMoney(total, lang)}</p>
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            aria-label={t(lang, 'close')}
            className="w-9 h-9 -me-1 rounded-full flex items-center justify-center text-gray-400
                       hover:bg-gray-100 hover:text-gray-900 transition-all active:scale-[0.94]"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
              <path d="M5 5L15 15M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="p-5">
          {/* Выбор числа гостей — только до первой оплаты */}
          <div className={`flex items-center justify-between gap-4 ${paid.length > 0 ? 'opacity-40 pointer-events-none' : ''}`}>
            <span className="text-sm font-semibold text-gray-900">{t(lang, 'splitGuests')}</span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setGuests((g) => Math.max(2, g - 1))}
                className="w-11 h-11 rounded-xl bg-gray-50 border border-gray-200 text-xl font-bold text-gray-700
                           flex items-center justify-center hover:border-gray-400 active:scale-[0.9] transition-all"
              >
                −
              </button>
              <span className="w-8 text-center text-2xl font-black text-gray-900 tabular-nums">{guests}</span>
              <button
                onClick={() => setGuests((g) => Math.min(MAX_GUESTS, g + 1))}
                className="w-11 h-11 rounded-xl bg-gray-50 border border-gray-200 text-xl font-bold text-gray-700
                           flex items-center justify-center hover:border-gray-400 active:scale-[0.9] transition-all"
              >
                +
              </button>
            </div>
          </div>

          {/* Быстрые чипы 2/3/4 — до первой оплаты */}
          {paid.length === 0 && (
            <div className="flex gap-2 mt-3">
              {[2, 3, 4].map((n) => (
                <button
                  key={n}
                  onClick={() => setGuests(n)}
                  className={`flex-1 h-11 rounded-xl text-sm font-bold tabular-nums transition-all active:scale-[0.97] ${
                    guests === n
                      ? 'bg-gray-900 text-white'
                      : 'bg-white border border-gray-200 text-gray-900 hover:border-gray-400'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          )}

          {/* Прогресс по гостям: доля каждого + статус */}
          <div className="mt-5 space-y-1.5">
            {shares.map((share, i) => {
              const isPaid = i < paid.length
              const isCurrent = i === current && !done
              return (
                <div
                  key={i}
                  className={`flex items-center justify-between gap-3 px-4 h-12 rounded-xl border transition-colors ${
                    isCurrent ? 'border-gray-900 bg-gray-900/[0.03]' : isPaid ? 'border-gray-100 bg-gray-50' : 'border-gray-100'
                  }`}
                >
                  <span className={`text-sm font-semibold ${isPaid ? 'text-gray-400' : 'text-gray-900'}`}>
                    {t(lang, 'splitGuestN')} {i + 1}
                    {isPaid && paid[i] && (
                      <span className="ms-2 text-xs font-medium text-gray-400">
                        {t(lang, paid[i].method === 'cash' ? 'payCash' : 'payCard')}
                      </span>
                    )}
                  </span>
                  <span className={`text-sm font-bold tabular-nums flex items-center gap-2 ${isPaid ? 'text-emerald-600' : 'text-gray-900'}`}>
                    {formatMoney(share, lang)}
                    {isPaid && (
                      <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" aria-hidden>
                        <path d="M4 10.5l4 4 8-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Приём текущей доли: способ + подтверждение */}
          {!done && (
            <div className="mt-5">
              <div className="text-xs font-semibold text-gray-500 mb-2">
                {t(lang, 'splitGuestN')} {current + 1} {t(lang, 'splitOfN')} {guests} · {t(lang, 'splitHowPay')}
              </div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {methodBtns.map((m) => (
                  <button
                    key={m}
                    onClick={() => setMethod(m)}
                    disabled={busy}
                    className={`h-12 rounded-xl flex items-center justify-center gap-2 font-semibold text-sm transition-all active:scale-[0.97] ${
                      method === m
                        ? 'bg-gray-900 text-white'
                        : 'bg-white border border-gray-200 text-gray-900 hover:border-gray-400'
                    }`}
                  >
                    <Icon name={m} size={18} />
                    {t(lang, m === 'cash' ? 'payCash' : 'payCard')}
                  </button>
                ))}
              </div>
              <button
                onClick={payCurrent}
                disabled={busy}
                className="btn-primary w-full !py-3.5 !rounded-2xl"
              >
                {busy ? '…' : `${t(lang, 'splitConfirmShare')} · ${formatMoney(currentShare, lang)}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
