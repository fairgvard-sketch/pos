import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { OutboxOp } from './types'

/**
 * P4: офлайн-дренаж без PIN.
 * Сценарий: браузер закрыт → sessionStorage очищен (staff=null) → outbox
 * сохранён в localStorage → приложение открыто → в очереди привилегированная
 * операция (table.void) → дренаж НЕ роняет её в failed, а ставит blocked_auth
 * и стопит FIFO → после ввода PIN очередь продолжается и операция уходит.
 */

// ── Моки внешних зависимостей runOp/kickDrain ──────────────
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

// Устройство «залогинено» (сессия Supabase есть); PIN — отдельно, через authStore
vi.mock('../supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { user: {} } } })) } },
}))

// Сеть — всегда онлайн; probe/markOffline не нужны
vi.mock('./net', () => ({
  isOnline: () => true,
  isNetworkishError: () => false,
  kickProbe: vi.fn(),
  markOffline: vi.fn(),
  useNetStore: { subscribe: vi.fn() },
}))

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

import { kickDrain, initDrain } from './drain'
import { useOutboxStore } from './outboxStore'
import { useAuthStore } from '../../store/authStore'
import type { StaffSession } from '../../types'

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
  voidTableOrder.mockClear()
  useOutboxStore.setState({ ops: [], idMap: {}, localOrders: {} })
  useAuthStore.setState({ staff: null })
  // Подключаем подписку authStore → unblockAuth (идемпотентно)
  initDrain({ invalidateQueries: vi.fn() } as never)
})

describe('drain без PIN (blocked_auth)', () => {
  it('table.void без staff-сессии → blocked_auth, RPC не вызван, FIFO стоит', async () => {
    useOutboxStore.getState().enqueue(voidOp())

    await kickDrain()

    const op = useOutboxStore.getState().ops[0]
    expect(op.status).toBe('blocked_auth')
    expect(voidTableOrder).not.toHaveBeenCalled()
  })

  it('после ввода PIN операция реплеится и уходит из очереди', async () => {
    useOutboxStore.getState().enqueue(voidOp())
    await kickDrain()
    expect(useOutboxStore.getState().ops[0].status).toBe('blocked_auth')

    // PIN введён: authStore-подписка снимает блок (unblockAuth) и будит дренаж.
    // Подписка вызывает kickDrain асинхронно — дождёмся его завершения.
    useAuthStore.getState().setStaff(staff)
    await vi.waitFor(() => {
      expect(useOutboxStore.getState().ops).toHaveLength(0)
    })
    expect(voidTableOrder).toHaveBeenCalledTimes(1)
  })

  it('blocked_auth не считается failed (нет красного бейджа)', async () => {
    useOutboxStore.getState().enqueue(voidOp())
    await kickDrain()
    const { hasFailedOps, hasBlockedAuthOps, pendingOpsCount } = await import('./outboxStore')
    const s = { ops: useOutboxStore.getState().ops }
    expect(hasFailedOps(s)).toBe(false)
    expect(hasBlockedAuthOps(s)).toBe(true)
    expect(pendingOpsCount(s)).toBe(1) // всё ещё «в очереди»
  })
})
