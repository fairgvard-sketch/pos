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
import { useOutboxStore } from '../lib/offline/outboxStore'
import { enqueueTableVoid } from '../lib/offline/enqueue'
import { playNewOrderChime } from '../lib/sound'
import { t } from '../lib/i18n'
import Icon from './Icon'
import type { IconName } from './Icon'
import OfflineBadge from './OfflineBadge'

export type SidebarPage = 'sell' | 'hall' | 'queue' | 'online' | 'transactions' | 'shift' | 'timesheet' | 'menu' | 'analytics' | 'settings'

/** Общий сайдбар кассы: навигация, часы, сотрудник */
export default function AppSidebar({ active }: { active: SidebarPage }) {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const staff = useAuthStore((s) => s.staff)
  const lock = useAuthStore((s) => s.lock)

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const qc = useQueryClient()

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
  const tablesMode = location?.service_mode === 'tables'
  const showHall = tablesMode
  // В режиме столов «Продажа» — не точка входа: она открывается только когда
  // выбран стол (есть tableCtx). Без стола пункт скрыт, вход через зал.
  const showSell = !tablesMode || !!tableCtx

  return (
    <aside className="w-52 shrink-0 bg-white rounded-3xl flex flex-col p-4">
      <div className="pt-1 pb-5" />

      <nav className="space-y-1">
        {/* Режим столов: вход через зал, «Продажа» появляется только с выбранным столом */}
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
        {/* Менеджерский блок отделён. Редкие экраны из сайдбара убраны:
            Табель — со страницы Смены, Меню — правка витрины на экране продажи
            (полная админка в Настройках → Бизнес), Дашборд — тоже там. */}
        {isManager && <div className="my-3 border-t border-gray-100" />}
        {isManager && (
          <SideLink active={active === 'analytics'} label={t(lang, 'reports')} iconName="analytics" onClick={() => navigate('/reports')} />
        )}
        {isManager && (
          <SideLink active={active === 'settings'} label={t(lang, 'settings')} iconName="settings" onClick={() => navigate('/settings')} />
        )}
      </nav>

      <div className="mt-auto space-y-4">
        <OfflineBadge />
        <Clock lang={lang} />
        <div className="flex items-center gap-2.5 px-2">
          <div className="w-9 h-9 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold shrink-0">
            {staff.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-gray-900 truncate">{staff.name}</div>
            <div className="text-[11px] text-gray-400">{t(lang, staff.role)}</div>
          </div>
          {/* Блокировка — действие, не страница: живёт у профиля, не в навигации */}
          <button
            onClick={() => { lock(); navigate('/pin', { replace: true }) }}
            aria-label={t(lang, 'lock')}
            title={t(lang, 'lock')}
            className="shrink-0 w-11 h-11 -me-2 flex items-center justify-center rounded-xl text-gray-400
                       hover:text-gray-900 hover:bg-gray-50 transition-colors active:scale-[0.94]"
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
      className={`w-full flex items-center gap-3 px-3 h-11 rounded-xl text-sm font-semibold transition-all ${
        active ? 'bg-gray-200 text-gray-900' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
      }`}
    >
      <Icon name={iconName} isActive={active} size={20} />
      <span className="flex-1 text-start truncate">{label}</span>
      {badge > 0 && (
        <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-gray-900 text-white text-[11px] font-bold flex items-center justify-center tabular-nums">
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
    <div className="px-2">
      <div className="text-xl font-black text-gray-900 tabular-nums">
        {now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="text-[11px] text-gray-400">
        {now.toLocaleDateString(locale, { day: 'numeric', month: 'long', weekday: 'short' })}
      </div>
    </div>
  )
}
