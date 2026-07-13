import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { OutboxOp } from './types'

/**
 * P3: изоляция локального состояния по scope. Операция, поставленная под
 * другим аккаунтом устройства/организации, НЕ должна уйти под текущей
 * сессией — дренаж карантинит её по несовпадению scope.
 */

const voidTableOrder = vi.fn(async () => {})
vi.mock('../../features/tables/api', () => ({
  openTableOrder: vi.fn(),
  appendToOrder: vi.fn(),
  voidTableOrder: (...a: unknown[]) => voidTableOrder(...(a as [])),
  setOrderDiscount: vi.fn(),
  voidOrderItem: vi.fn(),
}))
vi.mock('../../features/sell/api', () => ({ placeOrder: vi.fn(), payOrder: vi.fn() }))
vi.mock('../../features/queue/api', () => ({ markItemReady: vi.fn(), markOrderReady: vi.fn() }))
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
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

// Управляем scope детерминированно
let mockScope: string | null = 'orgA:loc1:userA'
vi.mock('./scope', () => ({
  refreshScope: vi.fn(async () => mockScope),
  currentScopeKey: () => mockScope,
  opInCurrentScope: (opScope: string | null | undefined) =>
    opScope != null && mockScope != null && opScope === mockScope,
}))

import { kickDrain, initDrain } from './drain'
import { useOutboxStore } from './outboxStore'
import { useAuthStore } from '../../store/authStore'

function voidOp(scope: string | null): OutboxOp {
  return {
    id: `op-${scope}`,
    kind: 'table.void',
    payload: { reason: null },
    orderId: 'order-1',
    orderKey: null,
    scope,
    createdAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    lastError: null,
  }
}

beforeEach(() => {
  voidTableOrder.mockClear()
  mockScope = 'orgA:loc1:userA'
  useOutboxStore.setState({ ops: [], idMap: {}, localOrders: {} })
  // PIN есть (иначе table.void ушёл бы в blocked_auth раньше scope-проверки)
  useAuthStore.setState({
    staff: { id: 's1', name: 'T', role: 'manager', location_id: null, session_token: 'tok' },
  })
  initDrain({ invalidateQueries: vi.fn() } as never)
})

describe('scope-карантин дренажа', () => {
  it('операция чужого scope → quarantined, RPC не вызван, FIFO стоит', async () => {
    useOutboxStore.getState().enqueue(voidOp('orgB:loc9:userB'))
    await kickDrain()
    expect(useOutboxStore.getState().ops[0].status).toBe('quarantined')
    expect(voidTableOrder).not.toHaveBeenCalled()
  })

  it('операция своего scope отправляется', async () => {
    useOutboxStore.getState().enqueue(voidOp('orgA:loc1:userA'))
    await kickDrain()
    expect(voidTableOrder).toHaveBeenCalledTimes(1)
    expect(useOutboxStore.getState().ops).toHaveLength(0)
  })

  it('немаркированная (scope=null) legacy-операция карантинится', async () => {
    useOutboxStore.getState().enqueue(voidOp(null))
    await kickDrain()
    expect(useOutboxStore.getState().ops[0].status).toBe('quarantined')
    expect(voidTableOrder).not.toHaveBeenCalled()
  })

  it('quarantined считается требующим внимания, но не failed по типу', async () => {
    useOutboxStore.getState().enqueue(voidOp('orgB:loc9:userB'))
    await kickDrain()
    const { hasFailedOps } = await import('./outboxStore')
    // hasFailedOps включает quarantined (нужен ручной разбор)
    expect(hasFailedOps({ ops: useOutboxStore.getState().ops })).toBe(true)
  })
})
