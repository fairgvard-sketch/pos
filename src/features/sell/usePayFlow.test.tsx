import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { usePayFlow } from './usePayFlow'
import { useCartStore } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useDeviceStore } from '../../store/deviceStore'
import { useNetStore } from '../../lib/offline/net'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}))
const api = vi.hoisted(() => ({ payOrder: vi.fn(), placeOrder: vi.fn(), splitOrder: vi.fn() }))
vi.mock('./api', () => api)
vi.mock('../auth/api', () => ({ fetchCurrentLocation: vi.fn().mockResolvedValue({ vat_rate: 18 }) }))
vi.mock('../receipt/printService', () => ({
  autoPrintReceipt: vi.fn(), autoPrintLocalReceipt: vi.fn(), printKitchenTicket: vi.fn(),
}))
vi.mock('../drawer/service', () => ({ openDrawer: vi.fn() }))
vi.mock('../../lib/sound', () => ({ playPaymentChime: vi.fn() }))

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return renderHook(() => usePayFlow(), { wrapper })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.payOrder.mockResolvedValue({})
  useNetStore.setState({ online: true })
  useAuthStore.setState({ staff: { id: 's1', name: 'Dana', role: 'barista', location_id: 'loc' } })
  useDeviceStore.setState({ lockAfterSale: false, receiptPrompt: false, autoPrintReceipt: false, printKitchenTicket: false })
  useCartStore.getState().clear()
})

describe('usePayFlow: кассир видит, что оплата прошла', () => {
  it('счёт стола: «Оплачено» со сдачей, в зал — по «Готово»', async () => {
    useCartStore.setState({ tableCtx: { tableId: 't1', orderId: 'o1', tableLabel: 'V4', existingTotal: 3700 } })
    const { result } = setup()

    await act(() => result.current.pay.mutateAsync({
      orderId: 'o1',
      dailyNumber: 0,
      payments: [{ method: 'cash', amount: 3700, tendered: 5000, change_due: 1300 }],
    }))
    expect(result.current.placedNumber).not.toBeNull()
    expect(result.current.paidSummary).toEqual({ amount: 3700, change: 1300, tableLabel: 'V4' })
    expect(navigate).not.toHaveBeenCalled()

    act(() => result.current.dismissPlaced())
    expect(navigate).toHaveBeenCalledWith('/hall')
    expect(result.current.paidSummary).toBeNull()
  })

  it('продажа у стойки: номер заказа и сумма, без перехода в зал', async () => {
    const { result } = setup()

    await act(() => result.current.pay.mutateAsync({
      orderId: 'o2',
      dailyNumber: 42,
      payments: [{ method: 'card', amount: 2400 }],
    }))
    expect(result.current.placedNumber).toBe(42)
    expect(result.current.paidSummary).toEqual({ amount: 2400, change: 0, tableLabel: null })

    act(() => result.current.dismissPlaced())
    expect(navigate).not.toHaveBeenCalled()
  })
})
