import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { Toaster } from 'react-hot-toast'
import { supabase } from './lib/supabase'
import { initNet, OfflineError } from './lib/offline/net'
import { initDrain } from './lib/offline/drain'
import DeviceSetupPage from './features/auth/DeviceSetupPage'
import PinLoginPage from './features/auth/PinLoginPage'
import ProtectedRoute from './features/auth/ProtectedRoute'
import SellPage from './features/sell/SellPage'
import QueuePage from './features/queue/QueuePage'
import HallPage from './features/tables/HallPage'
import AutoLock from './components/AutoLock'
import BrandSplash from './components/ui/BrandSplash'

// Горячий путь кассира (PIN → продажа/зал/очередь) — статика, в стартовом чанке.
// Менеджерские экраны — lazy: не тормозят парсинг на слабом CPU терминала,
// подгружаются при первом заходе (и кэшируются SW наравне с основным бандлом).
const MenuPage = lazy(() => import('./features/menu/MenuPage'))
const OnlineOrdersPage = lazy(() => import('./features/online/OnlineOrdersPage'))
// Публичная страница заказа для гостей (050) — без auth, ходит в Edge Functions
const PublicOrderPage = lazy(() => import('./features/online/PublicOrderPage'))
const ShiftPage = lazy(() => import('./features/shift/ShiftPage'))
const TimesheetPage = lazy(() => import('./features/timesheet/TimesheetPage'))
const TransactionsPage = lazy(() => import('./features/transactions/TransactionsPage'))
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'))
const ReportsPage = lazy(() => import('./features/reports/ReportsPage'))
const DashboardPage = lazy(() => import('./features/dashboard/DashboardPage'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // Данные из кэша остаются валидными и офлайн — не мигают при обрыве
      refetchOnReconnect: true,
    },
    mutations: {
      // 'always': офлайн обрабатывают сами mutationFn (withOfflineFallback →
      // очередь фазы 7). Дефолтный 'online' ставил mutate() на ПАУЗУ при
      // onlineManager.offline — офлайн-ветка не выполнялась, isPending висел
      // вечно и кнопки продажи/столов замирали серыми.
      networkMode: 'always',
      // OfflineError не ретраим: это осознанный «мы офлайн» из withOfflineFallback,
      // повтор бессмысленен и лишь задерживает тост offlineBlockedHint
      retry: (failureCount, error) => !(error instanceof OfflineError) && failureCount < 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
  },
})

// Каталог и точка меняются редко — 5 минут без фоновых рефетчей при каждом
// переходе зал↔продажа↔очередь (меньше сети и батареи терминала). Правки
// меню/настроек инвалидируют эти ключи явно, так что свежесть не страдает.
// gcTime 7 дней: эти ключи переживают перезагрузку через localStorage-кэш
// (см. PERSIST_KEYS) — холодный старт офлайн получает каталог/смену/столы.
const STATIC_5MIN = { staleTime: 5 * 60_000, gcTime: 7 * 24 * 3600_000 }
for (const key of ['menu_categories', 'menu_items', 'modifier_groups', 'current_location', 'current_shift', 'tables']) {
  queryClient.setQueryDefaults([key], STATIC_5MIN)
}

// ── Офлайн (фаза 7): read-кэш + очередь мутаций ─────────────
// Данные для работы без сети: каталог, точка (НДС/реквизиты чека),
// последняя смена, столы. Остальные ключи (заказы, отчёты) не персистятся —
// они либо realtime, либо не нужны офлайн.
const PERSIST_KEYS = new Set(['menu_categories', 'menu_items', 'modifier_groups', 'current_location', 'current_shift', 'tables'])
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'kassa-query-cache',
  // Реже пишем в localStorage — main thread терминала (Android 7.1) не блокируем
  throttleTime: 2000,
})

initNet()          // детекция сети (события браузера + проба Supabase)
initDrain(queryClient)  // движок replay офлайн-очереди

/** "/" → куда нужно: нет сессии устройства → /setup, есть → /pin */
function RootRedirect() {
  const [target, setTarget] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        setTarget('/setup')
      } else if (!data.session.user.app_metadata?.org_id) {
        setTarget('/setup')
      } else {
        setTarget('/pin')
      }
    })
  }, [])

  if (!target) return null
  return <Navigate to={target} replace />
}

export default function App() {
  // Гостевая страница заказа — без сплэша кассы: гостю нужен сразу контент
  const showSplash = !window.location.pathname.startsWith('/order/')
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 7 * 24 * 3600_000,
        buster: __APP_VERSION__, // новая версия приложения сбрасывает кэш
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => PERSIST_KEYS.has(String(q.queryKey[0])) && q.state.status === 'success',
        },
      }}
    >
      <BrowserRouter>
        <AutoLock />
        {/* fallback null: чанк приходит из SW-кэша за миллисекунды, спиннер только мигал бы */}
        <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/setup" element={<DeviceSetupPage />} />
          <Route path="/pin" element={<PinLoginPage />} />

          <Route
            path="/sell"
            element={
              <ProtectedRoute>
                <SellPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/hall"
            element={
              <ProtectedRoute>
                <HallPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/queue"
            element={
              <ProtectedRoute>
                <QueuePage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/online"
            element={
              <ProtectedRoute>
                <OnlineOrdersPage />
              </ProtectedRoute>
            }
          />

          {/* Гость сайта: меню и «закажи и забери» (050). Публичный маршрут. */}
          <Route path="/order/:locId" element={<PublicOrderPage />} />

          <Route
            path="/shift"
            element={
              <ProtectedRoute>
                <ShiftPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/timesheet"
            element={
              <ProtectedRoute>
                <TimesheetPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/transactions"
            element={
              <ProtectedRoute>
                <TransactionsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/menu"
            element={
              <ProtectedRoute allowedRoles={['owner', 'manager']}>
                <MenuPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/reports"
            element={
              <ProtectedRoute allowedRoles={['owner', 'manager']}>
                <ReportsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/settings"
            element={
              <ProtectedRoute allowedRoles={['owner', 'manager']}>
                <SettingsPage />
              </ProtectedRoute>
            }
          />

          {/* Дашборд владельца: mobile-first, выручка с телефона (049) */}
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute allowedRoles={['owner', 'manager']}>
                <DashboardPage />
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>

      {showSplash && <BrandSplash />}

      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: {
            borderRadius: '12px',
            background: '#1f2937',
            color: '#f9fafb',
            fontSize: '14px',
          },
          success: { iconTheme: { primary: '#22c55e', secondary: '#f9fafb' } },
          error: { iconTheme: { primary: '#ef4444', secondary: '#f9fafb' } },
        }}
      />
    </PersistQueryClientProvider>
  )
}
