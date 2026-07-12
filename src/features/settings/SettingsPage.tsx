import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchCurrentLocation } from '../auth/api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t, type TranslationKey } from '../../lib/i18n'
import AppSidebar from '../../components/AppSidebar'
import { CATEGORIES, SEARCH_INDEX, type CategoryId, type DetailId } from './registry'
import { DetailHeader, Group, NavRow } from './ui'
import PaymentsSection from './sections/PaymentsSection'
import TippingDetail from './sections/TippingDetail'
import QuickAmountsDetail from './sections/QuickAmountsDetail'
import PayMethodsDetail from './sections/PayMethodsDetail'
import ReceiptsSection from './sections/ReceiptsSection'
import ServiceSection from './sections/ServiceSection'
import ServiceModeDetail from './sections/ServiceModeDetail'
import OnlineOrdersDetail from './sections/OnlineOrdersDetail'
import ReservationsDetail from './sections/ReservationsDetail'
import TablesDetail from './sections/TablesDetail'
import ShiftSection from './sections/ShiftSection'
import LoyaltySection from './sections/LoyaltySection'
import GuestsDetail from './sections/GuestsDetail'
import StaffSection from './sections/StaffSection'
import PermsDetail from './sections/PermsDetail'
import OfflineBanner from '../../components/OfflineBanner'
import BusinessSection from './sections/BusinessSection'
import ReceiptDetailsDetail from './sections/ReceiptDetailsDetail'
import DeviceSection from './sections/DeviceSection'
import ProfileDetail from './sections/ProfileDetail'

/** Стартовая категория — запоминаем на время сессии (возврат в настройки открывает то же место) */
const CAT_KEY = 'kassa-settings-cat'
function initialCat(): CategoryId {
  const saved = sessionStorage.getItem(CAT_KEY)
  return CATEGORIES.some((c) => c.id === saved) ? (saved as CategoryId) : 'payments'
}

const DETAIL_TITLES: Record<DetailId, TranslationKey> = {
  tipping: 'tipTitle',
  'quick-amounts': 'quickAmountsTitle',
  'pay-methods': 'payMethodsTitle',
  'service-mode': 'serviceModeTitle',
  'online-orders': 'onlineOrders',
  reservations: 'reservationsTitle',
  tables: 'tablesManage',
  loyalty: 'loyaltyTitle',
  guests: 'guestsTitle',
  perms: 'permsTitle',
  'receipt-details': 'receiptDetailsTitle',
  profile: 'profileTitle',
}

/**
 * Настройки v2 (стиль Square): левая навигация категорий с поиском,
 * справа — строки-настройки категории или drill-down деталь с «Назад».
 * Доступ manager+ (гейт на уровне маршрута/плиток).
 */
export default function SettingsPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const deviceName = useDeviceStore((s) => s.deviceName)

  const [cat, setCat] = useState<CategoryId>(initialCat)
  const [detail, setDetail] = useState<DetailId | null>(null)
  const [query, setQuery] = useState('')

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })

  function go(nextCat: CategoryId, nextDetail: DetailId | null = null) {
    setCat(nextCat)
    setDetail(nextDetail)
    setQuery('')
    sessionStorage.setItem(CAT_KEY, nextCat)
  }

  // Поиск: фильтр реестра по переведённому названию и подсказке
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return SEARCH_INDEX.filter((e) => {
      const label = t(lang, e.label).toLowerCase()
      const hint = e.hint ? t(lang, e.hint).toLowerCase() : ''
      return label.includes(q) || hint.includes(q)
    })
  }, [query, lang])

  const openDetail = (id: DetailId) => setDetail(id)

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="settings" />

      <main className="flex-1 bg-white rounded-3xl flex overflow-hidden">
        {/* Левая колонка: поиск + категории */}
        <nav className="w-72 shrink-0 border-e border-gray-100 p-4 flex flex-col gap-4 overflow-y-auto">
          <h1 className="text-2xl font-black text-gray-900 px-2 pt-2">{t(lang, 'settingsTitle')}</h1>
          <OfflineBanner />

          <div className="relative">
            <svg
              className="w-4 h-4 text-gray-400 absolute start-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              viewBox="0 0 16 16" fill="none" aria-hidden
            >
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              className="input !ps-10"
              placeholder={t(lang, 'searchSettings')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {/* Карточка-профиль заведения: тап открывает редактирование (052) */}
          <button
            onClick={() => go('business', 'profile')}
            className="rounded-2xl border border-gray-100 bg-gray-50 hover:bg-gray-100 px-4 py-3 flex items-center gap-3 text-start transition-colors"
          >
            {location?.logo_url ? (
              <img src={location.logo_url} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
            ) : (
              <span className="w-10 h-10 rounded-full bg-gray-900 text-white font-bold flex items-center justify-center shrink-0">
                {(location?.settings?.display_name || location?.receipt_business_name || location?.name || '?').slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="min-w-0">
              <span className="block text-sm font-bold text-gray-900 truncate">
                {location?.settings?.display_name || location?.receipt_business_name || location?.name || '…'}
                {deviceName && <span className="text-gray-400 font-semibold"> · {deviceName}</span>}
              </span>
              {staff && (
                <span className="block text-xs text-gray-500 mt-0.5 truncate">
                  {staff.name} · {t(lang, staff.role)}
                </span>
              )}
            </span>
          </button>

          <div className="flex flex-col gap-0.5">
            {CATEGORIES.map((c) => {
              const active = !query && cat === c.id
              return (
                <button
                  key={c.id}
                  onClick={() => go(c.id)}
                  className={`h-11 px-4 rounded-xl text-sm text-start transition-colors ${
                    active
                      ? 'bg-gray-900/[0.05] font-bold text-gray-900'
                      : 'font-semibold text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  {t(lang, c.label)}
                </button>
              )
            })}
          </div>
        </nav>

        {/* Правая панель: результаты поиска / деталь / категория */}
        <section className="flex-1 overflow-y-auto">
          <div className="max-w-2xl p-6 lg:p-8">
            {results ? (
              <>
                <h2 className="text-xl font-black text-gray-900 mb-6">{t(lang, 'searchResults')}</h2>
                {results.length === 0 ? (
                  <p className="text-sm text-gray-500">{t(lang, 'noSettingsFound')}</p>
                ) : (
                  <Group>
                    {results.map((r, i) => (
                      <NavRow
                        key={i}
                        label={t(lang, r.label)}
                        hint={r.hint ? t(lang, r.hint) : undefined}
                        value={t(lang, CATEGORIES.find((c) => c.id === r.cat)!.label)}
                        onClick={() => go(r.cat, r.detail ?? null)}
                      />
                    ))}
                  </Group>
                )}
              </>
            ) : detail ? (
              // key на detail → перерисовка запускает rise-in при входе в drill-down
              <div key={detail} className="animate-[rise-in_0.2s_ease-out]">
                <DetailHeader title={t(lang, DETAIL_TITLES[detail])} onBack={() => setDetail(null)} />
                {detail === 'tipping' && <TippingDetail />}
                {detail === 'quick-amounts' && <QuickAmountsDetail />}
                {detail === 'pay-methods' && <PayMethodsDetail />}
                {detail === 'service-mode' && <ServiceModeDetail location={location} openDetail={openDetail} />}
                {detail === 'online-orders' && <OnlineOrdersDetail location={location} />}
                {detail === 'reservations' && <ReservationsDetail location={location} />}
                {detail === 'tables' && <TablesDetail />}
                {detail === 'loyalty' && <LoyaltySection location={location} openDetail={openDetail} />}
                {detail === 'guests' && <GuestsDetail location={location} />}
                {detail === 'perms' && <PermsDetail location={location} />}
                {detail === 'receipt-details' && <ReceiptDetailsDetail location={location} />}
                {detail === 'profile' && <ProfileDetail key={location?.id ?? 'no-loc'} location={location} />}
              </div>
            ) : (
              // key на cat → плавная смена при переключении категории
              <div key={cat} className="animate-[rise-in_0.2s_ease-out]">
                <h2 className="text-xl font-black text-gray-900 mb-6">
                  {t(lang, CATEGORIES.find((c) => c.id === cat)!.label)}
                </h2>
                {cat === 'payments' && <PaymentsSection location={location} openDetail={openDetail} />}
                {cat === 'receipts' && <ReceiptsSection location={location} />}
                {cat === 'service' && <ServiceSection location={location} openDetail={openDetail} />}
                {cat === 'shift' && <ShiftSection location={location} />}
                {cat === 'staff' && <StaffSection openDetail={openDetail} />}
                {cat === 'business' && <BusinessSection location={location} openDetail={openDetail} />}
                {cat === 'device' && <DeviceSection location={location} />}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
