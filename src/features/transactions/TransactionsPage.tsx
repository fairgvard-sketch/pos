import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useInfiniteQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  fetchTransactionsPage,
  fetchTransactionsAll,
  fetchRefunds,
  refundedTotal,
  TX_PAGE_SIZE,
  type Transaction,
  type TxFilters,
} from './api'
import { transactionsToCsv, downloadCsv } from './exportCsv'
import { fetchStaffList } from '../settings/api'
import { fetchReceipt, type Receipt } from '../receipt/api'
import { fetchCurrentLocation } from '../auth/api'
import { autoPrintRefundReceipt, printKitchenTicket } from '../receipt/printService'
import { receiptToKitchenTicket } from '../receipt/kitchenTicket'
import { hasSilentPrintPath } from '../../lib/escpos'
import ReceiptSheet from '../receipt/ReceiptSheet'
import RefundReceiptSheet from '../receipt/RefundReceiptSheet'
import RefundSheet from './RefundSheet'
import OfflineOpsSheet from '../offline/OfflineOpsSheet'
import { useOutboxStore, pendingOpsCount, hasFailedOps } from '../../lib/offline/outboxStore'
import { useNetStore } from '../../lib/offline/net'
import { useDeviceStore } from '../../store/deviceStore'
import AppSidebar from '../../components/AppSidebar'
import LoadErrorState from '../../components/LoadErrorState'
import Icon from '../../components/Icon'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t, orderTypeLabel } from '../../lib/i18n'
import { payMethodIcon, payMethodLabel, type PayMethodId } from '../../lib/payMethods'
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

  // ── Фильтры (P1): применяются СЕРВЕРОМ; состояние живёт здесь и не
  // сбрасывается при открытии/закрытии деталей операции ──
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('') // 'YYYY-MM-DD' input type=date
  const [dateTo, setDateTo] = useState('')
  const [status, setStatus] = useState<TxFilters['status']>(null)
  const [method, setMethod] = useState<PayMethodId | null>(null)
  const [staffId, setStaffId] = useState<string | null>(null)
  const [tableFilter, setTableFilter] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  // Поиск дебаунсится, чтобы не дёргать сервер на каждую букву
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(id)
  }, [search])

  const filters = useMemo<TxFilters>(
    () => ({
      // Границы дат — локальные сутки: from включительно, to исключительно
      from: dateFrom ? new Date(`${dateFrom}T00:00`).toISOString() : null,
      to: dateTo ? new Date(new Date(`${dateTo}T00:00`).getTime() + 86_400_000).toISOString() : null,
      status,
      method,
      staffId,
      table: tableFilter || null,
      search: debouncedSearch || undefined,
    }),
    [dateFrom, dateTo, status, method, staffId, tableFilter, debouncedSearch]
  )
  const activeFilterCount =
    (dateFrom || dateTo ? 1 : 0) + (status ? 1 : 0) + (method ? 1 : 0) + (staffId ? 1 : 0) + (tableFilter ? 1 : 0)

  const txQ = useInfiniteQuery({
    queryKey: ['transactions', filters],
    queryFn: ({ pageParam }) => fetchTransactionsPage(filters, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.length === TX_PAGE_SIZE ? all.reduce((s, p) => s + p.length, 0) : undefined,
  })
  // Offset-пагинация может дать дубль на стыке страниц (свежая продажа
  // сдвинула выборку) — дедуп по id при склейке
  const txs = useMemo(() => {
    const seen = new Set<string>()
    const out: Transaction[] = []
    for (const page of txQ.data?.pages ?? []) {
      for (const tx of page) {
        if (!seen.has(tx.id)) {
          seen.add(tx.id)
          out.push(tx)
        }
      }
    }
    return out
  }, [txQ.data])
  const isLoading = txQ.isPending
  const error = txQ.error

  const { data: staffList = [] } = useQuery({ queryKey: ['staff_list'], queryFn: fetchStaffList })
  const [exporting, setExporting] = useState(false)
  async function exportPeriod() {
    setExporting(true)
    try {
      const all = await fetchTransactionsAll(filters)
      if (all.length === 0) {
        toast.error(t(lang, 'txExportEmpty'))
        return
      }
      const stamp = new Date().toISOString().slice(0, 10)
      downloadCsv(`transactions_${stamp}.csv`, transactionsToCsv(all))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  // Автодогрузка: страж в конце списка тянет следующую страницу
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && txQ.hasNextPage && !txQ.isFetchingNextPage) {
        void txQ.fetchNextPage()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [txQ, txs.length])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showReceipt, setShowReceipt] = useState(false)
  const [refunding, setRefunding] = useState(false)
  // reprint: свежий зикуй после возврата — оригинал; переоткрытие из истории — копия
  const [refundReceipt, setRefundReceipt] = useState<{ id: string; reprint: boolean } | null>(null)

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
  const kitchenTicketOn = useDeviceStore((s) => s.printKitchenTicket)
  const deviceName = useDeviceStore((s) => s.deviceName)
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const canRefund = can(staff?.role, 'refund', location?.settings)

  // Группировка по дням (локальная дата); фильтры уже применены сервером
  const byDay = useMemo(() => {
    const map = new Map<string, Transaction[]>()
    for (const tx of txs) {
      const day = new Date(tx.paid_at ?? tx.created_at).toLocaleDateString(
        lang === 'he' ? 'he-IL' : 'ru-RU',
        { weekday: 'short', day: 'numeric', month: 'long' }
      )
      if (!map.has(day)) map.set(day, [])
      map.get(day)!.push(tx)
    }
    return [...map.entries()]
  }, [txs, lang])

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

  // Перепечатка кухонного тикета из снапшота заказа: чисто локальная печать,
  // без пометки «повтор» и без каких-либо записей (на экран бариста не попадает)
  function reprintTicket() {
    if (!receipt) return
    const allowRawbt = printMode === 'rawbt'
    if (!hasSilentPrintPath(allowRawbt)) {
      toast.error(t(lang, 'testPrintNoSilent'))
      return
    }
    void printKitchenTicket(receiptToKitchenTicket(receipt, deviceName), allowRawbt)
  }

  if (!staff) return null

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="transactions" />

      {/* Список операций */}
      <main className="w-[420px] shrink-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-4 pb-2 shrink-0">
          <h1 className="text-2xl font-black text-gray-900 mb-3">{t(lang, 'transactions')}</h1>
          <div className="flex gap-2">
            <input
              className="input !py-2.5 flex-1"
              placeholder={t(lang, 'searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              onClick={() => setShowFilters((v) => !v)}
              className={`shrink-0 px-3 rounded-xl border text-sm font-semibold transition-colors ${
                showFilters || activeFilterCount > 0
                  ? 'bg-gray-900 text-white border-gray-900'
                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {t(lang, 'txFilters')}
              {activeFilterCount > 0 && ` · ${activeFilterCount}`}
            </button>
          </div>

          {showFilters && (
            <div className="mt-2 rounded-2xl border border-gray-200 p-3 space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  className="input !py-2 flex-1 tabular-nums"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  aria-label={t(lang, 'txDateFrom')}
                />
                <span className="text-gray-400 shrink-0">—</span>
                <input
                  type="date"
                  className="input !py-2 flex-1 tabular-nums"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  aria-label={t(lang, 'txDateTo')}
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {([null, 'paid', 'fulfilled', 'refunded'] as const).map((s) => (
                  <button
                    key={s ?? 'all'}
                    onClick={() => setStatus(s)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                      status === s
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {s === null
                      ? t(lang, 'txStatusAll')
                      : s === 'paid'
                        ? t(lang, 'txStatusPaid')
                        : s === 'fulfilled'
                          ? t(lang, 'txStatusFulfilled')
                          : t(lang, 'refunded')}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <select
                  className="input !py-2 flex-1"
                  value={method ?? ''}
                  onChange={(e) => setMethod((e.target.value || null) as PayMethodId | null)}
                >
                  <option value="">{t(lang, 'txMethodAll')}</option>
                  {(['cash', 'card', 'cibus', 'tenbis', 'bit'] as const).map((m) => (
                    <option key={m} value={m}>{payMethodLabel(lang, m)}</option>
                  ))}
                </select>
                <select
                  className="input !py-2 flex-1"
                  value={staffId ?? ''}
                  onChange={(e) => setStaffId(e.target.value || null)}
                >
                  <option value="">{t(lang, 'txStaffAll')}</option>
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <input
                  className="input !py-2 flex-1"
                  placeholder={t(lang, 'tableLabel')}
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                />
                <button
                  onClick={exportPeriod}
                  disabled={exporting}
                  className="btn-secondary !py-2 !px-3 shrink-0 disabled:opacity-40"
                >
                  {exporting ? '…' : t(lang, 'txExport')}
                </button>
                {activeFilterCount > 0 && (
                  <button
                    onClick={() => {
                      setDateFrom(''); setDateTo(''); setStatus(null)
                      setMethod(null); setStaffId(null); setTableFilter('')
                    }}
                    className="btn-ghost !py-2 !px-3 shrink-0"
                  >
                    {t(lang, 'txReset')}
                  </button>
                )}
              </div>
            </div>
          )}
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
            <div className="pt-16 px-4">
              <LoadErrorState
                title={t(lang, 'dataLoadError')}
                hint={(error as Error).message}
                onRetry={() => { void txQ.refetch() }}
              />
            </div>
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
          {/* Автодогрузка следующей страницы + кнопка-фолбэк */}
          {txQ.hasNextPage && (
            <div ref={sentinelRef} className="pt-2 pb-1">
              <button
                onClick={() => void txQ.fetchNextPage()}
                disabled={txQ.isFetchingNextPage}
                className="w-full py-3 text-sm font-semibold text-gray-500 hover:text-gray-900 transition-colors"
              >
                {txQ.isFetchingNextPage ? '…' : t(lang, 'loadMore')}
              </button>
            </div>
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
              {kitchenTicketOn && (
                <button
                  onClick={reprintTicket}
                  disabled={!receipt}
                  className="btn-secondary !py-3.5 !rounded-2xl col-span-2 disabled:opacity-40"
                >
                  {t(lang, 'kitchenTicketTitle')}
                </button>
              )}
            </div>

            {/* История возвратов: сумма, причина; тап = перепечатка зикуя */}
            {refunds.length > 0 && (
              <div className="rounded-2xl border border-red-100 bg-red-50/50 p-2 mb-6">
                {refunds.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setRefundReceipt({ id: r.id, reprint: true })}
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
                <Icon name={payMethodIcon(p.method)} size={20} />
                <span className="flex-1 font-semibold text-gray-900">
                  {payMethodLabel(lang, p.method)}
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
                    : orderTypeLabel(lang, receipt.order_type)}
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
        // Из Операций чек всегда перепечатка: оригинал выдан при оплате
        <ReceiptSheet orderId={selected.id} reprint onClose={() => setShowReceipt(false)} />
      )}
      {refunding && selected && remaining > 0 && (
        <RefundSheet
          tx={selected}
          remaining={remaining}
          onClose={() => setRefunding(false)}
          onDone={(refundId) => {
            setRefunding(false)
            setRefundReceipt({ id: refundId, reprint: false })
            // Зикуй — фискальный документ: при включённой автопечати уходит на принтер сразу
            if (autoPrintOn) void autoPrintRefundReceipt(refundId, location, printMode === 'rawbt')
          }}
        />
      )}
      {refundReceipt && (
        <RefundReceiptSheet
          refundId={refundReceipt.id}
          reprint={refundReceipt.reprint}
          onClose={() => setRefundReceipt(null)}
        />
      )}
      {/* Временный чек офлайн-продажи */}
      {localReceiptView && (
        <ReceiptSheet receipt={localReceiptView} onClose={() => setLocalReceiptView(null)} />
      )}
      {showOps && <OfflineOpsSheet onClose={() => setShowOps(false)} />}
    </div>
  )
}
