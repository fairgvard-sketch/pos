import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { supabase } from './lib/supabase'
import DeviceSetupPage from './features/auth/DeviceSetupPage'
import PinLoginPage from './features/auth/PinLoginPage'
import ProtectedRoute from './features/auth/ProtectedRoute'
import HomePage from './features/home/HomePage'
import MenuPage from './features/menu/MenuPage'
import SellPage from './features/sell/SellPage'
import ShiftPage from './features/shift/ShiftPage'
import QueuePage from './features/queue/QueuePage'
import SettingsPage from './features/settings/SettingsPage'
import HallPage from './features/tables/HallPage'

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
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/setup" element={<DeviceSetupPage />} />
          <Route path="/pin" element={<PinLoginPage />} />

          <Route
            path="/home"
            element={
              <ProtectedRoute>
                <HomePage />
              </ProtectedRoute>
            }
          />

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
            path="/menu"
            element={
              <ProtectedRoute allowedRoles={['owner', 'manager']}>
                <MenuPage />
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
