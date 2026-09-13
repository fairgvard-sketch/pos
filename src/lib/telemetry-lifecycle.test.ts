/**
 * F6.1-R2: жизненный цикл входа у телеметрии.
 *
 * Здесь проверяется именно runtime-wiring: тест поднимает настоящий
 * `initTelemetry`, а дальше двигает только события Auth, сеть и время.
 * `confirmTelemetryContext` вручную вызывается ровно там, где проверяется
 * поздний ответ на чтение initial session, — «позеленить» им поведение
 * capture/flush нельзя.
 *
 * Auth целиком синтетический, fetch перехвачен: сети и настоящего сервера
 * в этом файле нет, все идентификаторы и токены придуманы.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Session = {
  access_token: string
  user: { id: string; app_metadata: { org_id: string; location_id: string } }
}
type AuthListener = (event: string, session: Session | null) => void

const state = vi.hoisted(() => ({
  session: null as Session | null,
  online: true,
  listeners: new Set<(event: string, session: unknown) => void>(),
  requests: [] as Array<{ authorization: string | null; body: string }>,
  /** Барьер внутри accessToken: даёт детерминированную точку «пакет в полёте». */
  beforeToken: null as null | (() => Promise<void>),
  /** Барьер внутри getSession: моделирует медленное чтение initial session. */
  beforeSession: null as null | (() => Promise<void>),
}))

vi.mock('./supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient('https://synthetic.example.test', 'synthetic-anon', {
    accessToken: async () => {
      await state.beforeToken?.()
      return state.session?.access_token ?? null
    },
    global: {
      fetch: async (_url, init) => {
        state.requests.push({
          authorization: new Headers(init?.headers).get('Authorization'),
          body: String(init?.body),
        })
        return new Response('1', { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    },
  })
  return {
    supabase: {
      auth: {
        async getSession() {
          // Снимок берём в момент вызова, отвечаем возможно позже: ровно так
          // устаревает позднее чтение initial session.
          const snapshot = state.session
          await state.beforeSession?.()
          return { data: { session: snapshot } }
        },
        onAuthStateChange(fn: (event: string, session: unknown) => void) {
          state.listeners.add(fn)
          fn('INITIAL_SESSION', state.session)
          return { data: { subscription: { unsubscribe() { state.listeners.delete(fn) } } } }
        },
      },
      rpc: client.rpc.bind(client),
    },
  }
})
vi.mock('./deviceSync', () => ({ deviceUuid: () => '00000000-0000-4000-8000-00000000dead' }))
vi.mock('./offline/net', () => ({ isOnline: () => state.online, useNetStore: { subscribe: () => () => {} } }))
vi.mock('./offline/outboxStore', () => ({
  useOutboxStore: { getState: () => ({ ops: [] }) },
  pendingOpsCount: () => 0,
  hasFailedOps: () => false,
}))
vi.mock('./androidBridge', () => ({ bridgeVersion: () => 3 }))

import {
  __resetTelemetryForTests,
  captureMessage,
  confirmTelemetryContext,
  flushTelemetry,
  initTelemetry,
} from './telemetry'
import { identityOf, newContext, writeContext } from './telemetry-context'

const QUEUE_KEY = 'kassa-telemetry'

const session = (name: 'A' | 'B'): Session => ({
  access_token: `synthetic-token-${name}`,
  user: {
    id: name === 'A' ? '10000000-0000-4000-8000-000000000001' : '10000000-0000-4000-8000-000000000002',
    app_metadata: { org_id: `synthetic-org-${name}`, location_id: `synthetic-location-${name}` },
  },
})

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { resolve, promise }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Событие Auth так, как его отдаёт SDK: сначала новое состояние, потом callback. */
async function emit(event: string, value: Session | null): Promise<void> {
  state.session = value
  for (const listener of state.listeners) (listener as AuthListener)(event, value)
  await settle()
}

const disk = (): string => localStorage.getItem(QUEUE_KEY) ?? ''
const wire = (): string => JSON.stringify(state.requests)

beforeEach(async () => {
  vi.useFakeTimers()
  localStorage.clear()
  state.requests = []
  state.listeners.clear()
  state.beforeToken = null
  state.beforeSession = null
  state.session = session('A')
  state.online = true
  __resetTelemetryForTests()
  initTelemetry()
  await settle()
})

afterEach(() => {
  __resetTelemetryForTests()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('поздние ответы Auth и отправки', () => {
  it('позднее чтение initial session не перезаписывает более новый вход', async () => {
    // Чтение сессии зависло и вернёт уже неактуальный снимок A.
    const slow = barrier()
    state.beforeSession = () => slow.promise
    const late = confirmTelemetryContext()
    await settle()

    // Пока оно висело, терминал перешёл на другой аккаунт.
    state.beforeSession = null
    await emit('SIGNED_OUT', null)
    await emit('SIGNED_IN', session('B'))

    slow.resolve()
    await late
    await settle()

    captureMessage('window', 'QA_after_switch')
    await flushTelemetry()

    const asB = state.requests.filter(
      (r) => r.authorization === 'Bearer synthetic-token-B' && r.body.includes('QA_after_switch'),
    )
    expect(asB).toHaveLength(1)
    expect(wire()).not.toContain('Bearer synthetic-token-A')
  })

  it('поздний успех после выхода и повторного входа не съедает новую очередь', async () => {
    captureMessage('window', 'QA_before_relogin')

    const entered = barrier(), released = barrier()
    state.beforeToken = async () => { entered.resolve(); await released.promise }
    const flight = flushTelemetry()
    await entered.promise
    state.beforeToken = null

    // Пакет ещё в полёте, а на терминале успели выйти и войти снова.
    await emit('SIGNED_OUT', null)
    await emit('SIGNED_IN', session('A'))
    captureMessage('window', 'QA_after_relogin')
    const before = disk()

    released.resolve()
    await flight
    await settle()

    // Успех прошлого поколения не трогает очередь нового входа.
    expect(disk()).toBe(before)
    expect(before).toContain('QA_after_relogin')
    // Свой собственный пакет A ушёл под своим токеном — диагностика работает.
    expect(state.requests[0]?.authorization).toBe('Bearer synthetic-token-A')
    expect(state.requests[0]?.body).toContain('QA_before_relogin')

    // И запись нового поколения по-прежнему отправляется.
    await flushTelemetry()
    expect(wire()).toContain('QA_after_relogin')
  })
})

describe('поколение при повторных событиях того же входа', () => {
  it('обновление токена и повторный SIGNED_IN не теряют очередь', async () => {
    state.online = false
    captureMessage('window', 'QA_survives_refresh')

    const refreshed = session('A')
    refreshed.access_token = 'synthetic-token-A2'
    await emit('TOKEN_REFRESHED', refreshed)
    await emit('SIGNED_IN', refreshed)

    state.online = true
    await flushTelemetry()

    const sent = state.requests.filter(
      (r) => r.authorization === 'Bearer synthetic-token-A2' && r.body.includes('QA_survives_refresh'),
    )
    expect(sent).toHaveLength(1)
  })

  it('выход закрывает поколение без сети и без flush', async () => {
    // Маркеры держим короче 24 символов: длинную сплошную последовательность
    // санитайзер сам свернёт в [token], и отрицательная проверка станет пустой.
    state.online = false
    captureMessage('window', 'QA_pre_logout_event')
    expect(disk()).toContain('QA_pre_logout_event')

    await emit('SIGNED_OUT', null)
    // Записи закрытого входа отправить уже некому — их нет и на диске.
    expect(disk()).not.toContain('QA_pre_logout_event')

    await emit('SIGNED_IN', session('A'))
    state.online = true
    captureMessage('window', 'QA_post_login_event')
    await flushTelemetry()

    expect(wire()).not.toContain('QA_pre_logout_event')
    // Контроль: канал жив, дело именно в закрытом поколении.
    expect(wire()).toContain('QA_post_login_event')
  })
})

describe('общий ключ localStorage и соседняя вкладка', () => {
  it('запись под устаревшим локальным контекстом отбрасывается, а не достаётся соседу', async () => {
    // Соседняя вкладка законно подтвердила вход B в общем ключе.
    writeContext(newContext(identityOf(session('B'))!))
    captureMessage('window', 'QA_stale_local')

    // Сюда событие Auth приходит только теперь.
    await emit('SIGNED_IN', session('B'))
    await flushTelemetry()

    expect(wire()).not.toContain('QA_stale_local')
    expect(disk()).not.toContain('QA_stale_local')
  })

  it('после сверки с соседом диагностика текущего входа продолжает уходить', async () => {
    writeContext(newContext(identityOf(session('B'))!))
    await emit('SIGNED_IN', session('B'))

    captureMessage('window', 'QA_useful_after_sync')
    await flushTelemetry()

    const sent = state.requests.filter(
      (r) => r.authorization === 'Bearer synthetic-token-B' && r.body.includes('QA_useful_after_sync'),
    )
    expect(sent).toHaveLength(1)
  })
})

describe('teardown слушателей', () => {
  it('сброс снимает подписку Auth и обработчики окна, повторный init не двоит записи', async () => {
    expect(state.listeners.size).toBe(1)

    __resetTelemetryForTests()
    expect(state.listeners.size).toBe(0)

    window.dispatchEvent(new CustomEvent('kassa:client-error', {
      detail: { source: 'react', message: 'QA_after_teardown' },
    }))
    expect(disk()).not.toContain('QA_after_teardown')

    initTelemetry()
    await settle()
    window.dispatchEvent(new CustomEvent('kassa:client-error', {
      detail: { source: 'react', message: 'QA_single_capture' },
    }))

    const queue = JSON.parse(disk() || '[]') as Array<{ count: number; message: string }>
    expect(queue).toHaveLength(1)
    expect(queue[0].count).toBe(1)
  })
})
