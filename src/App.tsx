import { Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { Toaster } from 'react-hot-toast'
import { supabase } from './lib/supabase'
import { initNet, OfflineError } from './lib/offline/net'
import { initDrain } from './lib/offline/drain'
import { initScope } from './lib/offline/scope'
import { initDeviceSync } from './lib/deviceSync'
import { initOrientation } from './lib/orientation'
import { initTelemetry } from './lib/telemetry'
import DeviceSetupPage from './features/auth/DeviceSetupPage'
import PinLoginPage from './features/auth/PinLoginPage'
import ProtectedRoute from './features/auth/ProtectedRoute'
import SellPage from './features/sell/SellPage'
import AutoLock from './components/AutoLock'
import BrandSplash from './components/ui/BrandSplash'
import RouteErrorBoundary from './components/RouteErrorBoundary'
import SuspenseFallback from './components/ui/SuspenseFallback'
import { lazyWithRetry } from './lib/lazyWithRetry'

// Самый частый горячий путь (PIN → продажа) остаётся в стартовом чанке.
// Зал, очередь и менеджерские экраны — lazy: не тормозят холодный запуск
// на слабом CPU терминала и кэшируются после первого открытия.
// lazyWithRetry: после деплоя хеш чанка меняется, старая вкладка просит
// несуществующий файл → Vercel отдаёт index.html → import() падает белым
// экраном. Обёртка делает один reload за свежим index.html.
const HallPage = lazyWithRetry(() => import('./features/tables/HallPage'), 'HallPage')
const FloorPlanEditorPage = lazyWithRetry(() => import('./features/tables/FloorPlanEditorPage'), 'FloorPlanEditorPage')
const QueuePage = lazyWithRetry(() => import('./features/queue/QueuePage'), 'QueuePage')
const MenuPage = lazyWithRetry(() => import('./features/menu/MenuPage'), 'MenuPage')
const OnlineOrdersPage = lazyWithRetry(() => import('./features/online/OnlineOrdersPage'), 'OnlineOrdersPage')
// Публичная страница заказа для гостей (050) — без auth, ходит в Edge Functions
const PublicOrderPage = lazyWithRetry(() => import('./features/online/PublicOrderPage'), 'PublicOrderPage')
const ReservationsPage = lazyWithRetry(() => import('./features/reservations/ReservationsPage'), 'ReservationsPage')
// Публичная страница брони стола (053) — без auth, ходит в Edge Functions
const PublicReservePage = lazyWithRetry(() => import('./features/reservations/PublicReservePage'), 'PublicReservePage')
const ShiftPage = lazyWithRetry(() => import('./features/shift/ShiftPage'), 'ShiftPage')
const TimesheetPage = lazyWithRetry(() => import('./features/timesheet/TimesheetPage'), 'TimesheetPage')
const TransactionsPage = lazyWithRetry(() => import('./features/transactions/TransactionsPage'), 'TransactionsPage')
const SettingsPage = lazyWithRetry(() => import('./features/settings/SettingsPage'), 'SettingsPage')
const GoLivePage = lazyWithRetry(() => import('./features/golive/GoLivePage'), 'GoLivePage')
const ReportsPage = lazyWithRetry(() => import('./features/reports/ReportsPage'), 'ReportsPage')
const InventoryPage = lazyWithRetry(() => import('./features/inventory/InventoryPage'), 'InventoryPage')
const DashboardPage = lazyWithRetry(() => import('./features/dashboard/DashboardPage'), 'DashboardPage')

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
for (const key of ['menu_categories', 'menu_items', 'modifier_groups', 'current_location', 'current_shift', 'tables', 'table_zones']) {
  queryClient.setQueryDefaults([key], STATIC_5MIN)
}

// ── Офлайн (фаза 7): read-кэш + очередь мутаций ─────────────
// Данные для работы без сети: каталог, точка (НДС/реквизиты чека),
// последняя смена, столы. Остальные ключи (заказы, отчёты) не персистятся —
// они либо realtime, либо не нужны офлайн.
const PERSIST_KEYS = new Set(['menu_categories', 'menu_items', 'modifier_groups', 'current_location', 'current_shift', 'tables', 'table_zones'])
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'kassa-query-cache',
  // Реже пишем в localStorage — main thread терминала (Android 7.1) не блокируем
  throttleTime: 2000,
})

// Device sync стартует ПОСЛЕ scope: при смене аккаунта scope очищает старые
// настройки из storage, затем sync безопасно восстанавливает snapshot сервера.
void initScope().then(() => initDeviceSync())
initOrientation()  // применяет настройку ориентации (мост APK v3 / браузер)
initNet()          // детекция сети (события браузера + проба Supabase)
initDrain(queryClient)  // движок replay офлайн-очереди
initTelemetry()    // журнал ошибок + heartbeat парка (074)

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
  // Гостевые страницы (заказ, бронь) — без сплэша кассы: гостю нужен сразу контент
  const showSplash =
    !window.location.pathname.startsWith('/order/') &&
    !window.location.pathname.startsWith('/reserve/')
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 7 * 24 * 3600_000,
        buster: __APP_VERSION__, // новая версия приложения сбрасывает кэш
        dehydrateOptions: {
          // Пустой справочник в persist не кладём. Запрос под ещё не поднятой
          // сессией (org_id в JWT нет) получает от RLS законные [] + HTTP 200 —
          // для React Query это success, и пустышка залипала в localStorage на
          // gcTime (7 дней): зал и меню оставались пустыми до ручной чистки.
          // Офлайн пустой каталог бесполезен, терять тут нечего.
          shouldDehydrateQuery: (q) =>
            PERSIST_KEYS.has(String(q.queryKey[0])) &&
            q.state.status === 'success' &&
            !(Array.isArray(q.state.data) && q.state.data.length === 0),
        },
      }}
    >
      <BrowserRouter>
        <AutoLock />
        {/* ErrorBoundary ловит краш lazy-роута (устаревший чанк после деплоя,
            runtime-краш страницы) — иначе всё дерево срывается в белый экран */}
        <RouteErrorBoundary>
        {/* Быстрый кэш-хит не мигает (спиннер только после 400мс), но по
            медленной 4G терминала пустой экран не висит бесконечно */}
        <Suspense fallback={<SuspenseFallback />}>
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
            path="/reservations"
            element={
              <ProtectedRoute>
                <ReservationsPage />
              </ProtectedRoute>
            }
          />

          {/* Гость сайта: бронь стола (053). Публичный маршрут. */}
          <Route path="/reserve/:locId" element={<PublicReservePage />} />

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

          {/* Склад (055): без allowedRoles — журнал читается любым сотрудником,
              кнопки прихода/инвентаризации гейтятся правами точки внутри */}
          <Route
            path="/inventory"
            element={
              <ProtectedRoute>
                <InventoryPage />
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

          {/* Чек-лист запуска точки (P3-13) */}
          <Route
            path="/settings/go-live"
            element={
              <ProtectedRoute allowedRoles={['owner', 'manager']}>
                <GoLivePage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/settings/floor-plan"
            element={
              <ProtectedRoute allowedRoles={['owner', 'manager']}>
                <FloorPlanEditorPage />
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
        </RouteErrorBoundary>
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
