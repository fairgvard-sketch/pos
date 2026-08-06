import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { OutboxOp } from './types'

/**
 * Офлайн-журнал денежного ящика (144) в очереди:
 *   * ручное открытие (no_sale) ждёт PIN — сервер требует cash_movement;
 *   * сопутствующее открытие (продажа) уходит и без PIN (мягкий режим);
 *   * доменный отказ журнала НЕ стопорит FIFO с деньгами: запись
 *     выбрасывается, следующая операция обрабатывается.
 */

const logDrawerOpen = vi.fn(async () => {})
vi.mock('../../features/drawer/api', () => ({
  logDrawerOpen: (...a: unknown[]) => logDrawerOpen(...(a as [])),
}))

const voidTableOrder = vi.fn(async () => {})
vi.mock('../../features/tables/api', () => ({
  openTableOrder: vi.fn(),
  appendToOrder: vi.fn(),
  voidTableOrder: (...a: unknown[]) => voidTableOrder(...(a as [])),
  setOrderDiscount: vi.fn(),
  voidOrderItem: vi.fn(),
}))
vi.mock('../../features/sell/api', () => ({ placeOrder: vi.fn(), payOrder: vi.fn() }))
vi.mock('../../features/queue/api', () => ({
  markItemReady: vi.fn(),
  markOrderReady: vi.fn(),
  setOrderUrgent: vi.fn(),
}))

vi.mock('../supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { user: {} } } })) } },
}))

vi.mock('./net', () => ({
  isOnline: () => true,
  isNetworkishError: () => false,
  kickProbe: vi.fn(),
  markOffline: vi.fn(),
  useNetStore: { subscribe: vi.fn() },
}))

vi.mock('./scope', () => ({
  refreshScope: vi.fn(async () => 'orgA:loc1:userA'),
  currentScopeKey: () => 'orgA:loc1:userA',
  opInCurrentScope: (scope: string | null | undefined) => scope === 'orgA:loc1:userA',
}))

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

import { kickDrain, initDrain } from './drain'
import { useOutboxStore } from './outboxStore'
import { useAuthStore } from '../../store/authStore'
import type { StaffSession } from '../../types'

function drawerOp(id: string, reason: 'no_sale' | 'sale'): OutboxOp {
  return {
    id,
    kind: 'drawer.open',
    payload: { reason, staffId: 'staff-1', note: null, deviceUuid: 'dev-1' },
    orderId: null,
    orderKey: null,
    createdAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    lastError: null,
    scope: 'orgA:loc1:userA',
  }
}

function voidOp(): OutboxOp {
  return {
    id: 'op-void-1',
    kind: 'table.void',
    payload: { reason: null },
    orderId: 'order-1',
    orderKey: null,
    createdAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    lastError: null,
    scope: 'orgA:loc1:userA',
  }
}

const staff: StaffSession = {
  id: 'staff-1',
  name: 'Test',
  role: 'manager',
  location_id: null,
  session_token: 'tok-123',
}

beforeEach(() => {
  logDrawerOpen.mockClear()
  logDrawerOpen.mockImplementation(async () => {})
  voidTableOrder.mockClear()
  useOutboxStore.setState({ ops: [], idMap: {}, localOrders: {} })
  useAuthStore.setState({ staff: null })
  initDrain({ invalidateQueries: vi.fn() } as never)
})

describe('drawer.open в очереди', () => {
  it('открытие без продажи ждёт PIN, а не падает в failed', async () => {
    useOutboxStore.getState().enqueue(drawerOp('op-drawer-1', 'no_sale'))

    await kickDrain()

    expect(useOutboxStore.getState().ops[0].status).toBe('blocked_auth')
    expect(logDrawerOpen).not.toHaveBeenCalled()
  })

  it('открытие по продаже уходит и без PIN (мягкий режим сессии)', async () => {
    useOutboxStore.getState().enqueue(drawerOp('op-drawer-2', 'sale'))

    await kickDrain()

    expect(useOutboxStore.getState().ops).toHaveLength(0)
    expect(logDrawerOpen).toHaveBeenCalledTimes(1)
    // Время события — с момента открытия ящика, а не с момента replay
    const [args] = logDrawerOpen.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(args).toMatchObject({ opUuid: 'op-drawer-2', reason: 'sale', staffId: 'staff-1' })
  })

  it('после PIN ручное открытие доезжает', async () => {
    useOutboxStore.getState().enqueue(drawerOp('op-drawer-3', 'no_sale'))
    await kickDrain()

    useAuthStore.getState().setStaff(staff)
    await vi.waitFor(() => {
      expect(useOutboxStore.getState().ops).toHaveLength(0)
    })
    expect(logDrawerOpen).toHaveBeenCalledTimes(1)
  })

  it('доменный отказ журнала не стопорит очередь с деньгами', async () => {
    logDrawerOpen.mockRejectedValueOnce(new Error('forbidden: cash_movement'))
    useAuthStore.setState({ staff })
    useOutboxStore.getState().enqueue(drawerOp('op-drawer-4', 'no_sale'))
    useOutboxStore.getState().enqueue(voidOp())

    await kickDrain()

    // Запись ящика выброшена, следующая операция обработана
    expect(useOutboxStore.getState().ops).toHaveLength(0)
    expect(voidTableOrder).toHaveBeenCalledTimes(1)
  })
})
