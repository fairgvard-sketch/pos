import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchTransactions, refundOrder, type Transaction } from './api'
import { fetchReceipt } from '../receipt/api'
import ReceiptSheet from '../receipt/ReceiptSheet'
import AppSidebar from '../../components/AppSidebar'
import Icon from '../../components/Icon'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'

/**
 * Журнал операций (Square: Transactions): платежи по дням, поиск,
 * детали заказа, перепечатка чека, возврат (manager+).
 */
export default function TransactionsPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()
  const isManager = staff?.role === 'owner' || staff?.role === 'manager'

  const { data: txs = [], isLoading, error } = useQuery({ queryKey: ['transactions'], queryFn: fetchTransactions })
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showReceipt, setShowReceipt] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const [refundReason, setRefundReason] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return txs
    return txs.filter((tx) =>
      String(tx.daily_number).includes(q) ||
      String(tx.receipt_number ?? '').includes(q) ||
      (tx.customer_name ?? '').toLowerCase().includes(q) ||
      String(tx.total / 100).includes(q)
    )
  }, [txs, search])

  // Группировка по дням (локальная дата)
  const byDay = useMemo(() => {
    const map = new Map<string, Transaction[]>()
    for (const tx of filtered) {
      const day = new Date(tx.paid_at ?? tx.created_at).toLocaleDateString(
        lang === 'he' ? 'he-IL' : 'ru-RU',
        { weekday: 'short', day: 'numeric', month: 'long' }
      )
      if (!map.has(day)) map.set(day, [])
      map.get(day)!.push(tx)
    }
    return [...map.entries()]
  }, [filtered, lang])

  const selected = txs.find((tx) => tx.id === selectedId) ?? null
  // Позиции выбранного заказа — переиспользуем данные чека
  const { data: receipt } = useQuery({
    queryKey: ['receipt', selectedId],
    queryFn: () => fetchReceipt(selectedId!),
    enabled: !!selectedId,
  })

  const refund = useMutation({
    mutationFn: () => refundOrder(selected!.id, staff!.id, refundReason),
    onSuccess: () => {
      toast.success(t(lang, 'refundDone'))
      setRefunding(false)
      setRefundReason('')
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['current_shift'] })
    },
    onError: (e) => toast.error(e.message),
  })

  if (!staff) return null

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="transactions" />

      {/* Список операций */}
      <main className="w-[420px] shrink-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-4 pb-2 shrink-0">
          <h1 className="text-2xl font-black text-gray-900 mb-3">{t(lang, 'transactions')}</h1>
          <input
            className="input !py-2.5"
            placeholder={t(lang, 'searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {isLoading ? (
            <p className="text-center text-gray-400 pt-16">…</p>
          ) : error ? (
            <p className="text-center text-red-500 text-sm pt-16 px-4">{(error as Error).message}</p>
          ) : byDay.length === 0 ? (
            <p className="text-center text-gray-400 text-sm pt-16">{t(lang, 'noTransactions')}</p>
          ) : (
            byDay.map(([day, list]) => (
              <section key={day}>
                <div className="px-3 pt-4 pb-1.5 text-xs font-bold text-gray-400 uppercase tracking-wide">{day}</div>
                {list.map((tx) => {
                  const time = new Date(tx.paid_at ?? tx.created_at).toLocaleTimeString(
                    lang === 'he' ? 'he-IL' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })
                  const method = tx.payments.filter((p) => p.amount > 0).map((p) => p.method)
                  return (
                    <button
                      key={tx.id}
                      onClick={() => { setSelectedId(tx.id); setRefunding(false) }}
                      className={`w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-start transition-colors ${
                        selectedId === tx.id ? 'bg-gray-100' : 'hover:bg-gray-50'
                      }`}
                    >
                      <Icon name={method.includes('card') ? 'card' : 'cash'} size={20} />
                      <div className="flex-1 min-w-0">
                        <div className={`font-bold tabular-nums ${tx.status === 'refunded' ? 'text-red-500 line-through' : 'text-gray-900'}`}>
                          {formatMoney(tx.total, lang)}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          #{tx.daily_number}
                          {tx.customer_name && ` · ${tx.customer_name}`}
                          {tx.table_label && ` · ${t(lang, 'tableLabel')} ${tx.table_label}`}
                          {tx.status === 'refunded' && ` · ${t(lang, 'refunded')}`}
                        </div>
                      </div>
                      <span className="text-xs text-gray-400 tabular-nums shrink-0">{time}</span>
                    </button>
                  )
                })}
              </section>
            ))
          )}
        </div>
      </main>

      {/* Детали операции */}
      <aside className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        {!selected ? (
          <p className="text-center text-gray-300 text-sm pt-24">{t(lang, 'pickTransaction')}</p>
        ) : (
          <div className="max-w-lg mx-auto">
            <div className="text-center mb-6">
              <div className={`text-4xl font-black tabular-nums ${selected.status === 'refunded' ? 'text-red-500' : 'text-gray-900'}`}>
                {formatMoney(selected.total, lang)}
              </div>
              <div className="text-sm text-gray-500 mt-1">
                #{selected.daily_number}
                {selected.receipt_number && ` · ${t(lang, 'receipt')} №${selected.receipt_number}`}
              </div>
              {selected.status === 'refunded' && (
                <span className="inline-block mt-2 px-3 py-1 rounded-full bg-red-50 text-red-600 text-xs font-bold">
                  {t(lang, 'refunded')}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 mb-6">
              <button onClick={() => setShowReceipt(true)} className="btn-secondary !py-3.5 !rounded-2xl">
                {t(lang, 'receipt')}
              </button>
              <button
                onClick={() => setRefunding(true)}
                disabled={selected.status === 'refunded' || !isManager}
                className="btn-danger !py-3.5 !rounded-2xl disabled:opacity-40"
              >
                {t(lang, 'issueRefund')}
              </button>
            </div>

            {refunding && selected.status !== 'refunded' && (
              <div className="rounded-2xl border border-red-200 bg-red-50/50 p-4 mb-6">
                <p className="text-sm font-semibold text-gray-900 mb-2">{t(lang, 'confirmRefund')}</p>
                <input
                  className="input mb-3"
                  placeholder={t(lang, 'refundReasonPh')}
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                />
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => refund.mutate()} disabled={refund.isPending} className="btn-danger !py-3 !rounded-xl">
                    {t(lang, 'refundConfirmBtn')} {formatMoney(selected.total, lang)}
                  </button>
                  <button onClick={() => setRefunding(false)} disabled={refund.isPending} className="btn-ghost !py-3 !rounded-xl">
                    {t(lang, 'cancel')}
                  </button>
                </div>
              </div>
            )}

            {/* Оплата и мета */}
            <div className="space-y-2 text-sm border-t border-gray-100 pt-4">
              {selected.payments.map((p, i) => (
                <div key={i} className="flex justify-between">
                  <span className={`flex items-center gap-2 ${p.amount < 0 ? 'text-red-500' : 'text-gray-600'}`}>
                    <Icon name={p.method === 'cash' ? 'cash' : 'card'} size={16} />
                    {t(lang, p.method === 'cash' ? 'payCash' : 'payCard')}
                  </span>
                  <span className={`tabular-nums font-semibold ${p.amount < 0 ? 'text-red-500' : 'text-gray-900'}`}>
                    {formatMoney(p.amount, lang)}
                  </span>
                </div>
              ))}
              {selected.staff && (
                <div className="flex justify-between text-gray-500">
                  <span>{t(lang, 'cashierLabel')}</span>
                  <span>{selected.staff.name}</span>
                </div>
              )}
            </div>

            {/* Позиции */}
            {receipt && receipt.lines.length > 0 && (
              <div className="border-t border-gray-100 mt-4 pt-4 space-y-2">
                {receipt.lines.map((l, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-gray-700 min-w-0 truncate">
                      {l.qty > 1 && <span className="text-gray-400">{l.qty}× </span>}
                      {l.name}
                      {l.variant_name && <span className="text-gray-500"> · {l.variant_name}</span>}
                    </span>
                    <span className="tabular-nums text-gray-900 font-semibold shrink-0 ms-3">
                      {formatMoney(l.line_total, lang)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      {showReceipt && selected && (
        <ReceiptSheet orderId={selected.id} onClose={() => setShowReceipt(false)} />
      )}
    </div>
  )
}
