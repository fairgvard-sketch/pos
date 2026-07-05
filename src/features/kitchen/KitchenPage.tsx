import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import { fetchAllActiveOrders, updateOrderStatus, updateOrderItemStatus } from '../orders/api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import LangToggle from '../../components/ui/LangToggle'
import HubButton from '../../components/ui/HubButton'
import type { Order } from '../../types'

function useOrdersRealtime() {
  const qc = useQueryClient()
  useEffect(() => {
    const channel = supabase
      .channel('kitchen-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        qc.invalidateQueries({ queryKey: ['kitchen-orders'] })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        qc.invalidateQueries({ queryKey: ['kitchen-orders'] })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [qc])
}

function Timer({ createdAt }: { createdAt: string }) {
  const [seconds, setSeconds] = useState(
    Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)
  )
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  const isUrgent = seconds > 15 * 60

  return (
    <span className={`font-mono text-sm font-bold tabular-nums ${isUrgent ? 'text-red-400' : 'text-gray-400'}`}>
      {mins}:{secs.toString().padStart(2, '0')}
    </span>
  )
}

type KitchenLang = ReturnType<typeof useLangStore.getState>['lang']

const STATUS_CONFIG = {
  new:     { bar: 'bg-blue-500',    badge: 'bg-blue-100 text-blue-700',   border: 'border-l-blue-400' },
  cooking: { bar: 'bg-amber-400',   badge: 'bg-amber-100 text-amber-700', border: 'border-l-amber-400' },
  ready:   { bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700', border: 'border-l-emerald-500' },
}

function OrderCard({ order, lang, onReady, onItemReady }: {
  order: Order
  lang: KitchenLang
  onReady: () => void
  onItemReady: (itemId: string) => void
}) {
  const cfg = STATUS_CONFIG[order.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.cooking
  const statusLabel: Record<string, string> = {
    new: t(lang, 'new'),
    cooking: '🔥 ' + t(lang, 'cooking').replace('🔥 ', ''),
    ready: t(lang, 'ready'),
  }
  const allReady = order.order_items?.every((i) => i.status === 'ready') ?? false

  return (
    <div className={`bg-white rounded-2xl border border-gray-100 border-l-4 ${cfg.border} shadow-[0_1px_4px_rgba(0,0,0,0.06)] flex flex-col overflow-hidden`}>
      {/* Card header */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-black text-gray-900 leading-none">
            {t(lang, 'table')} {order.table?.number}
          </span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.badge}`}>
            {statusLabel[order.status] ?? order.status}
          </span>
        </div>
        <Timer createdAt={order.created_at} />
      </div>

      {/* Waiter */}
      <p className="px-4 text-xs text-gray-400 mb-2">{order.waiter?.name}</p>

      {/* Items */}
      <div className="px-4 pb-3 flex flex-col gap-1.5">
        {order.order_items?.map((item) => {
          const isDone = item.status === 'ready' || item.status === 'served'
          return (
            <div key={item.id} className={`flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-all ${isDone ? 'opacity-50' : 'hover:bg-gray-50'}`}>
              <span className={`min-w-[26px] h-6 rounded-md flex items-center justify-center text-xs font-black shrink-0 ${isDone ? 'bg-emerald-100 text-emerald-600' : 'bg-gray-100 text-gray-700'}`}>
                {item.qty}
              </span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold leading-snug ${isDone ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                  {item.menu_item?.name}
                </p>
                {item.notes && (
                  <p className="text-xs text-amber-600 font-medium mt-0.5">! {item.notes}</p>
                )}
              </div>
              {!isDone && order.status !== 'ready' && (
                <button
                  onClick={() => onItemReady(item.id)}
                  className="shrink-0 h-7 px-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold transition-all active:scale-[0.95]"
                >
                  {lang === 'he' ? 'מוכן' : 'Готово'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Action */}
      <div className="px-4 pb-4 mt-auto pt-1">
        {order.status !== 'ready' ? (
          <button
            onClick={onReady}
            className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-[0.98] ${
              allReady
                ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                : 'bg-gray-900 hover:bg-gray-800 text-white'
            }`}
          >
            {t(lang, 'markReady')}
          </button>
        ) : (
          <div className="w-full py-2.5 rounded-xl bg-emerald-50 text-emerald-600 text-sm font-semibold text-center">
            {t(lang, 'waitingService')}
          </div>
        )}
      </div>
    </div>
  )
}

export default function KitchenPage() {
  const logout = useAuthStore((s) => s.logout)
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['kitchen-orders'],
    queryFn: fetchAllActiveOrders,
    refetchInterval: 30_000,
  })

  useOrdersRealtime()

  const markReadyMutation = useMutation({
    mutationFn: (orderId: string) => updateOrderStatus(orderId, 'ready'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kitchen-orders'] })
      toast.success(t(lang, 'ready'))
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const markItemReadyMutation = useMutation({
    mutationFn: async ({ itemId, orderId, order }: { itemId: string; orderId: string; order: Order }) => {
      await updateOrderItemStatus(itemId, 'ready')
      const remaining = order.order_items?.filter((i) => i.id !== itemId && i.status !== 'ready' && i.status !== 'served') ?? []
      if (remaining.length === 0) await updateOrderStatus(orderId, 'ready')
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kitchen-orders'] }),
    onError: (e: Error) => toast.error(e.message),
  })

  const activeOrders = orders.filter((o) => o.status !== 'paid')
  const newOrders     = activeOrders.filter((o) => o.status === 'new')
  const cookingOrders = activeOrders.filter((o) => o.status === 'cooking')
  const readyOrders   = activeOrders.filter((o) => o.status === 'ready')

  const isRtl = lang === 'he'

  return (
    <div className="min-h-screen bg-[#f8f9fb]" dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="bg-white border-b border-gray-100 px-6 h-14 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <HubButton />
          <span className="font-bold text-gray-900">{t(lang, 'kitchen')}</span>
          <div className="flex items-center gap-2">
            {newOrders.length > 0 && (
              <span className="badge-blue">{t(lang, 'new')}: {newOrders.length}</span>
            )}
            {cookingOrders.length > 0 && (
              <span className="badge-yellow">{cookingOrders.length} {t(lang, 'cooking').replace('🔥 ', '')}</span>
            )}
            {readyOrders.length > 0 && (
              <span className="badge-green">{readyOrders.length} {t(lang, 'ready').replace('✅ ', '')}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {t(lang, 'realtimeConnected')}
          </div>
          <LangToggle />
          <button onClick={logout} className="btn-ghost text-xs">
            {t(lang, 'logout')}
          </button>
        </div>
      </header>

      <main className="p-5">
        {isLoading ? (
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-48 rounded-2xl bg-gray-100 animate-pulse" />
            ))}
          </div>
        ) : activeOrders.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center text-3xl">🎉</div>
            <p className="font-medium">{t(lang, 'noActiveOrders')}</p>
          </div>
        ) : (
          <div className="columns-3 gap-4 space-y-4">
            {[...newOrders, ...cookingOrders, ...readyOrders].map((order) => (
              <div key={order.id} className="break-inside-avoid">
                <OrderCard
                  order={order}
                  lang={lang}
                  onReady={() => markReadyMutation.mutate(order.id)}
                  onItemReady={(itemId) => markItemReadyMutation.mutate({ itemId, orderId: order.id, order })}
                />
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
