import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchPaidOrders, processRefund, type RefundItem } from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import HubButton from '../../components/ui/HubButton'

export default function RefundPage() {
  const navigate = useNavigate()
  const staff = useAuthStore((s) => s.currentStaff)
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'

  const [search, setSearch] = useState('')
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState('')

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['paid-orders'],
    queryFn: fetchPaidOrders,
  })

  const refundMutation = useMutation({
    mutationFn: async () => {
      if (!selectedOrderId || !staff) throw new Error(t(lang, 'refundNoItems'))
      const order = orders.find((o) => o.id === selectedOrderId)
      if (!order) throw new Error(t(lang, 'orderNotFound'))

      const items: RefundItem[] = (order.order_items ?? [])
        .filter((oi: any) => selectedItems.has(oi.id))
        .map((oi: any) => ({
          order_item_id: oi.id,
          name: oi.menu_item?.name ?? '—',
          qty: oi.qty,
          price: oi.price,
        }))

      if (items.length === 0) throw new Error(t(lang, 'refundNoItems'))
      return processRefund(selectedOrderId, staff.id, items, reason)
    },
    onSuccess: (amount) => {
      toast.success(`${t(lang, 'refundSuccess')}: ${Number(amount).toFixed(0)} ₪`)
      setSelectedOrderId(null)
      setSelectedItems(new Set())
      setReason('')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const filteredOrders = orders.filter((o) => {
    const q = search.toLowerCase()
    return (
      !q ||
      String(o.table?.number).includes(q) ||
      o.id.toLowerCase().includes(q)
    )
  })

  const selectedOrder = orders.find((o) => o.id === selectedOrderId)

  const refundTotal = selectedOrder
    ? (selectedOrder.order_items ?? [])
        .filter((oi: any) => selectedItems.has(oi.id))
        .reduce((s: number, oi: any) => s + oi.price * oi.qty, 0)
    : 0

  function toggleItem(id: string) {
    setSelectedItems((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString(lang === 'he' ? 'he-IL' : 'ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(lang === 'he' ? 'he-IL' : 'ru-RU', {
      day: '2-digit',
      month: '2-digit',
    })
  }

  return (
    <div className="min-h-screen bg-[#f8f9fb] flex flex-col" dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="bg-white border-b border-gray-100 h-14 px-4 flex items-center gap-3 shrink-0 shadow-[0_1px_4px_rgba(0,0,0,0.06)] z-10">
        <HubButton />
        <button
          onClick={() => navigate('/hub')}
          className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-500 transition-colors"
        >
          {isRtl ? '→' : '←'}
        </button>
        <h1 className="font-semibold text-gray-900 text-sm">{t(lang, 'refundTitle')}</h1>
      </header>

      <div className="flex flex-1 overflow-hidden max-w-5xl mx-auto w-full p-6 gap-6">
        {/* Left: order list */}
        <div className="w-80 shrink-0 flex flex-col gap-3">
          <input
            type="text"
            placeholder={t(lang, 'refundSearch')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input text-sm"
          />

          <div className="flex-1 overflow-y-auto flex flex-col gap-2">
            {isLoading && (
              <p className="text-sm text-gray-400 text-center py-8">{t(lang, 'checking')}</p>
            )}
            {!isLoading && filteredOrders.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-8">{t(lang, 'refundNoOrders')}</p>
            )}
            {filteredOrders.map((order) => (
              <button
                key={order.id}
                onClick={() => {
                  setSelectedOrderId(order.id)
                  setSelectedItems(new Set())
                }}
                className={`card w-full text-left px-4 py-3 transition-all duration-150 active:scale-[0.98] ${
                  selectedOrderId === order.id
                    ? 'ring-2 ring-gray-900 border-gray-200'
                    : 'hover:border-gray-200'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-gray-900 text-sm">
                    {lang === 'he' ? 'שולחן' : 'Стол'} {order.table?.number ?? '—'}
                  </span>
                  <span className="text-sm font-black text-gray-900 tabular-nums">
                    {Number(order.total).toFixed(0)} ₪
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-400 tabular-nums">
                    {formatDate(order.created_at)} {formatTime(order.created_at)}
                  </span>
                  <span className="text-[11px] text-gray-400">
                    #{order.id.slice(0, 6).toUpperCase()}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: item selection + confirm */}
        <div className="flex-1 flex flex-col gap-4">
          {!selectedOrder ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-gray-400">{t(lang, 'refundOrders')}</p>
            </div>
          ) : (
            <>
              <div className="card flex-1 overflow-y-auto p-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
                  {t(lang, 'refundSelectItems')}
                </p>
                <div className="flex flex-col gap-1">
                  {(selectedOrder.order_items ?? []).map((oi: any) => {
                    const checked = selectedItems.has(oi.id)
                    return (
                      <button
                        key={oi.id}
                        onClick={() => toggleItem(oi.id)}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                          checked ? 'bg-gray-900 text-white' : 'hover:bg-gray-50 text-gray-800'
                        }`}
                      >
                        <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-all ${
                          checked ? 'bg-white border-white' : 'border-gray-300'
                        }`}>
                          {checked && (
                            <svg className="w-2.5 h-2.5 text-gray-900" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M1.5 5l2.5 2.5 4.5-4" />
                            </svg>
                          )}
                        </div>
                        <span className="flex-1 text-sm font-medium text-left">
                          {oi.qty > 1 && <span className="tabular-nums">{oi.qty}× </span>}
                          {oi.menu_item?.name ?? '—'}
                        </span>
                        <span className={`text-sm font-bold tabular-nums shrink-0 ${checked ? 'text-white' : 'text-gray-700'}`}>
                          {(oi.price * oi.qty).toFixed(0)} ₪
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="card p-4 flex flex-col gap-3">
                <input
                  type="text"
                  placeholder={t(lang, 'refundReasonPlaceholder')}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="input text-sm"
                />

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-gray-400">{t(lang, 'refundAmount')}</p>
                    <p className="text-2xl font-black text-gray-900 tabular-nums">
                      {refundTotal.toFixed(0)} ₪
                    </p>
                  </div>
                  <button
                    onClick={() => refundMutation.mutate()}
                    disabled={refundMutation.isPending || selectedItems.size === 0}
                    className="btn-danger px-6 py-3 text-sm"
                  >
                    {refundMutation.isPending ? '...' : t(lang, 'refundConfirm')}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
