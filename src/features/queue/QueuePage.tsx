import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchQueue, subscribeQueue, markItemReady, markOrderReady, type QueueOrder, type QueueItem } from './api'
import { fetchStations } from '../menu/api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { playNewOrderChime } from '../../lib/sound'
import AppSidebar from '../../components/AppSidebar'

const STATION_KEY = 'kassa-queue-station'

export default function QueuePage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()

  const { data: orders = [] } = useQuery({ queryKey: ['queue'], queryFn: fetchQueue })
  const { data: stations = [] } = useQuery({ queryKey: ['stations'], queryFn: fetchStations })

  // Выбранная станция запоминается на устройстве
  const [station, setStation] = useState<string>(() => localStorage.getItem(STATION_KEY) ?? 'all')
  useEffect(() => { localStorage.setItem(STATION_KEY, station) }, [station])

  // Realtime: любое изменение заказов/позиций → перезапрос очереди
  useEffect(() => subscribeQueue(() => qc.invalidateQueries({ queryKey: ['queue'] })), [qc])

  const readyItem = useMutation({
    mutationFn: ({ id, ready }: { id: string; ready: boolean }) => markItemReady(id, ready),
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
    onError: (e) => toast.error((e as Error).message),
  })
  const readyOrder = useMutation({
    mutationFn: (orderId: string) => markOrderReady(orderId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }),
    onError: (e) => toast.error((e as Error).message),
  })

  // Фильтр по станции: показываем заказы, где есть хоть одна позиция станции
  const visibleOrders = useMemo(() => {
    if (station === 'all') return orders
    return orders
      .map((o) => ({ ...o, order_items: o.order_items.filter((i) => i.station_id === station) }))
      .filter((o) => o.order_items.length > 0)
  }, [orders, station])

  // Звук при появлении нового заказа (сравниваем множества id, не количество)
  const knownIds = useRef<Set<string> | null>(null)
  useEffect(() => {
    const ids = new Set(visibleOrders.map((o) => o.id))
    if (knownIds.current === null) {
      knownIds.current = ids // первая загрузка — не звеним
      return
    }
    const hasNew = [...ids].some((id) => !knownIds.current!.has(id))
    if (hasNew) playNewOrderChime()
    knownIds.current = ids
  }, [visibleOrders])

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="queue" />

      {/* Тёмная рабочая область — комфортна для экрана за стойкой */}
      <main className="flex-1 min-w-0 bg-[#1a1c1f] rounded-3xl flex flex-col overflow-hidden">
        {/* Шапка: фильтр по станциям + счётчик */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
          <div className="flex gap-2 overflow-x-auto">
            <StationChip active={station === 'all'} onClick={() => setStation('all')}>
              {t(lang, 'all')}
            </StationChip>
            {stations.map((s) => (
              <StationChip key={s.id} active={station === s.id} onClick={() => setStation(s.id)}>
                {s.name}
              </StationChip>
            ))}
          </div>
          <span className="text-sm text-gray-400 whitespace-nowrap ms-3">
            {t(lang, 'waitingCount')}: <span className="font-bold text-white tabular-nums">{visibleOrders.length}</span>
          </span>
        </div>

        {/* Сетка карточек */}
        <div className="flex-1 overflow-y-auto p-4">
          {visibleOrders.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <div className="text-5xl mb-3 text-emerald-400">✓</div>
              <p className="font-bold text-white">{t(lang, 'queueEmpty')}</p>
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'queueEmptyHint')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
              {visibleOrders.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  lang={lang}
                  onItemReady={(id, ready) => readyItem.mutate({ id, ready })}
                  onAllReady={() => readyOrder.mutate(order.id)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function OrderCard({
  order, lang, onItemReady, onAllReady,
}: {
  order: QueueOrder
  lang: 'ru' | 'he'
  onItemReady: (id: string, ready: boolean) => void
  onAllReady: () => void
}) {
  const waited = elapsed(order.paid_at ?? order.created_at, lang)
  const allReady = order.order_items.every((i) => i.prep_status === 'ready')

  return (
    <div className="rounded-2xl border border-white/10 bg-[#26292e] flex flex-col overflow-hidden animate-[rise-in_0.18s_ease-out]">
      {/* Заголовок карточки */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-black text-white tabular-nums">#{order.daily_number}</span>
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            {order.order_type === 'takeaway' ? t(lang, 'takeaway') : t(lang, 'here')}
          </span>
        </div>
        <span className="text-xs text-gray-400 tabular-nums">{waited}</span>
      </div>

      {order.customer_name && (
        <div className="px-4 pt-2 text-sm font-semibold text-gray-200">{order.customer_name}</div>
      )}

      {/* Позиции — тап отмечает готовой */}
      <div className="flex-1 p-2 space-y-1">
        {order.order_items.map((item) => (
          <ItemRow key={item.id} item={item} onToggle={() => onItemReady(item.id, item.prep_status !== 'ready')} />
        ))}
      </div>

      {/* Кнопка «всё готово» */}
      <button
        onClick={onAllReady}
        disabled={allReady}
        className="m-2 mt-0 min-h-[48px] rounded-xl bg-white text-gray-900 font-bold text-sm
                   hover:bg-gray-100 active:scale-[0.97] transition-all
                   disabled:bg-emerald-500 disabled:text-white disabled:opacity-100"
      >
        {allReady ? `✓ ${t(lang, 'allReady')}` : t(lang, 'allReady')}
      </button>
    </div>
  )
}

function ItemRow({ item, onToggle }: { item: QueueItem; onToggle: () => void }) {
  const ready = item.prep_status === 'ready'
  const details = [item.variant_name, ...item.order_item_modifiers.map((m) => m.name), item.notes]
    .filter(Boolean)
    .join(' · ')

  return (
    <button
      onClick={onToggle}
      className={`w-full text-start rounded-xl px-3 min-h-[48px] py-2.5 flex items-start gap-2.5 transition-all active:scale-[0.98] ${
        ready ? 'bg-emerald-500/15' : 'bg-white/5 hover:bg-white/10'
      }`}
    >
      <span
        className={`mt-0.5 w-6 h-6 rounded-md shrink-0 flex items-center justify-center text-xs font-bold transition-colors ${
          ready ? 'bg-emerald-500 text-white' : 'border-2 border-white/25'
        }`}
      >
        {ready ? '✓' : ''}
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block text-sm font-semibold leading-tight ${ready ? 'text-emerald-300 line-through' : 'text-white'}`}>
          {item.qty > 1 && <span className="tabular-nums">{item.qty}× </span>}
          {item.name}
        </span>
        {details && <span className={`block text-xs mt-0.5 ${ready ? 'text-emerald-400/60' : 'text-gray-400'}`}>{details}</span>}
      </span>
    </button>
  )
}

function StationChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-11 px-4 rounded-xl text-sm font-semibold whitespace-nowrap transition-all active:scale-[0.96] ${
        active ? 'bg-white text-gray-900' : 'bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  )
}

/** «5 мин назад» / «только что» */
function elapsed(iso: string, lang: 'ru' | 'he'): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return t(lang, 'justNow')
  return `${mins} ${t(lang, 'minShort')} ${t(lang, 'ago')}`
}
