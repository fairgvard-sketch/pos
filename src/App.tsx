import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { supabase } from './lib/supabase'
import DeviceSetupPage from './features/auth/DeviceSetupPage'
import PinLoginPage from './features/auth/PinLoginPage'
import ProtectedRoute from './features/auth/ProtectedRoute'
import SellPage from './features/sell/SellPage'
import QueuePage from './features/queue/QueuePage'
import HallPage from './features/tables/HallPage'
import AutoLock from './components/AutoLock'

// Горячий путь кассира (PIN → продажа/зал/очередь) — статика, в стартовом чанке.
// Менеджерские экраны — lazy: не тормозят парсинг на слабом CPU терминала,
// подгружаются при первом заходе (и кэшируются SW наравне с основным бандлом).
const MenuPage = lazy(() => import('./features/menu/MenuPage'))
const ShiftPage = lazy(() => import('./features/shift/ShiftPage'))
const TimesheetPage = lazy(() => import('./features/timesheet/TimesheetPage'))
const TransactionsPage = lazy(() => import('./features/transactions/TransactionsPage'))
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'))
const ReportsPage = lazy(() => import('./features/reports/ReportsPage'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // Данные из кэша остаются валидными и офлайн — не мигают при обрыве
      refetchOnReconnect: true,
    },
    mutations: {
      // При коротком обрыве сети мутация ставится на паузу (networkMode 'online' по
      // умолчанию) и автоматически выполнится, когда сеть вернётся — вместо мгновенной
      // ошибки. Уровень A офлайна; полная офлайн-очередь — фаза 7.
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
  },
})

// Каталог и точка меняются редко — 5 минут без фоновых рефетчей при каждом
// переходе зал↔продажа↔очередь (меньше сети и батареи терминала). Правки
// меню/настроек инвалидируют эти ключи явно, так что свежесть не страдает.
const STATIC_5MIN = { staleTime: 5 * 60_000 }
for (const key of ['menu_categories', 'menu_items', 'modifier_groups', 'current_location']) {
  queryClient.setQueryDefaults([key], STATIC_5MIN)
}

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
  return (
    <QueryClientProvider client={queryClient}>
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

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>

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
    </QueryClientProvider>
  )
}
