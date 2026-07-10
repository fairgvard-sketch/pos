import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useLangStore } from '../store/langStore'
import { useCartStore } from '../store/cartStore'
import { fetchCurrentLocation } from '../features/auth/api'
import { voidTableOrder } from '../features/tables/api'
import { useOutboxStore } from '../lib/offline/outboxStore'
import { enqueueTableVoid } from '../lib/offline/enqueue'
import { t } from '../lib/i18n'
import Icon from './Icon'
import type { IconName } from './Icon'
import LangToggle from './ui/LangToggle'
import OfflineBadge from './OfflineBadge'

export type SidebarPage = 'sell' | 'hall' | 'queue' | 'transactions' | 'shift' | 'timesheet' | 'menu' | 'analytics' | 'settings'

/** Общий сайдбар кассы: навигация, часы, сотрудник */
export default function AppSidebar({ active }: { active: SidebarPage }) {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const staff = useAuthStore((s) => s.staff)
  const lock = useAuthStore((s) => s.lock)

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const qc = useQueryClient()
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
      <div className="px-2 pt-1 pb-5 text-center">
        <div className="font-medium text-gray-900 tracking-[0.25em] text-lg leading-none uppercase">VANDAL</div>
        <div className="text-[10px] font-semibold text-gray-400 tracking-[0.35em] uppercase mt-1">Coffee</div>
      </div>

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
        <SideLink active={active === 'transactions'} label={t(lang, 'transactions')} iconName="card" onClick={() => navigate('/transactions')} />
        <SideLink active={active === 'shift'} label={t(lang, 'shift')} iconName="shift" onClick={() => navigate('/shift')} />
        <SideLink active={active === 'timesheet'} label={t(lang, 'timesheet')} iconName="customers" onClick={() => navigate('/timesheet')} />
        {isManager && (
          <SideLink active={active === 'menu'} label={t(lang, 'menu')} iconName="menu" onClick={() => navigate('/menu')} />
        )}
        {isManager && (
          <SideLink active={active === 'analytics'} label={t(lang, 'reports')} iconName="analytics" onClick={() => navigate('/reports')} />
        )}
        {isManager && (
          <SideLink active={active === 'settings'} label={t(lang, 'settings')} iconName="settings" onClick={() => navigate('/settings')} />
        )}
        <SideLink label={t(lang, 'lock')} iconName="customers" onClick={() => { lock(); navigate('/pin', { replace: true }) }} />
      </nav>

      <div className="mt-auto space-y-4">
        <OfflineBadge />
        <div className="px-2">
          <LangToggle />
        </div>
        <Clock lang={lang} />
        <div className="flex items-center gap-2.5 px-2">
          <div className="w-9 h-9 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold shrink-0">
            {staff.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-gray-900 truncate">{staff.name}</div>
            <div className="text-[11px] text-gray-400">{t(lang, staff.role)}</div>
          </div>
        </div>
      </div>
    </aside>
  )
}

function SideLink({ label, iconName, active, onClick }: { label: string; iconName: IconName; active?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 h-11 rounded-xl text-sm font-semibold transition-all ${
        active ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
      }`}
    >
      <Icon name={iconName} isActive={active} size={20} />
      {label}
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
