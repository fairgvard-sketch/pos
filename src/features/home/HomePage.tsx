import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t, type TranslationKey } from '../../lib/i18n'
import LangToggle from '../../components/ui/LangToggle'

interface Tile {
  key: TranslationKey
  path: string
  ready: boolean
  minRole?: 'manager'
}

const TILES: Tile[] = [
  { key: 'sell', path: '/sell', ready: true },
  { key: 'queue', path: '/queue', ready: false },
  { key: 'menu', path: '/menu', ready: true, minRole: 'manager' },
  { key: 'reports', path: '/reports', ready: false, minRole: 'manager' },
  { key: 'settings', path: '/settings', ready: false, minRole: 'manager' },
]

export default function HomePage() {
  const navigate = useNavigate()
  const staff = useAuthStore((s) => s.staff)
  const lock = useAuthStore((s) => s.lock)
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'

  if (!staff) return null
  const isManager = staff.role === 'owner' || staff.role === 'manager'

  function handleLock() {
    lock()
    navigate('/pin', { replace: true })
  }

  const visibleTiles = TILES.filter((tile) => !tile.minRole || isManager)

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#f8f9fb]">
      <header className="page-header">
        <div>
          <span className="font-bold text-gray-900">{t(lang, 'hello')}, {staff.name}</span>
          <span className="text-xs text-gray-400 ms-2">{t(lang, staff.role)}</span>
        </div>
        <div className="flex items-center gap-3">
          <LangToggle />
          <button onClick={handleLock} className="btn-secondary !px-4 !py-2">
            {t(lang, 'lock')}
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {visibleTiles.map((tile) => (
            <button
              key={tile.key}
              onClick={() => tile.ready && navigate(tile.path)}
              disabled={!tile.ready}
              className="card-hover p-6 text-start disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="text-lg font-bold text-gray-900">{t(lang, tile.key)}</div>
              {!tile.ready && (
                <div className="badge-gray mt-2">{t(lang, 'comingSoon')}</div>
              )}
            </button>
          ))}
        </div>
      </main>
    </div>
  )
}
