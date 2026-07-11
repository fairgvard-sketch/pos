import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchQueue, subscribeQueue, markItemReady, markOrderReady, type QueueOrder, type QueueItem } from './api'
import { fetchStations } from '../menu/api'
import { useLangStore } from '../../store/langStore'
import { t, orderTypeLabel, formatTime } from '../../lib/i18n'
import { playNewOrderChime } from '../../lib/sound'
import { useOutboxStore } from '../../lib/offline/outboxStore'
import { useNetStore } from '../../lib/offline/net'
import { enqueueItemReady, enqueueOrderReady } from '../../lib/offline/enqueue'
import AppSidebar from '../../components/AppSidebar'

const STATION_KEY = 'kassa-queue-station'
const THEME_KEY = 'kassa-queue-theme'

type Theme = 'dark' | 'light'

/** Палитра экрана очереди — переключается баристой, запоминается на устройстве */
const THEMES = {
  dark: {
    main: 'bg-[#1a1c1f]',
    border: 'border-white/10',
    countText: 'text-white',
    hintText: 'text-gray-500',
    emptyIcon: 'text-emerald-400',
    emptyTitle: 'text-white',
    card: 'bg-[#26292e] border-white/10',
    cardBorder: 'border-white/10',
    number: 'text-white',
    customer: 'text-gray-200',
    allReadyBtn: 'bg-white text-gray-900 hover:bg-gray-100',
    itemReady: 'bg-emerald-500/15',
    itemIdle: 'bg-white/5 hover:bg-white/10',
    checkboxIdle: 'border-2 border-white/25',
    itemNameReady: 'text-emerald-300 line-through',
    itemNameIdle: 'text-white',
    itemDetailReady: 'text-emerald-400/60',
    itemDetailIdle: 'text-gray-400',
    chipActive: 'bg-white text-gray-900',
    chipIdle: 'bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10',
  },
  light: {
    main: 'bg-white',
    border: 'border-gray-100',
    countText: 'text-gray-900',
    hintText: 'text-gray-400',
    emptyIcon: 'text-emerald-500',
    emptyTitle: 'text-gray-900',
    card: 'bg-white border-gray-100',
    cardBorder: 'border-gray-100',
    number: 'text-gray-900',
    customer: 'text-gray-700',
    allReadyBtn: 'bg-gray-900 text-white hover:bg-gray-800',
    itemReady: 'bg-emerald-50',
    itemIdle: 'bg-gray-50 hover:bg-gray-100',
    checkboxIdle: 'border-2 border-gray-300',
    itemNameReady: 'text-emerald-700 line-through',
    itemNameIdle: 'text-gray-900',
    itemDetailReady: 'text-emerald-600/70',
    itemDetailIdle: 'text-gray-400',
    chipActive: 'bg-gray-900 text-white',
    chipIdle: 'bg-gray-50 border border-gray-100 text-gray-500 hover:border-gray-300',
  },
} as const

/** Карточка очереди: серверная или локальное эхо офлайн-заказа */
type MergedQueueOrder = QueueOrder & { localNumber?: string; isLocal?: boolean }

export default function QueuePage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()

  const { data: serverOrders = [] } = useQuery({ queryKey: ['queue'], queryFn: fetchQueue })
  const { data: stations = [] } = useQuery({ queryKey: ['stations'], queryFn: fetchStations })

  // ── Офлайн (фаза 7): эхо неотправленных заказов в очереди ──
  const localOrders = useOutboxStore((s) => s.localOrders)
  const patchLocalOrder = useOutboxStore((s) => s.patchLocalOrder)
  const online = useNetStore((s) => s.online)

  const orders = useMemo<MergedQueueOrder[]>(() => {
    const echo: MergedQueueOrder[] = Object.values(localOrders)
      .filter((lo) => lo.status !== 'synced' && !lo.localFulfilled && lo.lines.length > 0)
      // counter-эхо появляется после оплаты (есть чек); столы — сразу
      .filter((lo) => lo.kind === 'table' || lo.receipt !== null)
      // после синка place сервер уже отдаёт заказ — эхо не дублируем
      .filter((lo) => !(lo.serverOrderId && serverOrders.some((o) => o.id === lo.serverOrderId)))
      .map((lo) => ({
        id: lo.key,
        daily_number: lo.serverDailyNumber ?? 0,
        localNumber: lo.provisionalNumber ?? undefined,
        order_type: lo.orderType,
        customer_name: lo.customerName || null,
        table_label: lo.tableLabel,
        status: 'paid',
        paid_at: lo.createdAt,
        created_at: lo.createdAt,
        isLocal: true,
        order_items: lo.lines.map((l) => ({
          id: l.key,
          name: l.name,
          variant_name: l.variantName,
          qty: l.qty,
          notes: l.notes || null,
          station_id: null,
          prep_status: (lo.readyLineKeys ?? []).includes(l.key) ? ('ready' as const) : ('pending' as const),
          order_item_modifiers: l.mods.map((m) => ({ name: m.name })),
        })),
      }))
    return [...serverOrders, ...echo].sort((a, b) => a.created_at.localeCompare(b.created_at))
  }, [serverOrders, localOrders])

  // Выбранная станция запоминается на устройстве
  const [station, setStation] = useState<string>(() => localStorage.getItem(STATION_KEY) ?? 'all')
  useEffect(() => { localStorage.setItem(STATION_KEY, station) }, [station])

  // Тема экрана (по умолчанию тёмная — комфортнее за стойкой), запоминается на устройстве
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) as Theme) ?? 'dark')
  useEffect(() => { localStorage.setItem(THEME_KEY, theme) }, [theme])
  const c = THEMES[theme]

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

  // Готовность позиции: эхо — локальная отметка; серверный заказ офлайн —
  // операция в очередь + оптимистичный кэш (mark_*_ready идемпотентны)
  function handleItemReady(order: MergedQueueOrder, itemId: string, ready: boolean) {
    if (order.isLocal) {
      const lo = localOrders[order.id]
      if (!lo) return
      const keys = new Set(lo.readyLineKeys ?? [])
      if (ready) keys.add(itemId)
      else keys.delete(itemId)
      patchLocalOrder(order.id, { readyLineKeys: [...keys] })
      return
    }
    if (!online) {
      enqueueItemReady(itemId, ready)
      qc.setQueryData<QueueOrder[]>(['queue'], (old) =>
        old?.map((o) =>
          o.id === order.id
            ? { ...o, order_items: o.order_items.map((i) => (i.id === itemId ? { ...i, prep_status: ready ? 'ready' : 'pending' } : i)) }
            : o
        )
      )
      return
    }
    readyItem.mutate({ id: itemId, ready })
  }

  function handleAllReady(order: MergedQueueOrder) {
    if (order.isLocal) {
      patchLocalOrder(order.id, { localFulfilled: true })
      return
    }
    if (!online) {
      enqueueOrderReady(order.id)
      qc.setQueryData<QueueOrder[]>(['queue'], (old) => old?.filter((o) => o.id !== order.id))
      return
    }
    readyOrder.mutate(order.id)
  }

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

      {/* Рабочая область — тема переключается баристой */}
      <main className={`flex-1 min-w-0 ${c.main} rounded-3xl flex flex-col overflow-hidden transition-colors`}>
        {/* Шапка: фильтр по станциям + переключатель темы + счётчик */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${c.border} shrink-0`}>
          <div className="flex gap-2 overflow-x-auto">
            <StationChip active={station === 'all'} theme={c} onClick={() => setStation('all')}>
              {t(lang, 'all')}
            </StationChip>
            {stations.map((s) => (
              <StationChip key={s.id} active={station === s.id} theme={c} onClick={() => setStation(s.id)}>
                {s.name}
              </StationChip>
            ))}
          </div>
          <div className="flex items-center gap-3 ms-3 shrink-0">
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg transition-all active:scale-[0.9] ${c.chipIdle}`}
              title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
            <span className={`text-sm ${c.hintText} whitespace-nowrap`}>
              {t(lang, 'waitingCount')}: <span className={`font-bold tabular-nums ${c.countText}`}>{visibleOrders.length}</span>
            </span>
          </div>
        </div>

        {/* Сетка карточек */}
        <div className="flex-1 overflow-y-auto p-4">
          {visibleOrders.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <div className={`text-5xl mb-3 ${c.emptyIcon}`}>✓</div>
              <p className={`font-bold ${c.emptyTitle}`}>{t(lang, 'queueEmpty')}</p>
              <p className={`text-sm mt-1 ${c.hintText}`}>{t(lang, 'queueEmptyHint')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {visibleOrders.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  lang={lang}
                  theme={c}
                  onItemReady={(id, ready) => handleItemReady(order, id, ready)}
                  onAllReady={() => handleAllReady(order)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

type ThemeStyles = typeof THEMES[Theme]

function OrderCard({
  order, lang, theme, onItemReady, onAllReady,
}: {
  order: MergedQueueOrder
  lang: 'ru' | 'he'
  theme: ThemeStyles
  onItemReady: (id: string, ready: boolean) => void
  onAllReady: () => void
}) {
  const waited = elapsed(order.paid_at ?? order.created_at, lang)
  const allReady = order.order_items.every((i) => i.prep_status === 'ready')

  return (
    <div className={`rounded-2xl border ${theme.card} flex flex-col overflow-hidden animate-[rise-in_0.18s_ease-out]`}>
      {/* Заголовок карточки */}
      <div className={`flex items-center justify-between px-4 py-3 border-b ${theme.cardBorder}`}>
        <div className="flex items-baseline gap-2">
          {/* Эхо офлайн-заказа показывает локальный номер K-n */}
          <span className={`text-2xl font-black tabular-nums ${theme.number}`}>
            {order.localNumber ?? `#${order.daily_number}`}
          </span>
          {order.table_label ? (
            <span className={`text-xs font-bold uppercase tracking-wide ${theme.number}`}>
              {t(lang, 'tableLabel')} {order.table_label}
            </span>
          ) : order.source === 'site' ? (
            // Онлайн-заказ (050): бариста видит источник и «к какому времени»
            <span className={`text-xs font-bold uppercase tracking-wide ${theme.number}`}>
              {t(lang, 'onlineBadge')}
              {order.pickup_at && ` · ${formatTime(order.pickup_at, lang)}`}
            </span>
          ) : (
            <span className={`text-xs font-semibold uppercase tracking-wide ${theme.itemDetailIdle}`}>
              {orderTypeLabel(lang, order.order_type)}
            </span>
          )}
        </div>
        <span className={`text-xs tabular-nums ${theme.itemDetailIdle}`}>{waited}</span>
      </div>

      {order.customer_name && (
        <div className={`px-4 pt-2 text-sm font-semibold ${theme.customer}`}>{order.customer_name}</div>
      )}

      {/* Позиции — тап отмечает готовой */}
      <div className="flex-1 p-2 space-y-1">
        {order.order_items.map((item) => (
          <ItemRow key={item.id} item={item} theme={theme} onToggle={() => onItemReady(item.id, item.prep_status !== 'ready')} />
        ))}
      </div>

      {/* Кнопка «всё готово» */}
      <button
        onClick={onAllReady}
        disabled={allReady}
        className={`m-2 mt-0 min-h-[48px] rounded-xl font-bold text-sm active:scale-[0.97] transition-all
                    disabled:bg-emerald-500 disabled:text-white disabled:opacity-100 ${theme.allReadyBtn}`}
      >
        {allReady ? `✓ ${t(lang, 'allReady')}` : t(lang, 'allReady')}
      </button>
    </div>
  )
}

function ItemRow({ item, theme, onToggle }: { item: QueueItem; theme: ThemeStyles; onToggle: () => void }) {
  const ready = item.prep_status === 'ready'
  const details = [item.variant_name, ...item.order_item_modifiers.map((m) => m.name), item.notes]
    .filter(Boolean)
    .join(' · ')

  return (
    <button
      onClick={onToggle}
      className={`w-full text-start rounded-xl px-3 min-h-[48px] py-2.5 flex items-start gap-2.5 transition-all active:scale-[0.98] ${
        ready ? theme.itemReady : theme.itemIdle
      }`}
    >
      <span
        className={`mt-0.5 w-6 h-6 rounded-md shrink-0 flex items-center justify-center text-xs font-bold transition-colors ${
          ready ? 'bg-emerald-500 text-white' : theme.checkboxIdle
        }`}
      >
        {ready ? '✓' : ''}
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block text-sm font-semibold leading-tight ${ready ? theme.itemNameReady : theme.itemNameIdle}`}>
          {item.qty > 1 && <span className="tabular-nums">{item.qty}× </span>}
          {item.name}
        </span>
        {details && <span className={`block text-xs mt-0.5 ${ready ? theme.itemDetailReady : theme.itemDetailIdle}`}>{details}</span>}
      </span>
    </button>
  )
}

function StationChip({ active, theme, onClick, children }: { active: boolean; theme: ThemeStyles; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-11 px-4 rounded-xl text-sm font-semibold whitespace-nowrap transition-all active:scale-[0.96] ${
        active ? theme.chipActive : theme.chipIdle
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
