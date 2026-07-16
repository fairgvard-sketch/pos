import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxOp } from './offline/types'

type RpcResult = { data: unknown; error: { message: string } | null }
const rpc = vi.fn<(...args: unknown[]) => Promise<RpcResult>>(
  async () => ({ data: 1, error: null }),
)
let session: object | null = { access_token: 't' }

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session } }) },
    rpc: (...args: unknown[]) => rpc(...args),
  },
}))

vi.mock('./deviceSync', () => ({
  deviceUuid: () => '00000000-0000-4000-8000-00000000dead',
}))

let online = true
vi.mock('./offline/net', () => ({
  isOnline: () => online,
  useNetStore: { subscribe: vi.fn() },
}))

let outboxOps: OutboxOp[] = []
vi.mock('./offline/outboxStore', () => ({
  useOutboxStore: { getState: () => ({ ops: outboxOps }) },
  pendingOpsCount: (s: { ops: OutboxOp[] }) =>
    s.ops.filter((o) => o.status === 'pending').length,
  hasFailedOps: (s: { ops: OutboxOp[] }) =>
    s.ops.some((o) => o.status === 'failed'),
}))

import {
  __resetTelemetryForTests,
  captureError,
  captureMessage,
  flushTelemetry,
  sendHeartbeat,
} from './telemetry'

const QUEUE_KEY = 'kassa-telemetry'

function queue(): Array<{ fingerprint: string; count: number; message: string }> {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]')
}

beforeEach(() => {
  vi.useFakeTimers()
  rpc.mockClear()
  rpc.mockResolvedValue({ data: 1, error: null })
  session = { access_token: 't' }
  online = true
  outboxOps = []
  __resetTelemetryForTests()
})

describe('captureError', () => {
  it('складывает ошибку в localStorage-очередь', () => {
    captureError('window', new Error('boom'))
    const q = queue()
    expect(q).toHaveLength(1)
    expect(q[0].message).toBe('Error: boom')
    expect(q[0].count).toBe(1)
  })

  it('дедуплицирует повторы по fingerprint через count', () => {
    const err = new Error('same')
    err.stack = 'Error: same\n  at doWork (sell.ts:1:1)'
    captureError('window', err)
    const again = new Error('same')
    again.stack = err.stack
    captureError('window', again)
    const q = queue()
    expect(q).toHaveLength(1)
    expect(q[0].count).toBe(2)
  })

  it('разные источники дают разные fingerprint', () => {
    captureMessage('print', 'fail')
    captureMessage('outbox', 'fail')
    expect(queue()).toHaveLength(2)
  })

  it('срезает шторм: не больше 20 capture в минуту', () => {
    for (let i = 0; i < 50; i++) captureMessage('window', `err-${i}`)
    expect(queue().length).toBeLessThanOrEqual(20)
  })

  it('никогда не бросает, даже без localStorage', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('quota') }
    try {
      expect(() => captureError('window', new Error('x'))).not.toThrow()
    } finally {
      Storage.prototype.setItem = orig
    }
  })
})

describe('flushTelemetry', () => {
  it('отправляет пакет и очищает очередь', async () => {
    captureMessage('window', 'a')
    captureMessage('react', 'b')
    await flushTelemetry()
    expect(rpc).toHaveBeenCalledWith('report_client_errors', expect.objectContaining({
      p_device_uuid: '00000000-0000-4000-8000-00000000dead',
      p_errors: expect.arrayContaining([
        expect.objectContaining({ message: 'Error: a', source: 'window' }),
      ]),
    }))
    expect(queue()).toHaveLength(0)
  })

  it('офлайн — не отправляет и не теряет очередь', async () => {
    online = false
    captureMessage('window', 'a')
    await flushTelemetry()
    expect(rpc).not.toHaveBeenCalled()
    expect(queue()).toHaveLength(1)
  })

  it('нет сессии устройства — очередь ждёт', async () => {
    session = null
    captureMessage('window', 'a')
    await flushTelemetry()
    expect(rpc).not.toHaveBeenCalled()
    expect(queue()).toHaveLength(1)
  })

  it('ошибка RPC — очередь остаётся до следующего окна', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'nope' } })
    captureMessage('window', 'a')
    await flushTelemetry()
    expect(queue()).toHaveLength(1)
  })
})

describe('sendHeartbeat', () => {
  it('шлёт версию и здоровье offline-очереди', async () => {
    outboxOps = [
      { status: 'pending', createdAt: '2026-07-16T08:00:00.000Z' },
      { status: 'failed', createdAt: '2026-07-16T08:01:00.000Z' },
    ] as OutboxOp[]
    await sendHeartbeat()
    expect(rpc).toHaveBeenCalledWith('device_heartbeat', {
      p_device_uuid: '00000000-0000-4000-8000-00000000dead',
      p_app_version: __APP_VERSION__,
      p_bridge_version: null,
      p_outbox_pending: 1,
      p_outbox_oldest: '2026-07-16T08:00:00.000Z',
      p_outbox_failed: true,
    })
  })

  it('пустая очередь — oldest null, failed false', async () => {
    await sendHeartbeat()
    expect(rpc).toHaveBeenCalledWith('device_heartbeat', expect.objectContaining({
      p_outbox_pending: 0,
      p_outbox_oldest: null,
      p_outbox_failed: false,
    }))
  })

  it('сбой RPC не бросает наружу', async () => {
    rpc.mockRejectedValue(new Error('network'))
    await expect(sendHeartbeat()).resolves.toBeUndefined()
  })
})
