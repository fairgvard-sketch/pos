import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'

interface Props {
  active: 'sell' | 'menu'
}

/** Общий сайдбар кассы: навигация, часы, сотрудник */
export default function AppSidebar({ active }: Props) {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const staff = useAuthStore((s) => s.staff)
  const lock = useAuthStore((s) => s.lock)

  if (!staff) return null
  const isManager = staff.role === 'owner' || staff.role === 'manager'

  return (
    <aside className="w-52 shrink-0 bg-white rounded-3xl flex flex-col p-4">
      <div className="px-2 pt-1 pb-5">
        <span className="font-black text-gray-900 tracking-widest text-sm uppercase">Kassa</span>
      </div>

      <nav className="space-y-1">
        <SideLink active={active === 'sell'} label={t(lang, 'sell')} icon="▦" onClick={() => navigate('/sell')} />
        {isManager && (
          <SideLink active={active === 'menu'} label={t(lang, 'menu')} icon="≡" onClick={() => navigate('/menu')} />
        )}
        <SideLink label={t(lang, 'lock')} icon="◈" onClick={() => { lock(); navigate('/pin', { replace: true }) }} />
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

function SideLink({ label, icon, active, onClick }: { label: string; icon: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
        active ? 'bg-gray-100 text-gray-900' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50'
      }`}
    >
      <span className="text-base w-5 text-center">{icon}</span>
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
