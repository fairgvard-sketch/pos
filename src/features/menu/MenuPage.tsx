import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLangStore } from '../../store/langStore'
import { t, type TranslationKey } from '../../lib/i18n'
import LangToggle from '../../components/ui/LangToggle'
import ItemsTab from './ItemsTab'
import ModifierGroupsTab from './ModifierGroupsTab'
import StationsTab from './StationsTab'

type Tab = 'items' | 'modifiers' | 'stations'

const TABS: { id: Tab; label: TranslationKey }[] = [
  { id: 'items', label: 'items' },
  { id: 'modifiers', label: 'modifiersTab' },
  { id: 'stations', label: 'stations' },
]

export default function MenuPage() {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const [tab, setTab] = useState<Tab>('items')

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#f8f9fb]">
      <header className="page-header">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/home')} className="btn-ghost !px-2">
            {isRtl ? '→' : '←'}
          </button>
          <h1 className="font-bold text-gray-900">{t(lang, 'menu')}</h1>
          <div className="flex rounded-xl overflow-hidden border border-gray-200 bg-gray-50 p-0.5 gap-0.5">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150 ${
                  tab === tb.id
                    ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {t(lang, tb.label)}
              </button>
            ))}
          </div>
        </div>
        <LangToggle />
      </header>

      <main className="max-w-5xl mx-auto p-6">
        {tab === 'items' && <ItemsTab />}
        {tab === 'modifiers' && <ModifierGroupsTab />}
        {tab === 'stations' && <StationsTab />}
      </main>
    </div>
  )
}
