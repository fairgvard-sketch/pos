import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchCurrentLocation } from '../auth/api'
import { useLangStore } from '../../store/langStore'
import { t, type TranslationKey } from '../../lib/i18n'
import AppSidebar from '../../components/AppSidebar'
import BusinessTab from './BusinessTab'
import ServiceTab from './ServiceTab'
import StaffTab from './StaffTab'
import DeviceTab from './DeviceTab'

type Tab = 'business' | 'service' | 'staff' | 'device'

const TABS: { id: Tab; label: TranslationKey }[] = [
  { id: 'business', label: 'tabBusiness' },
  { id: 'service', label: 'tabService' },
  { id: 'staff', label: 'tabStaff' },
  { id: 'device', label: 'tabDevice' },
]

/** Настройки точки: табы «Бизнес / Обслуживание / Сотрудники» (доступ manager+) */
export default function SettingsPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const [tab, setTab] = useState<Tab>('business')

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="settings" />

      <main className="flex-1 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-6 pb-0 shrink-0">
          <h1 className="text-2xl font-black text-gray-900 mb-4">{t(lang, 'settingsTitle')}</h1>

          <div className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={`h-10 px-4 rounded-lg text-sm font-semibold transition-all ${
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

        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'business' && <BusinessTab location={location} />}
          {tab === 'service' && <ServiceTab location={location} />}
          {tab === 'staff' && <StaffTab />}
          {tab === 'device' && <DeviceTab />}
        </div>
      </main>
    </div>
  )
}
