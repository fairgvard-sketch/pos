import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useAuthStore } from '../store/authStore'
import { useLangStore } from '../store/langStore'
import { useCartStore } from '../store/cartStore'
import { fetchCurrentLocation } from '../features/auth/api'
import { voidTableOrder } from '../features/tables/api'
import { fetchOnlineOrders, subscribeOnlineOrders } from '../features/online/api'
import { fetchReservations, subscribeReservations } from '../features/reservations/api'
import { useOutboxStore } from '../lib/offline/outboxStore'
import { enqueueTableVoid } from '../lib/offline/enqueue'
import { playNewOrderChime, playReservationChime } from '../lib/sound'
import { t } from '../lib/i18n'
import { can } from '../lib/perms'
import Icon from './Icon'
import type { IconName } from './Icon'
import OfflineBadge from './OfflineBadge'

export type SidebarPage = 'sell' | 'hall' | 'queue' | 'online' | 'reservations' | 'transactions' | 'shift' | 'inventory' | 'timesheet' | 'menu' | 'analytics' | 'settings'

/** Общий сайдбар кассы: навигация, часы, сотрудник */
export default function AppSidebar({ active }: { active: SidebarPage }) {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const staff = useAuthStore((s) => s.staff)
  const lock = useAuthStore((s) => s.lock)

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const qc = useQueryClient()
  const tablesMode = location?.service_mode === 'tables'

  // ── Онлайн-заказы (050): бейдж + звонок. Сайдбар смонтирован на всех
  // рабочих экранах — уведомление о новой заявке глобальное. Realtime
  // основной канал, интервал — страховка от пропущенного события.
  const { data: onlineOrders = [] } = useQuery({
    queryKey: ['online_orders'],
    queryFn: fetchOnlineOrders,
    refetchInterval: 90_000,
  })
  useEffect(() => subscribeOnlineOrders(() => qc.invalidateQueries({ queryKey: ['online_orders'] })), [qc])
  const newOnlineCount = onlineOrders.filter((o) => o.status === 'new').length
  // Звонок при ПОЯВЛЕНИИ новой заявки (сравниваем множества id, не количество)
  const knownOnlineIds = useRef<Set<string> | null>(null)
  useEffect(() => {
    const ids = new Set(onlineOrders.filter((o) => o.status === 'new').map((o) => o.id))
    if (knownOnlineIds.current === null) {
      knownOnlineIds.current = ids // первый рендер после навигации — не звеним
      return
    }
    if ([...ids].some((id) => !knownOnlineIds.current!.has(id))) {
      playNewOrderChime()
      toast(t(lang, 'onlineNewToast'))
    }
    knownOnlineIds.current = ids
  }, [onlineOrders, lang])

  // ── Брони (053): бейдж + звонок, только в режиме столов. Отдельный
  // канал (уникальное имя!) и другой звук — гость мог и отменить бронь.
  const { data: reservations = [] } = useQuery({
    queryKey: ['reservations'],
    queryFn: fetchReservations,
    refetchInterval: 90_000,
    enabled: tablesMode,
  })
  useEffect(() => {
    if (!tablesMode) return
    return subscribeReservations(() => {
      qc.invalidateQueries({ queryKey: ['reservations'] })
      qc.invalidateQueries({ queryKey: ['reservations_today'] })
    })
  }, [qc, tablesMode])
  // Незапоздавшие новые заявки — правило секции «Новые» экрана броней.
  // Порог от момента монтирования: сайдбар пересоздаётся при каждой навигации
  const [resNowTs] = useState(() => Date.now())
  const newResCount = reservations.filter(
    (r) => r.status === 'new' && new Date(r.reserved_at).getTime() > resNowTs - 2 * 3600_000
  ).length
  // Звонок при появлении заявки; тост без звонка — когда гость отменил
  const knownResStatuses = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    const statuses = new Map(reservations.map((r) => [r.id, r.status]))
    if (knownResStatuses.current === null) {
      knownResStatuses.current = statuses // первый рендер после навигации — не звеним
      return
    }
    const prev = knownResStatuses.current
    let hasNew = false
    let hasCancelled = false
    statuses.forEach((status, id) => {
      const was = prev.get(id)
      if (status === 'new' && was === undefined) hasNew = true
      if (status === 'cancelled' && was !== undefined && was !== 'cancelled') hasCancelled = true
    })
    if (hasNew) {
      playReservationChime()
      toast(t(lang, 'reservationNewToast'))
    } else if (hasCancelled) {
      toast(t(lang, 'reservationCancelledToast'))
    }
    knownResStatuses.current = statuses
  }, [reservations, lang])

  const tableCtx = useCartStore((s) => s.tableCtx)
  const lines = useCartStore((s) => s.lines)
  const clearCart = useCartStore((s) => s.clear)

  // Уход в зал. Если открытый счёт стола так и остался пустым (зашли и вышли,
  // ничего не заказав) — отменяем пустышку, чтобы стол не числился занятым.
  // Офлайн-стол (эхо): open ещё не ушёл → снимаем операции; ушёл → void в очередь.
  function goHall() {
    const emptyOrder = !!tableCtx && tableCtx.existingTotal === 0 && lines.length === 0
    if (emptyOrder) {
      const key = tableCtx!.orderId
      const st = useOutboxStore.getState()
      const echo = st.localOrders[key]
      if (echo && echo.serverOrderId === null) {
        const openPending = st.ops.some((o) => o.orderKey === key && o.kind === 'table.open' && o.status === 'pending')
        if (openPending) st.dropUnsent(key)
        else {
          enqueueTableVoid({ orderKey: key, orderId: null })
          st.removeLocalOrder(key)
        }
      } else {
        voidTableOrder(key)
          .catch(() => {})
          .finally(() => qc.invalidateQueries({ queryKey: ['open_table_orders'] }))
      }
    }
    clearCart()
    navigate('/hall')
  }

  if (!staff) return null
  const isManager = staff.role === 'owner' || staff.role === 'manager'
  const showHall = tablesMode
  // В режиме столов «Продажа» — внутренний экран выбранного стола,
  // а не самостоятельный пункт навигации. Вход остаётся через «Зал».
  const showSell = !tablesMode

  return (
    <aside className="w-28 shrink-0 bg-white rounded-3xl flex flex-col p-2">
      <div className="h-2 shrink-0" />

      <nav className="space-y-1">
        {/* Режим столов: вход и возврат всегда через «Зал» */}
        {showHall && (
          <SideLink
            active={active === 'hall'}
            label={t(lang, 'hall')}
            iconName="customers"
            // Выход в зал сбрасывает контекст стола → «Продажа» снова скрывается,
            // пустой счёт отменяется, черновик дозаказа отбрасывается.
            onClick={goHall}
          />
        )}
        {tablesMode && (
          <SideLink
            active={active === 'reservations'}
            label={t(lang, 'reservationsTitle')}
            iconName="note"
            badge={newResCount}
            onClick={() => navigate('/reservations')}
          />
        )}
        {showSell && (
          <SideLink active={active === 'sell'} label={t(lang, 'sell')} iconName="orders" onClick={() => navigate('/sell')} />
        )}
        <SideLink active={active === 'queue'} label={t(lang, 'queue')} iconName="queue" onClick={() => navigate('/queue')} />
        <SideLink
          active={active === 'online'}
          label={t(lang, 'onlineTitle')}
          iconName="orders"
          badge={newOnlineCount}
          onClick={() => navigate('/online')}
        />
        <SideLink active={active === 'transactions'} label={t(lang, 'transactions')} iconName="card" onClick={() => navigate('/transactions')} />
        <SideLink active={active === 'shift'} label={t(lang, 'shift')} iconName="shift" onClick={() => navigate('/shift')} />
        {/* Склад (055): виден тем, кому доступен приход (право точки),
            и только если учёт остатков не выключен тумблером точки */}
        {location?.settings?.interface?.inventory_enabled !== false &&
          can(staff.role, 'stock_receive', location?.settings) && (
          <SideLink active={active === 'inventory'} label={t(lang, 'inventory')} iconName="note" onClick={() => navigate('/inventory')} />
        )}
        {/* Менеджерский блок отделён. Редкие экраны из сайдбара убраны:
            Табель — со страницы Смены, Меню — правка витрины на экране продажи
            (полная админка в Настройках → Бизнес), Дашборд — тоже там. */}
        {isManager && <div className="my-2 border-t border-gray-100" />}
        {isManager && (
          <SideLink active={active === 'analytics'} label={t(lang, 'reports')} iconName="analytics" onClick={() => navigate('/reports')} />
        )}
        {isManager && (
          <SideLink active={active === 'settings'} label={t(lang, 'settings')} iconName="settings" onClick={() => navigate('/settings')} />
        )}
      </nav>

      <div className="mt-auto space-y-2 pt-2">
        <OfflineBadge />
        <Clock lang={lang} />
        <div className="rounded-2xl bg-gray-50 p-2 text-center">
          <div className="w-9 h-9 mx-auto rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold">
            {staff.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 mt-1.5">
            <div className="text-xs font-bold text-gray-900 truncate">{staff.name}</div>
            <div className="text-[10px] text-gray-500 truncate">{t(lang, staff.role)}</div>
          </div>
          {/* Блокировка — действие, не страница: живёт у профиля, не в навигации */}
          <button
            onClick={() => { lock(); navigate('/pin', { replace: true }) }}
            aria-label={t(lang, 'lock')}
            title={t(lang, 'lock')}
            className="w-full h-11 mt-1 flex items-center justify-center rounded-xl text-gray-500
                       hover:text-gray-900 hover:bg-white transition-colors active:scale-[0.94]"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  )
}

function SideLink({ label, iconName, active, badge = 0, onClick }: { label: string; iconName: IconName; active?: boolean; badge?: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={`relative w-full h-14 px-1 rounded-xl flex flex-col items-center justify-center gap-1
                  text-[11px] leading-none font-semibold transition-all ${
        active ? 'bg-gray-200 text-gray-900' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
      }`}
    >
      <Icon name={iconName} isActive={active} size={19} />
      <span className="w-full text-center truncate">{label}</span>
      {badge > 0 && (
        <span className="absolute top-1.5 end-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-gray-900 text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
          {badge}
        </span>
      )}
    </button>
  )
}

function Clock({ lang }: { lang: 'ru' | 'he' }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])
  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  return (
    <div className="text-center px-1">
      <div className="text-lg font-black text-gray-900 tabular-nums">
        {now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="text-[10px] leading-tight text-gray-500">
        {now.toLocaleDateString(locale, { day: 'numeric', month: 'long', weekday: 'short' })}
      </div>
    </div>
  )
}
