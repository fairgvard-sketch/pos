import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useSettingsStore } from '../../store/settingsStore'
import { t } from '../../lib/i18n'
import LangToggle from '../../components/ui/LangToggle'

const allTiles: { key: string; path: string; label: { ru: string; he: string }; d: string; venueTypes?: ('restaurant' | 'retail')[] }[] = [
  {
    key: 'sales',
    path: '/tables',
    label: { ru: 'Продажи', he: 'מכירות' },
    d: 'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z',
    venueTypes: ['restaurant'],
  },
  {
    key: 'retail',
    path: '/retail',
    label: { ru: 'Новая продажа', he: 'מכירה חדשה' },
    d: 'M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z',
    venueTypes: ['retail'],
  },
  {
    key: 'kitchen',
    path: '/kitchen',
    label: { ru: 'Кухня', he: 'מטבח' },
    d: 'M6 14.5V18a1 1 0 001 1h10a1 1 0 001-1v-3.5M6 14.5A6 6 0 0112 2a6 6 0 016 12.5M6 14.5h12',
    venueTypes: ['restaurant'],
  },
  {
    key: 'analytics',
    path: '/manager',
    label: { ru: 'Аналитика', he: 'אנליטיקה' },
    d: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
  },
  {
    key: 'reports',
    path: '/reports',
    label: { ru: 'Отчёты X/Z', he: 'דוחות X/Z' },
    d: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z',
  },
  {
    key: 'loyalty',
    path: '/loyalty',
    label: { ru: 'Лояльность', he: 'מועדון לקוחות' },
    d: 'M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z',
  },
  {
    key: 'settings',
    path: '/settings',
    label: { ru: 'Настройки', he: 'הגדרות' },
    d: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  },
  {
    key: 'refund',
    path: '/refund',
    label: { ru: 'Возврат', he: 'החזר' },
    d: 'M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3',
  },
]

export default function HubPage() {
  const navigate = useNavigate()
  const staff = useAuthStore((s) => s.currentStaff)
  const logout = useAuthStore((s) => s.logout)
  const lang = useLangStore((s) => s.lang)
  const venueType = useSettingsStore((s) => s.venueType)

  const tiles = allTiles.filter((t) => !t.venueTypes || t.venueTypes.includes(venueType))

  return (
    <div className="min-h-screen bg-[#f8f9fb] flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-100 h-14 px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gray-900 rounded-xl flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <span className="font-bold text-gray-900 text-sm">{t(lang, 'appName')}</span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{staff?.name}</span>
          <LangToggle />
          <button
            onClick={() => { logout(); navigate('/') }}
            className="btn-ghost px-3 py-1.5 text-xs text-gray-500"
          >
            {lang === 'he' ? 'יציאה' : 'Выйти'}
          </button>
        </div>
      </header>

      {/* Tiles */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4 text-center">
            {lang === 'he' ? 'בחר מצב' : 'Выберите раздел'}
          </p>
          <div className="grid grid-cols-4 gap-4">
            {tiles.map((tile) => (
              <button
                key={tile.key}
                onClick={() => navigate(tile.path)}
                className="card-hover flex flex-col items-center justify-center gap-3 rounded-2xl py-7 px-3 transition-all duration-150 active:scale-[0.97]"
              >
                <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={tile.d} />
                </svg>
                <span className="font-semibold text-gray-900 text-xs text-center leading-tight">{tile.label[lang]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
