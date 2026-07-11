import { useMemo, useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import { payMethodIcon, payMethodLabel, type PayMethodId } from '../../lib/payMethods'
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
  /** Разделить поровну на N гостей (один чек). Не передан — кнопка скрыта. */
  onSplitEqually?: () => void
  busy: boolean
}

type Method = PayMethodId

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

/**
 * Оплата без отдельного режима «наличные + карта» (Square-подход):
 * ввёл МЕНЬШЕ остатка → часть фиксируется чипом, касса переключается на
 * другой способ добрать остаток. onPay уходит один раз со всеми частями.
 */
export default function PaymentSheet({ total, tip = 0, startMode = 'choose', onCancel, onPay, onSplitItems, onSplitEqually, busy }: Props) {
  const lang = useLangStore((s) => s.lang)
  // Порядок способов настраивается на кассе (Настройки → Оплата → Способы оплаты);
  // первый — выбран по умолчанию. «Наличные» с кнопки перебивают
  const payMethodOrder = useDeviceStore((s) => s.payMethodOrder)
  const firstPayMethod = payMethodOrder[0] ?? 'cash'
  const quickAmountsMode = useDeviceStore((s) => s.quickAmountsMode)
  const quickAmountsManual = useDeviceStore((s) => s.quickAmountsManual)
  const [method, setMethod] = useState<Method>(startMode === 'cash' ? 'cash' : firstPayMethod)
  const [tenderedStr, setTenderedStr] = useState('')
  const [cardStr, setCardStr] = useState('')

  // Зафиксированные части смешанной оплаты (ещё НЕ отправлены на сервер —
  // onPay уходит один раз, целиком, при доборе остатка)
  const [parts, setParts] = useState<PaymentInput[]>([])
  const paidSoFar = parts.reduce((s, p) => s + p.amount, 0)
  const remaining = total - paidSoFar

  const quick = useMemo(
    () => quickCashOptions(remaining, quickAmountsMode, quickAmountsManual),
    [remaining, quickAmountsMode, quickAmountsManual]
  )
  const tendered = tenderedStr ? parseMoney(tenderedStr) : null
  const change = tendered !== null && tendered >= remaining ? tendered - remaining : null
  // Карта: пустой ввод = весь остаток; больше остатка картой не бывает
  const cardEntered = cardStr ? parseMoney(cardStr) : null
  const cardAmount = cardEntered === null ? remaining : Math.min(cardEntered, remaining)
  const cardPartial = cardEntered !== null && cardEntered > 0 && cardEntered < remaining

  // Кем добирать частичную оплату: первый безналичный способ из порядка
  const firstNonCash: Method = payMethodOrder.find((m) => m !== 'cash') ?? 'card'

  /** Наличные: полная оплата остатка (со сдачей) или частичная → добор безналом */
  function confirmCash(tenderedAmount: number) {
    if (tenderedAmount >= remaining) {
      onPay([
        ...parts,
        { method: 'cash', amount: remaining, tendered: tenderedAmount, change_due: tenderedAmount - remaining },
      ])
    } else if (tenderedAmount > 0) {
      setParts([...parts, { method: 'cash', amount: tenderedAmount, tendered: tenderedAmount, change_due: 0 }])
      setTenderedStr('')
      setMethod(firstNonCash)
    }
  }

  /** Безнал (карта/кошелёк): полный остаток или частично → добор наличными */
  function confirmNonCash() {
    if (cardAmount <= 0) return
    if (cardAmount >= remaining) {
      onPay([...parts, { method, amount: remaining }])
    } else {
      setParts([...parts, { method, amount: cardAmount }])
      setCardStr('')
      setMethod('cash')
    }
  }

  /** Убрать зафиксированную часть (передумали до подтверждения) */
  function removePart(idx: number) {
    setParts(parts.filter((_, i) => i !== idx))
  }

  const methods: { id: Method; icon: 'card' | 'cash'; label: string }[] =
    // Порядок из настроек кассы (payMethodOrder); дубли отсекаем
    payMethodOrder
      .filter((m, i) => payMethodOrder.indexOf(m) === i)
      .map((m) => ({ id: m, icon: payMethodIcon(m), label: payMethodLabel(lang, m) }))

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden animate-[rise-in_0.2s_ease-out]">

        {/* Шапка: заголовок + сумма + закрыть */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{t(lang, 'payment')}</h2>
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-gray-500">
                  {parts.length > 0 ? t(lang, 'remainingLabel') : t(lang, 'toPay')}
                </span>
                <span className="text-2xl font-black text-gray-900 tabular-nums">
                  {formatMoney(remaining, lang)}
                </span>
              </div>
              {parts.length > 0 ? (
                <span className="text-xs text-gray-500 tabular-nums">
                  {t(lang, 'toPay')} {formatMoney(total, lang)}
                </span>
              ) : tip > 0 ? (
                <span className="text-xs text-gray-500 tabular-nums">
                  {t(lang, 'tipIncluded')} {formatMoney(tip, lang)}
                </span>
              ) : null}
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

            {(onSplitItems || onSplitEqually) && (
              <div className="hidden sm:block mt-auto pt-3 border-t border-gray-200" />
            )}
            {/* Разделить поровну на N (один чек) */}
            {onSplitEqually && (
              <button
                onClick={onSplitEqually}
                disabled={busy || parts.length > 0}
                className="flex-1 sm:flex-none h-14 px-4 rounded-2xl flex items-center gap-3 font-semibold text-sm
                           bg-white text-gray-900 border border-gray-200 hover:border-gray-400
                           transition-all active:scale-[0.97]"
              >
                <Icon name="customers" size={22} />
                <span className="truncate">{t(lang, 'splitEqualShort')}</span>
              </button>
            )}
            {/* Разделить по позициям (отдельные чеки) */}
            {onSplitItems && (
              <button
                onClick={onSplitItems}
                disabled={busy || parts.length > 0}
                className="flex-1 sm:flex-none h-14 px-4 rounded-2xl flex items-center gap-3 font-semibold text-sm
                           bg-white text-gray-900 border border-gray-200 hover:border-gray-400
                           transition-all active:scale-[0.97]"
              >
                <Icon name="refund" size={22} />
                <span className="truncate">{t(lang, 'splitShort')}</span>
              </button>
            )}
          </div>

          {/* Контекстная панель выбранного способа */}
          <div className="p-6 min-h-[520px] flex flex-col">
            <div className="w-full max-w-[360px] mx-auto flex-1 flex flex-col">

              {/* Зафиксированные части смешанной оплаты — чипы с ✕ */}
              {parts.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {parts.map((p, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-2 ps-3 pe-1 py-1 rounded-full bg-gray-100
                                 text-sm font-semibold text-gray-900 tabular-nums"
                    >
                      <Icon name={p.method === 'cash' ? 'cash' : 'card'} size={14} />
                      {formatMoney(p.amount, lang)}
                      <button
                        onClick={() => removePart(i)}
                        disabled={busy}
                        aria-label={t(lang, 'cancel')}
                        className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400
                                   hover:bg-gray-200 hover:text-gray-900 transition-all"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {method !== 'cash' && (
                <div className="flex-1 flex flex-col gap-4">
                  {/* Сумма безналом: пусто = весь остаток; меньше — добор наличными */}
                  <div className="flex items-baseline justify-between px-1">
                    <span className="text-sm text-gray-500 flex items-center gap-1.5">
                      <Icon name="card" size={14} /> {payMethodLabel(lang, method)}
                    </span>
                    <span className={`text-3xl font-black tabular-nums ${cardStr ? 'text-gray-900' : 'text-gray-400'}`}>
                      {formatMoney(cardAmount, lang)}
                    </span>
                  </div>

                  <NumPad value={cardStr} onChange={setCardStr} />

                  {/* Подсказка/остаток — строка всегда на месте, чтобы вёрстка не прыгала */}
                  <div className="flex items-baseline justify-between px-1 min-h-[32px]">
                    {cardPartial ? (
                      <>
                        <span className="text-sm text-gray-500 flex items-center gap-1.5">
                          <Icon name="cash" size={14} /> {t(lang, 'restByCash')}
                        </span>
                        <span className="text-2xl font-black text-gray-900 tabular-nums">
                          {formatMoney(remaining - cardAmount, lang)}
                        </span>
                      </>
                    ) : (
                      <span className="text-sm text-gray-400">{t(lang, 'cardHint')}</span>
                    )}
                  </div>

                  <button
                    onClick={confirmNonCash}
                    disabled={busy || cardAmount <= 0}
                    className="btn-primary w-full !py-4 !text-base !rounded-2xl mt-auto"
                  >
                    {busy
                      ? '…'
                      : cardPartial
                        ? `${t(lang, 'acceptPart')} ${formatMoney(cardAmount, lang)} · ${t(lang, 'restByCash')}`
                        : `${t(lang, 'confirmPayment')} · ${formatMoney(remaining, lang)}`}
                  </button>
                </div>
              )}

              {method === 'cash' && (
                <div className="flex-1 flex flex-col gap-4">
                  {/* Быстрые купюры: 1 тап = оплачено */}
                  <div className="grid grid-cols-3 gap-2">
                    {quick.map((amt) => (
                      <button
                        key={amt}
                        onClick={() => confirmCash(amt)}
                        disabled={busy}
                        className="h-11 rounded-xl border border-gray-200 hover:border-gray-900 font-bold text-sm
                                   text-gray-900 tabular-nums transition-all active:scale-[0.96]"
                      >
                        {amt === remaining ? t(lang, 'exactAmount') : formatMoney(amt, lang)}
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

                  {/* Сдача / добор картой — строка всегда на месте, чтобы вёрстка не прыгала */}
                  <div className="flex items-baseline justify-between px-1">
                    {tendered !== null && tendered > 0 && tendered < remaining ? (
                      <>
                        <span className="text-sm text-gray-500 flex items-center gap-1.5">
                          <Icon name="card" size={14} /> {t(lang, 'restBy')} {payMethodLabel(lang, firstNonCash)}
                        </span>
                        <span className="text-2xl font-black text-gray-900 tabular-nums">
                          {formatMoney(remaining - tendered, lang)}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-sm text-gray-500">{t(lang, 'change')}</span>
                        <span className={`text-2xl font-black tabular-nums ${change !== null ? 'text-emerald-600' : 'text-gray-300'}`}>
                          {change !== null ? formatMoney(change, lang) : '—'}
                        </span>
                      </>
                    )}
                  </div>

                  <button
                    onClick={() => tendered !== null && confirmCash(tendered)}
                    disabled={busy || tendered === null || tendered <= 0}
                    className="btn-primary w-full !py-4 !text-base !rounded-2xl mt-auto"
                  >
                    {tendered !== null && tendered > 0 && tendered < remaining
                      ? `${t(lang, 'acceptPart')} ${formatMoney(tendered, lang)} · ${t(lang, 'restBy')} ${payMethodLabel(lang, firstNonCash)}`
                      : t(lang, 'confirmPayment')}
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
