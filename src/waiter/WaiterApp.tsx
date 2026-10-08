import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { useLangStore } from '../store/langStore'
import { classify } from './api'
import { useWaiterDrafts, useWaiterSession } from './store'
import PairScreen from './PairScreen'
import PinScreen from './PinScreen'
import TablesScreen from './TablesScreen'
import TableScreen from './TableScreen'

/**
 * Телефон официанта (180) — отдельная поверхность внутри POS-сборки:
 * main.tsx грузит её вместо App на путях /waiter. Без device sync,
 * офлайн-очереди, телеметрии и печати кассы — только заказ к столу.
 */

/** Отключённый телефон или истёкшая PIN-сессия — один ответ на любом экране */
function onAuthError(e: unknown) {
  const kind = classify(e)
  if (kind === 'session') useWaiterSession.getState().setSession(null)
  if (kind === 'revoked') {
    useWaiterSession.getState().setSession(null)
    useWaiterSession.getState().setRevoked(true)
    useWaiterDrafts.getState().clearAll()
    void supabase.auth.signOut({ scope: 'local' })
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: {
    queries: {
      // Повторяем только сетевые сбои: отказ сервера повтором не лечится
      retry: (n, e) => classify(e) === 'network' && n < 2,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false, networkMode: 'always' },
  },
})

type DeviceState = 'loading' | 'none' | 'terminal' | 'phone'

function deviceStateOf(session: Session | null): DeviceState {
  if (!session) return 'none'
  const md = session.user.app_metadata ?? {}
  if (md.kind === 'waiter') return 'phone'
  // Сессия кассы: допуск телефона заменил бы её и выключил кассу
  if (md.org_id) return 'terminal'
  return 'none'
}

function Gate() {
  const lang = useLangStore((s) => s.lang)
  const staffSession = useWaiterSession((s) => s.session)
  const [device, setDevice] = useState<DeviceState>('loading')

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setDevice(deviceStateOf(data.session)))
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setDevice(deviceStateOf(session)))
    return () => data.subscription.unsubscribe()
  }, [])

  if (device === 'loading') return null

  return (
    <div dir={lang === 'he' ? 'rtl' : 'ltr'} className="min-h-[100dvh] bg-[#f8f9fb] text-gray-900">
      <Routes>
        <Route path="/waiter/pair" element={<PairScreen terminal={device === 'terminal'} paired={device === 'phone'} />} />
        {device !== 'phone' ? (
          <Route path="*" element={<PairScreen terminal={device === 'terminal'} paired={false} />} />
        ) : !staffSession ? (
          <Route path="*" element={<PinScreen />} />
        ) : (
          <>
            <Route path="/waiter" element={<TablesScreen />} />
            <Route path="/waiter/table/:tableId" element={<TableScreen />} />
            <Route path="*" element={<Navigate to="/waiter" replace />} />
          </>
        )}
      </Routes>
    </div>
  )
}

export default function WaiterApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Toaster position="top-center" toastOptions={{ duration: 3000 }} />
        <Gate />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
