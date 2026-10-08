import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CartLine } from '../../store/cartStore'

/**
 * Fire без сети (179): официант отправил придержанный курс, пока касса
 * была офлайн. Проверяем, что операция:
 *   * едет строго ЗА дозаказом тех же строк (FIFO) и ссылается на id,
 *     выданные кассой, — сервер узнаёт строки раньше, чем их отпускают;
 *   * таймаут/обрыв сети не роняет её в failed — повтор с теми же id;
 *   * переживает рестарт кассы вместе с оверлеем «уже отправлено»;
 *   * чужого scope не отправляется.
 */

const calls: string[] = []
const appendToOrder = vi.fn(async (..._a: unknown[]) => { calls.push('append'); return { total: 0 } })
const fireOrderItems = vi.fn(async (..._a: unknown[]) => { calls.push('fire'); return { fired: [] } })
vi.mock('../../features/tables/api', () => ({
  openTableOrder: vi.fn(),
  appendToOrder: (...a: unknown[]) => appendToOrder(...a),
  fireOrderItems: (...a: unknown[]) => fireOrderItems(...a),
  voidTableOrder: vi.fn(),
  setOrderDiscount: vi.fn(),
  voidOrderItem: vi.fn(),
}))
vi.mock('../../features/sell/api', () => ({ placeOrder: vi.fn(), payOrder: vi.fn() }))
vi.mock('../../features/queue/api', () => ({
  markItemReady: vi.fn(),
  markOrderReady: vi.fn(),
  setOrderUrgent: vi.fn(),
}))
vi.mock('../../features/drawer/api', () => ({ logDrawerOpen: vi.fn() }))

vi.mock('../supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { user: {} } } })) } },
}))

// Сеть управляется тестом: online и «сетевая» ли ошибка
const net = { online: true, networkish: false }
vi.mock('./net', () => ({
  isOnline: () => net.online,
  isNetworkishError: () => net.networkish,
  kickProbe: vi.fn(),
  markOffline: vi.fn(),
  useNetStore: { subscribe: vi.fn() },
}))

const scope = { current: 'orgA:loc1:userA' }
vi.mock('./scope', () => ({
  refreshScope: vi.fn(async () => scope.current),
  currentScopeKey: () => scope.current,
  requireCurrentScopeKey: () => scope.current,
  opInCurrentScope: (s: string | null | undefined) => s === scope.current,
}))

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

import { kickDrain, initDrain } from './drain'
import { useOutboxStore } from './outboxStore'
import { enqueueTableAppend, enqueueTableFire, firedPendingIds } from './enqueue'

const ORDER = 'order-1'

function line(lineId: string, course: number, held: boolean): CartLine {
  return {
    key: `k-${lineId}`,
    itemId: 'item-steak',
    name: 'Steak',
    variantId: null,
    variantName: null,
    basePrice: 9000,
    mods: [],
    qty: 1,
    notes: '',
    priceOverride: null,
    course,
    lineId,
    held,
  }
}

beforeEach(() => {
  calls.length = 0
  appendToOrder.mockClear()
  fireOrderItems.mockClear()
  net.online = false // ставим в очередь без сети, дренаж — по команде теста
  net.networkish = false
  scope.current = 'orgA:loc1:userA'
  localStorage.clear()
  useOutboxStore.setState({ ops: [], idMap: {}, localOrders: {} })
  initDrain({ invalidateQueries: vi.fn() } as never)
})

describe('table.fire в офлайн-очереди', () => {
  it('Fire офлайн-строки едет за её дозаказом и ссылается на id кассы', async () => {
    enqueueTableAppend({
      orderKey: ORDER, orderId: ORDER, staffId: 'staff-1',
      lines: [line('11111111-1111-4111-8111-111111111111', 2, true)],
      totalAfter: 9000,
    })
    enqueueTableFire({
      orderKey: ORDER, orderId: ORDER, staffId: 'staff-1',
      itemIds: ['11111111-1111-4111-8111-111111111111'],
    })

    // Эхо сразу отпускает строку — кухня на этой кассе видит её без сети
    expect(useOutboxStore.getState().localOrders[ORDER].lines[0].held).toBe(false)

    net.online = true
    await kickDrain()

    expect(calls).toEqual(['append', 'fire'])
    expect(fireOrderItems).toHaveBeenCalledWith(['11111111-1111-4111-8111-111111111111'], 'staff-1')
    expect(useOutboxStore.getState().ops).toHaveLength(0)
  })

  it('таймаут Fire — не доменная ошибка: операция ждёт повтора с теми же id', async () => {
    // Таймер ретрая не должен проснуться в соседнем тесте
    vi.useFakeTimers()
    enqueueTableFire({ orderKey: ORDER, orderId: ORDER, staffId: 'staff-1', itemIds: ['srv-1'] })
    net.online = true
    net.networkish = true
    fireOrderItems.mockRejectedValueOnce(new Error('drain timeout'))

    await kickDrain()

    const op = useOutboxStore.getState().ops[0]
    expect(op.status).toBe('pending')
    expect(op.attempts).toBe(1)
    // Пока операция в очереди, строка в счёте показана отправленной
    expect(firedPendingIds(useOutboxStore.getState().ops).has('srv-1')).toBe(true)

    net.networkish = false
    await kickDrain()
    expect(fireOrderItems).toHaveBeenCalledTimes(2)
    expect(fireOrderItems).toHaveBeenLastCalledWith(['srv-1'], 'staff-1')
    expect(useOutboxStore.getState().ops).toHaveLength(0)
    vi.useRealTimers()
  })

  it('рестарт кассы: Fire из прерванной отправки снова в pending, оверлей цел', async () => {
    enqueueTableFire({ orderKey: ORDER, orderId: ORDER, staffId: 'staff-1', itemIds: ['srv-2'] })
    const id = useOutboxStore.getState().ops[0].id
    useOutboxStore.getState().markInflight(id) // упали посреди вызова

    // Новый запуск: состояние читается из localStorage. Сброс памяти стора
    // перезаписал бы хранилище — возвращаем снимок «до краша»
    const persisted = localStorage.getItem('kassa-outbox')
    useOutboxStore.setState({ ops: [], idMap: {}, localOrders: {} })
    localStorage.setItem('kassa-outbox', persisted!)
    await useOutboxStore.persist.rehydrate()

    const op = useOutboxStore.getState().ops[0]
    expect(op.kind).toBe('table.fire')
    expect(op.status).toBe('pending')
    expect(firedPendingIds(useOutboxStore.getState().ops).has('srv-2')).toBe(true)
  })

  it('Fire чужого scope не отправляется — карантин', async () => {
    enqueueTableFire({ orderKey: ORDER, orderId: ORDER, staffId: 'staff-1', itemIds: ['srv-3'] })
    scope.current = 'orgB:loc9:userB' // на кассе вошёл другой аккаунт
    net.online = true

    await kickDrain()

    expect(fireOrderItems).not.toHaveBeenCalled()
    expect(useOutboxStore.getState().ops[0].status).toBe('quarantined')
  })
})
