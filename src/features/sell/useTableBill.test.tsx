import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { useTableBill } from './useTableBill'
import { useCartStore, type CartLine } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useDeviceStore } from '../../store/deviceStore'
import { useNetStore } from '../../lib/offline/net'
import type { PayingOrder } from './usePayFlow'

const api = vi.hoisted(() => ({
  appendToOrder: vi.fn(),
  fetchOrderLines: vi.fn(),
}))
vi.mock('../tables/api', () => ({
  appendToOrder: api.appendToOrder,
  fetchOrderLines: api.fetchOrderLines,
  voidTableOrder: vi.fn(),
  voidOrderItem: vi.fn(),
  setOrderDiscount: vi.fn(),
  fireOrderItems: vi.fn(),
  voidBillLine: vi.fn(),
  moveBillLines: vi.fn(),
}))
const print = vi.hoisted(() => ({ printKitchenTicket: vi.fn() }))
vi.mock('../receipt/printService', () => print)

function cartLine(key: string, over: Partial<CartLine> = {}): CartLine {
  return {
    key, itemId: 'm1', name: 'Affogato', variantId: null, variantName: null,
    basePrice: 600000, mods: [], qty: 1, notes: '', priceOverride: null, ...over,
  }
}

function setup(lines: CartLine[], existingTotal: number) {
  useCartStore.getState().clear()
  useCartStore.setState({
    lines,
    tableCtx: { tableId: 't1', orderId: 'o1', tableLabel: 'V4', existingTotal },
  })
  const startPayment = vi.fn<(o: PayingOrder) => void>()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
  const { result } = renderHook(() => useTableBill(startPayment), { wrapper })
  return { result, startPayment }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchOrderLines.mockResolvedValue([])
  useNetStore.setState({ online: true })
  useAuthStore.setState({ staff: { id: 's1', name: 'Dana', role: 'barista', location_id: 'loc' } })
  useDeviceStore.setState({ printKitchenTicket: true })
})

describe('useTableBill: «К оплате» со счёта стола', () => {
  it('отмена оплаты и повторное «К оплате» не дописывают позиции второй раз', async () => {
    api.appendToOrder.mockResolvedValue({ total: 1200000 })
    const { result, startPayment } = setup([cartLine('a')], 600000)

    await act(() => result.current.billToPay.mutateAsync())
    expect(api.appendToOrder).toHaveBeenCalledTimes(1)
    expect(startPayment).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1200000 }))
    // Позиция теперь в счёте: корзина пуста, «Уже в счёте» = серверный итог
    expect(useCartStore.getState().lines).toEqual([])
    expect(useCartStore.getState().tableCtx?.existingTotal).toBe(1200000)

    // Кассир закрыл оплату и снова нажал «К оплате»
    await act(() => result.current.billToPay.mutateAsync())
    expect(api.appendToOrder).toHaveBeenCalledTimes(1)
    expect(startPayment).toHaveBeenLastCalledWith(expect.objectContaining({ total: 1200000 }))
  })

  it('добавленное уходит на кухню сразу, придержанный курс — с оплатой', async () => {
    api.appendToOrder.mockResolvedValue({ total: 1800000 })
    const { result, startPayment } = setup(
      [cartLine('a', { course: 1 }), cartLine('b', { name: 'Steak', course: 2 })],
      0,
    )

    await act(() => result.current.billToPay.mutateAsync())
    expect(print.printKitchenTicket).toHaveBeenCalledTimes(1)
    const ticket = print.printKitchenTicket.mock.calls[0][0]
    expect(ticket.lines.map((l: { name: string }) => l.name)).toEqual(['Affogato'])
    const released = startPayment.mock.calls[0][0].releasedLines ?? []
    expect(released.map((l) => l.name)).toEqual(['Steak'])
  })
})
