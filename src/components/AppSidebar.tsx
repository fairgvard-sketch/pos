import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import { useLangStore } from '../store/langStore'
import { fetchCurrentLocation } from '../features/auth/api'
import { t } from '../lib/i18n'
import Icon from './Icon'
import type { IconName } from './Icon'

export type SidebarPage = 'sell' | 'hall' | 'queue' | 'shift' | 'menu' | 'analytics' | 'settings'

/** Общий сайдбар кассы: навигация, часы, сотрудник */
export default function AppSidebar({ active }: { active: SidebarPage }) {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const staff = useAuthStore((s) => s.staff)
  const lock = useAuthStore((s) => s.lock)

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })

  if (!staff) return null
  const isManager = staff.role === 'owner' || staff.role === 'manager'
  const showHall = location?.service_mode === 'tables'

  return (
    <aside className="w-52 shrink-0 bg-white rounded-3xl flex flex-col p-4">
      <div className="px-2 pt-1 pb-5 text-center">
        <div className="font-medium text-gray-900 tracking-[0.25em] text-lg leading-none uppercase">VANDAL</div>
        <div className="text-[10px] font-semibold text-gray-400 tracking-[0.35em] uppercase mt-1">Coffee</div>
      </div>

      <nav className="space-y-1">
        <SideLink active={active === 'sell'} label={t(lang, 'sell')} iconName="orders" onClick={() => navigate('/sell')} />
        {showHall && (
          <SideLink active={active === 'hall'} label={t(lang, 'hall')} iconName="customers" onClick={() => navigate('/hall')} />
        )}
        <SideLink active={active === 'queue'} label={t(lang, 'queue')} iconName="queue" onClick={() => navigate('/queue')} />
        <SideLink active={active === 'shift'} label={t(lang, 'shift')} iconName="shift" onClick={() => navigate('/shift')} />
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
