// Independent F6.1 regressions. Synthetic data only; the real Supabase SDK
// builds HTTP requests, but its fetch is intercepted and never reaches network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetrySource } from './telemetry-sanitize'
const state = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string; app_metadata: { org_id: string; location_id: string } } },
  online: true,
  beforeToken: null as null | (() => Promise<void>),
  requests: [] as Array<{ authorization: string | null; payload: { p_errors?: Array<{ message: string }> } }>,
}))
vi.mock('./supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient('https://synthetic.example.test', 'synthetic-anon', {
    accessToken: async () => { await state.beforeToken?.(); return state.session?.access_token ?? null },
    global: { fetch: async (_url, init) => {
      state.requests.push({ authorization: new Headers(init?.headers).get('Authorization'),
        payload: JSON.parse(String(init?.body)) })
      return new Response('1', { status: 200, headers: { 'Content-Type': 'application/json' } })
    } },
  })
  return { supabase: {
    auth: { getSession: async () => ({ data: { session: state.session } }) },
    rpc: client.rpc.bind(client),
  } }
})
vi.mock('./deviceSync', () => ({ deviceUuid: () => '00000000-0000-4000-8000-00000000dead' }))
vi.mock('./offline/net', () => ({ isOnline: () => state.online, useNetStore: { subscribe: vi.fn() } }))
vi.mock('./offline/outboxStore', () => ({ useOutboxStore: { getState: () => ({ ops: [] }) }, pendingOpsCount: () => 0, hasFailedOps: () => false }))
vi.mock('./androidBridge', () => ({ bridgeVersion: () => 3 }))
import { captureError, captureMessage, flushTelemetry, __resetTelemetryForTests } from './telemetry'
import { sanitizeMessage } from './telemetry-sanitize'
const a = () => ({ access_token: 'synthetic-token-A', user: {
  id: '10000000-0000-4000-8000-000000000001',
  app_metadata: { org_id: '20000000-0000-4000-8000-000000000001', location_id: '30000000-0000-4000-8000-000000000001' },
} })
const b = () => ({ access_token: 'synthetic-token-B', user: {
  id: '10000000-0000-4000-8000-000000000002',
  app_metadata: { org_id: '20000000-0000-4000-8000-000000000002', location_id: '30000000-0000-4000-8000-000000000002' },
} })
const raw = () => localStorage.getItem('kassa-telemetry') ?? ''
const sent = () => JSON.stringify(state.requests.map(r => r.payload))
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { resolve, promise }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.restoreAllMocks()
  state.session = a(); state.online = true; state.beforeToken = null; state.requests = []
  localStorage.clear(); __resetTelemetryForTests()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('known secret formats cannot hide in message prefixes', () => {
  it.each([
    ['password: FakeQaPass9', 'FakeQaPass9'],
    ['Error: password: FakeQaPass9', 'FakeQaPass9'],
    ['Error: pin: 9137', '9137'],
    ["Error: failed password='FakeQaPass9'", 'FakeQaPass9'],
    ['Error: failed password=[FakeQaPass9]', 'FakeQaPass9'],
  ])('%s is redacted in the sanitizer', (input, secret) => {
    expect(sanitizeMessage(input)).not.toContain(secret)
  })
  it('PIN at message start is absent from both disk and exact HTTP payload', async () => {
    captureMessage('window', 'pin: 9137')
    const disk = raw()
    await flushTelemetry()
    expect({ diskContainsPin: disk.includes('9137'), wireContainsPin: sent().includes('9137') })
      .toEqual({ diskContainsPin: false, wireContainsPin: false })
  })
})

describe('every persisted field is validated at capture', () => {
  it('untrusted source cannot persist an arbitrary guest object', () => {
    captureError({ guest: 'SyntheticSourceGuest' } as unknown as TelemetrySource, new Error('safe failure'))
    expect(raw()).not.toContain('SyntheticSourceGuest')
  })
  it('known secrets in user_agent are absent from disk and exact HTTP payload', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/120.0 password=FakeQaPass9')
    captureMessage('window', 'safe failure')
    const disk = raw()
    await flushTelemetry()
    expect({ diskContainsSecret: disk.includes('FakeQaPass9'), wireContainsSecret: sent().includes('FakeQaPass9') })
      .toEqual({ diskContainsSecret: false, wireContainsSecret: false })
  })
})

describe('queue identity at offline capture and SDK dispatch', () => {
  it('first offline queue from A is never adopted as B before first flush', async () => {
    state.online = false
    captureMessage('window', 'QA_event_from_A')
    await flushTelemetry()
    state.session = b(); state.online = true
    await flushTelemetry()
    expect(sent()).not.toContain('QA_event_from_A')
  })
  it('same Auth user in a changed org/location must not carry the old queue', async () => {
    await flushTelemetry() // establish A, then accumulate offline
    state.online = false
    captureMessage('window', 'QA_event_old_org')
    const next = b(); next.user.id = a().user.id
    state.session = next; state.online = true
    await flushTelemetry()
    expect(sent()).not.toContain('QA_event_old_org')
  })
  it('real SDK must not send A batch with B Authorization after asynchronous token lookup', async () => {
    await flushTelemetry()
    captureMessage('window', 'QA_event_from_A')
    const entered = barrier(), released = barrier()
    state.beforeToken = async () => { entered.resolve(); await released.promise }
    const flight = flushTelemetry()
    await entered.promise
    state.session = b()
    released.resolve()
    await flight
    const wrong = state.requests.filter(r => r.authorization === 'Bearer synthetic-token-B'
      && JSON.stringify(r.payload).includes('QA_event_from_A'))
    expect(wrong).toHaveLength(0)
  })
  it('confirmed current context keeps useful telemetry working', async () => {
    await flushTelemetry()
    captureMessage('window', 'safe_current_error')
    await flushTelemetry()
    expect(sent()).toContain('safe_current_error')
    expect(state.requests[0].authorization).toBe('Bearer synthetic-token-A')
  })
})
