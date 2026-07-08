import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchRefundableItems, issueRefund, type Transaction } from './api'
import Icon from '../../components/Icon'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'

interface Props {
  tx: Transaction
  /** оплачено минус уже возвращено — максимум для этого возврата */
  remaining: number
  onClose: () => void
  /** Возврат проведён — родитель показывает/печатает תעודת זיכוי */
  onDone: (refundId: string) => void
}

const REASONS = ['reasonReturned', 'reasonAccidental', 'reasonCanceled', 'reasonOther'] as const
type ReasonKey = (typeof REASONS)[number]

/**
 * Возврат в два шага (Square: Issue Refund):
 *   1. ЧТО возвращаем — отмеченные позиции или произвольная сумма.
 *   2. КУДА (наличные/карта) и ПРИЧИНА из пресетов.
 */
export default function RefundSheet({ tx, remaining, onClose, onDone }: Props) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const { data: items = [] } = useQuery({
    queryKey: ['refundable', tx.id],
    queryFn: () => fetchRefundableItems(tx.id),
  })

  // Возврат тем же способом, которым платили: нал → нал, карта → карта.
  // Доступно по способу = оплачено им минус уже возвращено им
  // (в payments возвраты — отрицательные строки, сумма нетто).
  const avail = useMemo(() => {
    const a: Record<'cash' | 'card', number> = { cash: 0, card: 0 }
    for (const p of tx.payments) a[p.method] += p.amount
    return a
  }, [tx.payments])
  const methods = useMemo(
    () => (['cash', 'card'] as const).filter((m) => tx.payments.some((p) => p.method === m && p.amount > 0)),
    [tx.payments],
  )

  const [step, setStep] = useState<1 | 2>(1)
  const [tab, setTab] = useState<'items' | 'amount'>('items')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [amountStr, setAmountStr] = useState('')
  const [method, setMethod] = useState<'cash' | 'card'>(
    () => (avail.card > avail.cash ? 'card' : 'cash')
  )
  const [reasonKey, setReasonKey] = useState<ReasonKey | null>(null)
  const [otherReason, setOtherReason] = useState('')

  const pickedItems = useMemo(() => items.filter((i) => picked.has(i.id)), [items, picked])
  const pickedSum = pickedItems.reduce((s, i) => s + i.refund_amount, 0)
  // Суммы позиций после округления скидки могут превысить остаток — режем по нему
  const amount = tab === 'items' ? Math.min(pickedSum, remaining) : (parseMoney(amountStr) ?? 0)
  const amountValid = amount > 0 && amount <= remaining
  // Выбранный способ покрывает сумму; иначе — смешанная оплата, нужно два возврата
  const methodValid = amount <= avail[method]
  const anyMethodCovers = methods.some((m) => avail[m] >= amount)

  // Сумма изменилась и текущий способ её не тянет — переключиться на тот, что тянет
  useEffect(() => {
    if (!methodValid) {
      const other = methods.find((m) => avail[m] >= amount)
      if (other) setMethod(other)
    }
  }, [amount, methodValid, methods, avail])

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allPicked = items.length > 0 && picked.size === items.length

  const refund = useMutation({
    mutationFn: () =>
      issueRefund({
        orderId: tx.id,
        staffId: staff!.id,
        amount,
        method,
        reason: reasonKey === 'reasonOther'
          ? otherReason.trim() || t(lang, 'reasonOther')
          : reasonKey
            ? t(lang, reasonKey)
            : undefined,
        items: tab === 'items'
          ? pickedItems.map((i) => ({ name: i.name, qty: i.qty, amount: i.refund_amount }))
          : undefined,
      }),
    onSuccess: (refundId) => {
      toast.success(t(lang, 'refundDone'))
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['refunds', tx.id] })
      qc.invalidateQueries({ queryKey: ['current_shift'] })
      onDone(refundId)
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-6 max-h-[92vh] overflow-y-auto animate-[rise-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка: назад/закрыть + сумма */}
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => (step === 2 ? setStep(1) : onClose())}
            className="w-11 h-11 rounded-xl hover:bg-gray-100 active:scale-[0.97] flex items-center justify-center shrink-0 text-xl text-gray-500"
            aria-label={t(lang, step === 2 ? 'back' : 'cancel')}
          >
            {step === 2 ? (isRtl ? '→' : '←') : '✕'}
          </button>
          <h2 className="text-lg font-black text-gray-900">
            {t(lang, 'issueRefund')}
            {amount > 0 && ` ${formatMoney(amount, lang)}`}
          </h2>
        </div>

        {step === 1 ? (
          <>
            {/* Таб: позиции / сумма */}
            <div className="grid grid-cols-2 gap-1 p-1 bg-gray-100 rounded-xl mb-4">
              {(['items', 'amount'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`h-10 rounded-lg text-sm font-bold transition-colors ${
                    tab === k ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-900'
                  }`}
                >
                  {t(lang, k === 'items' ? 'refundItemsTab' : 'refundAmountTab')}
                </button>
              ))}
            </div>

            {tab === 'items' ? (
              <div className="mb-4">
                <label className="flex items-center gap-3 h-12 px-2 border-b border-gray-100 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-5 h-5 accent-gray-900"
                    checked={allPicked}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(items.map((i) => i.id)))}
                  />
                  <span className="font-bold text-gray-900">{t(lang, 'selectAllItems')}</span>
                </label>
                {items.map((i) => (
                  <label key={i.id} className="flex items-center gap-3 h-12 px-2 border-b border-gray-100 cursor-pointer">
                    <input
                      type="checkbox"
                      className="w-5 h-5 accent-gray-900"
                      checked={picked.has(i.id)}
                      onChange={() => togglePick(i.id)}
                    />
                    <span className="flex-1 min-w-0 truncate text-gray-900">
                      {i.qty > 1 && <span className="text-gray-400">{i.qty}× </span>}
                      {i.name}
                      {i.variant_name && <span className="text-gray-500"> · {i.variant_name}</span>}
                    </span>
                    <span className="tabular-nums font-semibold text-gray-900 shrink-0">
                      {formatMoney(i.refund_amount, lang)}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="mb-4">
                <input
                  className="input !text-2xl !font-black tabular-nums text-center !py-4"
                  inputMode="decimal"
                  placeholder={t(lang, 'refundAmountPh')}
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-2 text-center">
                  {t(lang, 'availableToRefund')}: {formatMoney(remaining, lang)}
                </p>
              </div>
            )}

            <button
              onClick={() => setStep(2)}
              disabled={!amountValid}
              className="btn-primary w-full !py-3.5 !rounded-2xl disabled:opacity-40"
            >
              {t(lang, 'refundNext')}
            </button>
          </>
        ) : (
          <>
            {/* Куда вернуть — только способы, которыми платили (нал → нал, карта → карта) */}
            <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
              {t(lang, 'refundTo')}
            </div>
            <div className="mb-4">
              {methods.map((m) => {
                const covers = avail[m] >= amount
                return (
                  <label
                    key={m}
                    className={`flex items-center gap-3 h-12 px-2 border-b border-gray-100 ${
                      covers ? 'cursor-pointer' : 'opacity-40'
                    }`}
                  >
                    <Icon name={m} size={20} />
                    <span className="flex-1 font-semibold text-gray-900">
                      {t(lang, m === 'cash' ? 'payCash' : 'payCard')}
                      {/* Смешанная оплата: показать потолок каждого способа */}
                      {methods.length > 1 && (
                        <span className="font-normal text-gray-400 text-sm">
                          {' '}· {t(lang, 'upTo')} {formatMoney(avail[m], lang)}
                        </span>
                      )}
                    </span>
                    <input
                      type="radio"
                      name="refund-method"
                      className="w-5 h-5 accent-gray-900"
                      disabled={!covers}
                      checked={method === m}
                      onChange={() => setMethod(m)}
                    />
                  </label>
                )
              })}
              {!anyMethodCovers && (
                <p className="text-xs text-amber-600 mt-2">{t(lang, 'refundSplitHint')}</p>
              )}
            </div>

            {/* Причина */}
            <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">
              {t(lang, 'reasonForRefund')}
            </div>
            <div className="mb-4">
              {REASONS.map((r) => (
                <label key={r} className="flex items-center gap-3 h-12 px-2 border-b border-gray-100 cursor-pointer">
                  <span className="flex-1 font-semibold text-gray-900">{t(lang, r)}</span>
                  <input
                    type="radio"
                    name="refund-reason"
                    className="w-5 h-5 accent-gray-900"
                    checked={reasonKey === r}
                    onChange={() => setReasonKey(r)}
                  />
                </label>
              ))}
              {reasonKey === 'reasonOther' && (
                <input
                  className="input mt-3"
                  placeholder={t(lang, 'refundReasonPh')}
                  value={otherReason}
                  onChange={(e) => setOtherReason(e.target.value)}
                  autoFocus
                />
              )}
            </div>

            <button
              onClick={() => refund.mutate()}
              disabled={refund.isPending || !amountValid || !methodValid || !reasonKey}
              className="btn-danger w-full !py-3.5 !rounded-2xl disabled:opacity-40"
            >
              {t(lang, 'refundConfirmBtn')} {formatMoney(amount, lang)}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
