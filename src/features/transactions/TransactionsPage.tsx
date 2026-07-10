import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchTransactions, fetchRefunds, refundedTotal, type Transaction } from './api'
import { fetchReceipt, type Receipt } from '../receipt/api'
import { fetchCurrentLocation } from '../auth/api'
import { autoPrintRefundReceipt } from '../receipt/printService'
import ReceiptSheet from '../receipt/ReceiptSheet'
import RefundReceiptSheet from '../receipt/RefundReceiptSheet'
import RefundSheet from './RefundSheet'
import OfflineOpsSheet from '../offline/OfflineOpsSheet'
import { useOutboxStore, pendingOpsCount, hasFailedOps } from '../../lib/offline/outboxStore'
import { useNetStore } from '../../lib/offline/net'
import { useDeviceStore } from '../../store/deviceStore'
import AppSidebar from '../../components/AppSidebar'
import Icon from '../../components/Icon'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { can } from '../../lib/perms'
import { formatMoney } from '../../lib/money'

/**
 * Журнал операций (Square: Transactions): платежи по дням, поиск,
 * детали заказа, перепечатка чека, возврат (право refund, по умолчанию manager+).
 */
export default function TransactionsPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)

  const { data: txs = [], isLoading, error } = useQuery({ queryKey: ['transactions'], queryFn: fetchTransactions })
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showReceipt, setShowReceipt] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const [refundReceiptId, setRefundReceiptId] = useState<string | null>(null)

  // ── Офлайн (фаза 7): эхо неотправленных продаж + журнал очереди ──
  const localOrders = useOutboxStore((s) => s.localOrders)
  const ops = useOutboxStore((s) => s.ops)
  const online = useNetStore((s) => s.online)
  const [showOps, setShowOps] = useState(false)
  // Просмотр временного чека офлайн-продажи (ReceiptSheet без сети)
  const [localReceiptView, setLocalReceiptView] = useState<Receipt | null>(null)
  const offlineEcho = useMemo(
    () =>
      Object.values(localOrders)
        .filter((lo) => lo.receipt !== null && lo.status !== 'synced')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [localOrders]
  )
  const pendingCount = pendingOpsCount({ ops })
  const anyFailed = hasFailedOps({ ops })

  const autoPrintOn = useDeviceStore((s) => s.autoPrintReceipt)
  const printMode = useDeviceStore((s) => s.printMode)
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const canRefund = can(staff?.role, 'refund', location?.settings)

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
  const { data: receipt, error: receiptError } = useQuery({
    queryKey: ['receipt', selectedId],
    queryFn: () => fetchReceipt(selectedId!),
    enabled: !!selectedId,
  })
  // История возвратов выбранного заказа (причины, кто оформил)
  const { data: refunds = [] } = useQuery({
    queryKey: ['refunds', selectedId],
    queryFn: () => fetchRefunds(selectedId!),
    enabled: !!selectedId,
  })

  const refunded = selected ? refundedTotal(selected) : 0
  const remaining = selected ? selected.total - refunded : 0

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
          {/* Офлайн-продажи, ещё не доехавшие до сервера */}
          {(offlineEcho.length > 0 || pendingCount > 0 || anyFailed) && (
            <section>
              <button
                onClick={() => setShowOps(true)}
                className="w-full px-3 pt-4 pb-1.5 flex items-baseline justify-between text-xs font-bold uppercase tracking-wide"
              >
                <span className={anyFailed ? 'text-red-500' : 'text-amber-600'}>
                  {t(lang, anyFailed ? 'offlineAttention' : 'offlinePendingLabel')}
                </span>
                {pendingCount > 0 && <span className="text-gray-400 tabular-nums">{pendingCount}</span>}
              </button>
              {offlineEcho.map((lo) => (
                <button
                  key={lo.key}
                  onClick={() => setLocalReceiptView(lo.receipt)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-start hover:bg-gray-50 transition-colors"
                >
                  <Icon name={lo.receipt!.payments.some((p) => p.method === 'card') ? 'card' : 'cash'} size={20} />
                  <div className="flex-1 min-w-0">
                    <div className={`font-bold tabular-nums ${lo.status === 'failed' ? 'text-red-500' : 'text-gray-900'}`}>
                      {formatMoney(lo.total, lang)}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {lo.provisionalNumber ?? (lo.serverDailyNumber ? `#${lo.serverDailyNumber}` : '')}
                      {' · '}
                      {t(lang, lo.status === 'failed' ? 'offlineFailedLabel' : 'offlineSale')}
                      {lo.customerName && ` · ${lo.customerName}`}
                    </div>
                  </div>
                  <span className="text-xs text-gray-400 tabular-nums shrink-0">
                    {new Date(lo.createdAt).toLocaleTimeString(lang === 'he' ? 'he-IL' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </button>
              ))}
            </section>
          )}
          {isLoading ? (
            <p className="text-center text-gray-400 pt-16">…</p>
          ) : error ? (
            <p className="text-center text-red-500 text-sm pt-16 px-4">{(error as Error).message}</p>
          ) : byDay.length === 0 ? (
            <p className="text-center text-gray-500 text-sm pt-16">{t(lang, 'noTransactions')}</p>
          ) : (
            byDay.map(([day, list]) => (
              <section key={day}>
                <div className="px-3 pt-4 pb-1.5 text-xs font-bold text-gray-400 uppercase tracking-wide">{day}</div>
                {list.map((tx) => {
                  const time = new Date(tx.paid_at ?? tx.created_at).toLocaleTimeString(
                    lang === 'he' ? 'he-IL' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })
                  const method = tx.payments.filter((p) => p.amount > 0).map((p) => p.method)
                  const partial = tx.status !== 'refunded' && refundedTotal(tx) > 0
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
                          {partial && ` · ${t(lang, 'partialRefund')}`}
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
            {/* Заголовок: сумма + тип операции (Square: $16.95 Sale) */}
            <div className="text-center mb-6">
              <div className={`text-3xl font-black tabular-nums ${selected.status === 'refunded' ? 'text-red-500' : 'text-gray-900'}`}>
                {formatMoney(selected.total, lang)} · {t(lang, 'saleLabel')}
              </div>
              {selected.status === 'refunded' ? (
                <span className="inline-block mt-2 px-3 py-1 rounded-full bg-red-50 text-red-600 text-xs font-bold">
                  {t(lang, 'refunded')}
                </span>
              ) : refunded > 0 && (
                <span className="inline-block mt-2 px-3 py-1 rounded-full bg-red-50 text-red-600 text-xs font-bold">
                  {t(lang, 'partialRefund')} · {formatMoney(refunded, lang)}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 mb-8">
              <button
                // Возврат — только онлайн: issue_refund идемпотентен, но
                // фискальный номер зикуя и сверка остатка требуют сервера
                onClick={() => (online ? setRefunding(true) : toast.error(t(lang, 'offlineBlockedHint')))}
                disabled={remaining <= 0 || !canRefund}
                className={`btn-secondary !py-3.5 !rounded-2xl disabled:opacity-40 ${!online ? 'opacity-40' : ''}`}
              >
                {t(lang, 'issueRefund')}
              </button>
              <button onClick={() => setShowReceipt(true)} className="btn-secondary !py-3.5 !rounded-2xl">
                {t(lang, 'receipt')}
              </button>
            </div>

            {/* История возвратов: сумма, причина; тап = перепечатка зикуя */}
            {refunds.length > 0 && (
              <div className="rounded-2xl border border-red-100 bg-red-50/50 p-2 mb-6">
                {refunds.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setRefundReceiptId(r.id)}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-xl text-start hover:bg-red-50 active:scale-[0.99] text-sm"
                  >
                    <span className="text-gray-600 flex-1 min-w-0 truncate">
                      {t(lang, 'refundedSoFar')}
                      {r.refund_number != null && ` №${r.refund_number}`}
                      {r.reason && ` · ${r.reason}`}
                      {r.staff && ` · ${r.staff.name}`}
                    </span>
                    <span className="tabular-nums font-semibold text-red-600 shrink-0">
                      −{formatMoney(r.amount, lang)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Оплата (Square: Payment) — дата справа, способ, чек, кассир */}
            <div className="flex items-baseline justify-between border-b border-gray-200 pb-2">
              <h2 className="text-lg font-bold text-gray-900">{t(lang, 'paymentSection')}</h2>
              <span className="text-sm text-gray-500 tabular-nums">
                {new Date(selected.paid_at ?? selected.created_at).toLocaleString(
                  lang === 'he' ? 'he-IL' : 'ru-RU',
                  { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {selected.payments.filter((p) => p.amount > 0).map((p, i) => (
              <div key={i} className="flex items-center gap-3 h-12 border-b border-gray-100 text-sm">
                <Icon name={p.method === 'cash' ? 'cash' : 'card'} size={20} />
                <span className="flex-1 font-semibold text-gray-900">
                  {t(lang, p.method === 'cash' ? 'payCash' : 'payCard')}
                </span>
                <span className="tabular-nums font-semibold text-gray-900">{formatMoney(p.amount, lang)}</span>
              </div>
            ))}
            {selected.receipt_number != null && (
              <div className="flex items-center gap-3 h-12 border-b border-gray-100 text-sm">
                <Icon name="note" size={20} />
                <span className="font-semibold text-gray-900">{t(lang, 'receipt')} №{selected.receipt_number}</span>
              </div>
            )}
            {selected.staff && (
              <div className="text-sm text-gray-500 py-3">
                {t(lang, 'cashierLabel')}: {selected.staff.name}
              </div>
            )}

            {receiptError && (
              <p className="text-sm text-red-500 mt-8">{(receiptError as Error).message}</p>
            )}

            {/* Позиции (Square: Items) — тип заказа шапкой, плитки с ценами */}
            {receipt && receipt.lines.length > 0 && (
              <div className="mt-8">
                <h2 className="text-lg font-bold text-gray-900 border-b border-gray-200 pb-2 mb-3">
                  {t(lang, 'itemsSection')}
                </h2>
                <div className="bg-gray-100 rounded-lg px-3 py-2 text-sm font-bold text-gray-700">
                  {receipt.table_label
                    ? `${t(lang, 'tableLabel')} ${receipt.table_label}`
                    : t(lang, receipt.order_type === 'takeaway' ? 'takeaway' : 'here')}
                  {receipt.customer_name && ` · ${receipt.customer_name}`}
                </div>
                {receipt.lines.map((l, i) => (
                  <div key={i} className="flex items-start gap-3 py-3 border-b border-gray-100">
                    <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 uppercase shrink-0">
                      {l.name.slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-gray-900 truncate">
                        {l.qty > 1 && <span className="text-gray-500">{l.qty}× </span>}
                        {l.name}
                      </div>
                      {(l.variant_name || l.modifiers.length > 0) && (
                        <div className="text-xs text-gray-500 truncate">
                          {[l.variant_name, ...l.modifiers.map((m) => m.name)].filter(Boolean).join(', ')}
                        </div>
                      )}
                    </div>
                    <span className="tabular-nums font-semibold text-gray-900 shrink-0">
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
      {refunding && selected && remaining > 0 && (
        <RefundSheet
          tx={selected}
          remaining={remaining}
          onClose={() => setRefunding(false)}
          onDone={(refundId) => {
            setRefunding(false)
            setRefundReceiptId(refundId)
            // Зикуй — фискальный документ: при включённой автопечати уходит на принтер сразу
            if (autoPrintOn) void autoPrintRefundReceipt(refundId, location, printMode === 'rawbt')
          }}
        />
      )}
      {refundReceiptId && (
        <RefundReceiptSheet refundId={refundReceiptId} onClose={() => setRefundReceiptId(null)} />
      )}
      {/* Временный чек офлайн-продажи */}
      {localReceiptView && (
        <ReceiptSheet receipt={localReceiptView} onClose={() => setLocalReceiptView(null)} />
      )}
      {showOps && <OfflineOpsSheet onClose={() => setShowOps(false)} />}
    </div>
  )
}
