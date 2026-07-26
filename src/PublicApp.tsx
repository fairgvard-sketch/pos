import { Suspense } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import RouteErrorBoundary from './components/RouteErrorBoundary'
import SuspenseFallback from './components/ui/SuspenseFallback'
import { lazyWithRetry } from './lib/lazyWithRetry'

const PublicOrderPage = lazyWithRetry(
  () => import('./features/online/PublicOrderPage'),
  'PublicOrderPage',
)
const PublicReservePage = lazyWithRetry(
  () => import('./features/reservations/PublicReservePage'),
  'PublicReservePage',
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
})

function PublicLandingPage() {
  return (
    <main
      dir="rtl"
      className="min-h-screen bg-[#f8f5ee] px-6 flex items-center justify-center text-center"
    >
      <div className="w-full max-w-sm rounded-3xl bg-white px-8 py-10 shadow-[0_24px_70px_rgba(17,24,39,0.10)]">
        <div className="mx-auto h-12 w-12 rounded-2xl bg-gray-900 text-white flex items-center justify-center text-lg font-black">
          A
        </div>
        <h1 className="mt-6 text-2xl font-black text-gray-900">Angle Menu</h1>
        <p className="mt-3 text-base leading-7 text-gray-600">
          כדי לפתוח את התפריט, סרקו את קוד ה־QR של בית העסק.
        </p>
      </div>
    </main>
  )
}

export default function PublicApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <RouteErrorBoundary>
          <Suspense fallback={<SuspenseFallback />}>
            <Routes>
              <Route path="/" element={<PublicLandingPage />} />
              <Route path="/order/:locId" element={<PublicOrderPage />} />
              <Route path="/reserve/:locId" element={<PublicReservePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
