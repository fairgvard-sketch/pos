import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import PinLogin from './features/auth/PinLogin'
import ProtectedRoute from './features/auth/ProtectedRoute'
import TablesPage from './features/tables/TablesPage'
import OrderPage from './features/orders/OrderPage'
import KitchenPage from './features/kitchen/KitchenPage'
import PaymentPage from './features/payments/PaymentPage'
import ManagerPage from './features/analytics/ManagerPage'
import HubPage from './features/hub/HubPage'
import ReportsPage from './features/reports/ReportsPage'
import LoyaltyPage from './features/loyalty/LoyaltyPage'
import SettingsPage from './features/settings/SettingsPage'
import RefundPage from './features/payments/RefundPage'
import RetailPage from './features/orders/RetailPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<PinLogin />} />

          <Route
            path="/tables"
            element={
              <ProtectedRoute allowedRoles={['waiter', 'manager']}>
                <TablesPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/order/:tableId"
            element={
              <ProtectedRoute allowedRoles={['waiter', 'manager']}>
                <OrderPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/payment/:orderId"
            element={
              <ProtectedRoute allowedRoles={['waiter', 'manager']}>
                <PaymentPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/kitchen"
            element={
              <ProtectedRoute allowedRoles={['kitchen', 'manager']}>
                <KitchenPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/manager"
            element={
              <ProtectedRoute allowedRoles={['manager']}>
                <ManagerPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/hub"
            element={
              <ProtectedRoute allowedRoles={['manager']}>
                <HubPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/reports"
            element={
              <ProtectedRoute allowedRoles={['manager']}>
                <ReportsPage />
              </ProtectedRoute>
            }
          />

<Route
            path="/loyalty"
            element={
              <ProtectedRoute allowedRoles={['manager']}>
                <LoyaltyPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/settings"
            element={
              <ProtectedRoute allowedRoles={['manager']}>
                <SettingsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/refund"
            element={
              <ProtectedRoute allowedRoles={['manager']}>
                <RefundPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/retail"
            element={
              <ProtectedRoute allowedRoles={['waiter', 'manager']}>
                <RetailPage />
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
