import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxOp } from './offline/types'

type RpcResult = { data: unknown; error: { message: string } | null }
const rpc = vi.fn<(...args: unknown[]) => Promise<RpcResult>>(
  async () => ({ data: 1, error: null }),
)
/** Заголовки каждого вызова: по ним видно, от чьего имени ушёл пакет. */
const rpcHeaders: Array<Record<string, string>> = []
/** Клиент без `setHeader` (старый SDK): привязать identity нечем. */
let bindable = true

/**
 * Запрос без `setHeader`, но такой же ленивый: postgrest-js выполняет вызов
 * только на `then`, поэтому неотправленный запрос не доходит до сервера.
 */
function plainRequest(...args: unknown[]) {
  return {
    then<T>(onOk: (r: RpcResult) => T, onErr?: (e: unknown) => T) {
      rpcHeaders.push({})
      return rpc(...args).then(onOk, onErr)
    },
  }
}

/**
 * Двойник PostgrestFilterBuilder: запрос создаётся синхронно, уходит на await,
 * заголовок ставится до отправки. Именно этот порядок даёт SDK окно, в котором
 * токен успевает смениться, — тесты ниже проверяют его как на настоящем SDK
 * (см. telemetry-review.test.ts).
 */
function rpcBuilder(...args: unknown[]) {
  const headers: Record<string, string> = {}
  const builder = {
    setHeader(name: string, value: string) {
      headers[name] = value
      return builder
    },
    then<T>(onOk: (r: RpcResult) => T, onErr?: (e: unknown) => T) {
      rpcHeaders.push(headers)
      return rpc(...args).then(onOk, onErr)
    },
  }
  return builder
}

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const ORG_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const ORG_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const LOC_A = 'cccccccc-1111-4111-8111-111111111111'
const LOC_A2 = 'cccccccc-3333-4333-8333-333333333333'

function sessionOf(token: string, user: string, org: string, location: string) {
  return { access_token: token, user: { id: user, app_metadata: { org_id: org, location_id: location } } }
}
const sessionA = () => sessionOf('token-A', USER_A, ORG_A, LOC_A)
const sessionB = () => sessionOf('token-B', USER_B, ORG_B, LOC_A)

let session: object | null = sessionA()

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session } }) },
    rpc: (...args: unknown[]) => (bindable ? rpcBuilder(...args) : plainRequest(...args)),
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
  confirmTelemetryContext,
  flushTelemetry,
  sendHeartbeat,
} from './telemetry'
import { CTX_KEY } from './telemetry-context'

const QUEUE_KEY = 'kassa-telemetry'

/** Поколение текущего входа: им помечены записи, которые кассе разрешено слать. */
function gen(): string {
  const raw = localStorage.getItem(CTX_KEY)
  return raw ? String((JSON.parse(raw) as { g?: string }).g ?? '') : ''
}

/** Дождаться, пока пакет действительно ушёл: двойник SDK ленивый, как настоящий. */
async function untilSent(): Promise<void> {
  for (let i = 0; i < 50 && rpc.mock.calls.length === 0; i++) await Promise.resolve()
}

/** Положить в localStorage очередь от имени текущего входа (как другая вкладка). */
function plant(entries: Array<Record<string, unknown>>, ctx: string = gen()): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(entries.map((e) => ({ ...e, ctx }))))
}

function queue(): Array<{ fingerprint: string; count: number; message: string }> {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]')
}

/** Сырое содержимое localStorage — проверяем, что секрет не лёг на диск. */
function storedRaw(): string {
  return localStorage.getItem(QUEUE_KEY) ?? ''
}

type SentError = Record<string, unknown>

/** Точные аргументы RPC: что реально уехало бы на сервер. */
function sentErrors(): SentError[] {
  const out: SentError[] = []
  for (const call of rpc.mock.calls) {
    if (call[0] !== 'report_client_errors') continue
    const args = call[1] as { p_errors?: unknown }
    if (Array.isArray(args?.p_errors)) out.push(...(args.p_errors as SentError[]))
  }
  return out
}

function sentRaw(): string {
  return JSON.stringify(sentErrors())
}

/**
 * Синтетические маркеры. Реальные токены, гости и телефоны здесь не
 * используются: каждая строка придумана и существует только в тестах.
 */
const FAKE = {
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXFhIn0.FAKEsignature0000',
  bearer: 'sbpfake0011223344556677889900aabbccddeeff',
  access: 'fakeaccess0011223344556677889900',
  refresh: 'fakerefresh9988776655443322110099',
  password: 'F4keP@ssw0rd-qa',
  pin: '9137',
  email: 'qa.fake.guest@example.test',
  phone: '+972500000001',
  phoneLocal: '050-000-0002',
  guest: 'QA Fake Guest',
  hebrewGuest: 'אורח בדיקה',
}

beforeEach(async () => {
  vi.useFakeTimers()
  rpc.mockClear()
  rpc.mockResolvedValue({ data: 1, error: null })
  rpcHeaders.length = 0
  bindable = true
  session = sessionA()
  online = true
  outboxOps = []
  localStorage.clear()
  window.history.pushState({}, '', '/sell')
  __resetTelemetryForTests()
  // Так же, как на старте кассы: initTelemetry подтверждает вход первым делом.
  // До подтверждения запись поколения не имеет и отправлена не будет (F6.1-R1).
  await confirmTelemetryContext()
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

// ---------------------------------------------------------------------------
// F6.1: безопасный payload. Все значения ниже выдуманы (см. FAKE).
// ---------------------------------------------------------------------------

describe('безопасный payload: секреты', () => {
  it('не сохраняет и не отправляет JWT и Bearer-заголовок', async () => {
    captureMessage('outbox', `order.place failed: 401 with Authorization: Bearer ${FAKE.jwt}`)
    await flushTelemetry()
    expect(storedRaw()).not.toContain('eyJ')
    expect(sentRaw()).not.toContain('eyJ')
    expect(sentRaw()).not.toContain(FAKE.jwt)
    // Диагностика остаётся: видно источник и что за операция упала
    expect(sentErrors()[0]).toMatchObject({ source: 'outbox' })
    expect(String(sentErrors()[0].message)).toContain('order.place failed')
  })

  it('не сохраняет access/refresh token и apikey', async () => {
    captureMessage('window', `refresh failed: access_token=${FAKE.access}&refresh_token=${FAKE.refresh}&apikey=${FAKE.bearer}`)
    await flushTelemetry()
    for (const secret of [FAKE.access, FAKE.refresh, FAKE.bearer]) {
      expect(storedRaw()).not.toContain(secret)
      expect(sentRaw()).not.toContain(secret)
    }
  })

  it('не сохраняет пароль и PIN', async () => {
    captureMessage('window', `login failed password=${FAKE.password} pin=${FAKE.pin}`)
    await flushTelemetry()
    expect(storedRaw()).not.toContain(FAKE.password)
    expect(sentRaw()).not.toContain(FAKE.password)
    expect(storedRaw()).not.toContain(FAKE.pin)
    expect(sentRaw()).not.toContain(FAKE.pin)
  })
})

describe('безопасный payload: стабильность записи', () => {
  it('сохранённое и отправленное совпадают (очистка идемпотентна)', async () => {
    captureMessage('outbox', `login failed password=${FAKE.password} pin=${FAKE.pin} token=${FAKE.access}`)
    const stored = JSON.parse(storedRaw())[0]
    await flushTelemetry()
    const sent = sentErrors()[0]
    expect(sent.message).toBe(stored.message)
    expect(sent.fingerprint).toBe(stored.fingerprint)
  })

  it('дедупликация переживает перечитывание очереди', async () => {
    const withPhone = (n: string) => `guest.save failed: sms to +97250000000${n} rejected`
    captureMessage('outbox', withPhone('1'))
    captureMessage('outbox', withPhone('2'))
    captureMessage('outbox', withPhone('3'))
    // одинаковый сбой с разным телефоном — одна запись с count 3
    expect(queue()).toHaveLength(1)
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(1)
    expect(sentErrors()[0].count).toBe(3)
  })
})

describe('безопасный payload: данные гостя', () => {
  it('не сохраняет email и телефон', async () => {
    captureMessage('outbox', `guest upsert failed: ${FAKE.email} / ${FAKE.phone} / ${FAKE.phoneLocal}`)
    await flushTelemetry()
    for (const pii of [FAKE.email, '972500000001', '050-000-0002']) {
      expect(storedRaw()).not.toContain(pii)
      expect(sentRaw()).not.toContain(pii)
    }
  })

  it('не отправляет сериализованный заказ/гостя из message', async () => {
    const payload = JSON.stringify({
      customer_name: FAKE.guest,
      phone: FAKE.phone,
      items: [{ name: 'Latte', price: 1500 }],
    })
    captureMessage('outbox', `order.place failed: invalid payload ${payload}`)
    await flushTelemetry()
    expect(storedRaw()).not.toContain(FAKE.guest)
    expect(sentRaw()).not.toContain(FAKE.guest)
    expect(sentRaw()).not.toContain('items')
    expect(String(sentErrors()[0].message)).toContain('order.place failed')
  })

  it('не отправляет значение из detail базы (Key (col)=(value))', async () => {
    captureMessage('outbox', `guest.save failed: duplicate key value violates unique constraint "guests_phone_key": Key (phone)=(${FAKE.phone}) already exists`)
    await flushTelemetry()
    expect(sentRaw()).not.toContain('972500000001')
    expect(String(sentErrors()[0].message)).toContain('duplicate key value')
  })

  it('не отправляет нелатинский текст гостя', async () => {
    captureMessage('outbox', `guest.save failed: name ${FAKE.hebrewGuest} rejected`)
    await flushTelemetry()
    expect(storedRaw()).not.toContain(FAKE.hebrewGuest)
    expect(sentRaw()).not.toContain(FAKE.hebrewGuest)
  })

  it('URL внутри ошибки теряет userinfo, query и fragment', async () => {
    captureMessage(
      'outbox',
      `fetch failed https://fakeuser:fakepw@db.example.test/rest/v1/orders?phone=eq.${FAKE.phone}&select=*#access_token=${FAKE.access}`,
    )
    await flushTelemetry()
    const msg = String(sentErrors()[0].message)
    expect(msg).toContain('db.example.test/rest/v1/orders')
    expect(msg).not.toContain('fakeuser')
    expect(msg).not.toContain('fakepw')
    expect(msg).not.toContain('phone=eq')
    expect(sentRaw()).not.toContain(FAKE.access)
    expect(sentRaw()).not.toContain('972500000001')
  })
})

describe('безопасный payload: stack и route', () => {
  it('кадры стека чистятся, место сбоя сохраняется', async () => {
    const err = new Error('render failed')
    err.stack = [
      `Error: render failed for ${FAKE.email}`,
      `    at payOrder (https://pos.example.test/assets/app-abc123.js?token=${FAKE.jwt}:120:15)`,
      `    at handleTap (https://fakeuser:fakepw@pos.example.test/assets/app-abc123.js#${FAKE.access}:44:3)`,
    ].join('\n')
    captureError('react', err)
    await flushTelemetry()
    const stack = String(sentErrors()[0].stack ?? '')
    expect(stack).toContain('payOrder')
    expect(stack).toContain('app-abc123.js')
    expect(stack).not.toContain('eyJ')
    expect(stack).not.toContain(FAKE.email)
    expect(stack).not.toContain('fakeuser')
    expect(stack).not.toContain(FAKE.access)
    expect(storedRaw()).not.toContain('eyJ')
  })

  it('route не уносит идентификаторы из пути', async () => {
    window.history.pushState({}, '', '/order/6ad1f0b8-1111-4222-8333-444455556666')
    captureMessage('window', 'boom')
    await flushTelemetry()
    expect(String(sentErrors()[0].route)).toBe('/order/:id')
  })

  it('route c почтой в пути не уходит на сервер', async () => {
    window.history.pushState({}, '', `/guests/${FAKE.email}`)
    captureMessage('window', 'boom')
    await flushTelemetry()
    expect(storedRaw()).not.toContain(FAKE.email)
    expect(sentRaw()).not.toContain(FAKE.email)
  })
})

describe('старая очередь предыдущей версии', () => {
  const legacy = [{
    fingerprint: 'legacyfp',
    source: 'window',
    message: `login failed password=${FAKE.password} for ${FAKE.email}`,
    stack: `Error: login failed\n    at auth (https://pos.example.test/app.js?token=${FAKE.jwt}:10:2)`,
    route: '/order/6ad1f0b8-1111-4222-8333-444455556666',
    app_version: '1.1.0',
    user_agent: 'Mozilla/5.0 (Linux; Android 7.1.2)',
    count: 3,
  }]

  it('очищается перед сохранением новой ошибки', () => {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(legacy))
    captureMessage('window', 'new one')
    expect(storedRaw()).not.toContain(FAKE.password)
    expect(storedRaw()).not.toContain(FAKE.email)
    expect(storedRaw()).not.toContain('eyJ')
    expect(storedRaw()).not.toContain('6ad1f0b8')
  })

  it('не досылается: владелец записи прошлой версии неизвестен', async () => {
    // F6.1-R1: старая запись не помечена поколением входа, приписать её
    // текущему аккаунту нельзя. Политика — удалить, а не досылать.
    localStorage.setItem(QUEUE_KEY, JSON.stringify(legacy))
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(0)
    expect(queue()).toHaveLength(0)
    for (const secret of [FAKE.password, FAKE.email, 'eyJ', '6ad1f0b8']) {
      expect(storedRaw()).not.toContain(secret)
      expect(sentRaw()).not.toContain(secret)
    }
  })

  it('очередь того же входа сохраняет count и source', async () => {
    // содержимое то же, но запись принадлежит подтверждённому входу
    plant(legacy)
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(1)
    expect(sentErrors()[0]).toMatchObject({ source: 'window', count: 3 })
    for (const secret of [FAKE.password, FAKE.email, 'eyJ', '6ad1f0b8']) {
      expect(sentRaw()).not.toContain(secret)
    }
  })
})

describe('очередь как недоверенный вход', () => {
  it('мусорные элементы не ломают batch', async () => {
    plant([
      null,
      5,
      'strings are not entries',
      [],
      { message: null },
      { source: 'window', message: 'good one', count: 1 },
    ] as unknown as Array<Record<string, unknown>>)
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(1)
    expect(String(sentErrors()[0].message)).toContain('good one')
  })

  it('count всегда конечное положительное число в пределах', async () => {
    plant([
      { source: 'window', message: 'a', count: 'not a number' },
      { source: 'window', message: 'b', count: -3 },
      { source: 'window', message: 'c', count: 0 },
      { source: 'window', message: 'd', count: 1e12 },
      { source: 'window', message: 'e', count: { nested: 1 } },
      { source: 'window', message: 'f', count: 2.7 },
    ])
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(6)
    for (const e of sentErrors()) {
      expect(Number.isInteger(e.count)).toBe(true)
      expect(e.count as number).toBeGreaterThanOrEqual(1)
      expect(e.count as number).toBeLessThanOrEqual(1000)
    }
  })

  it('неизвестный source приводится к допустимому', async () => {
    plant([
      { source: 'evil', message: 'a', count: 1 },
      { source: 42, message: 'b', count: 1 },
    ])
    await flushTelemetry()
    const allowed = ['window', 'promise', 'react', 'outbox', 'print', 'shift']
    expect(sentErrors().length).toBeGreaterThan(0)
    for (const e of sentErrors()) expect(allowed).toContain(e.source)
  })

  it('в RPC уходят только разрешённые поля', async () => {
    plant([
      {
        source: 'window',
        message: 'a',
        count: 1,
        service_role_key: 'fake-service-key-0011223344',
        extra: { guest: FAKE.guest },
      },
    ])
    await flushTelemetry()
    const allowedFields = [
      'app_version', 'count', 'fingerprint', 'message',
      'route', 'source', 'stack', 'user_agent',
    ]
    for (const key of Object.keys(sentErrors()[0])) expect(allowedFields).toContain(key)
    expect(sentRaw()).not.toContain('service_role_key')
    expect(sentRaw()).not.toContain(FAKE.guest)
  })

  it('повреждённый JSON не мешает новым ошибкам', async () => {
    localStorage.setItem(QUEUE_KEY, '{не json')
    captureMessage('window', 'after corruption')
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(1)
  })

  it('очередь ограничена по числу записей и размеру', () => {
    const big = 'x'.repeat(2_000)
    // записи заведомо разные: проверяем именно потолок, а не схлопывание
    const junk = Array.from({ length: 300 }, (_, i) => ({
      source: 'window',
      message: `entry-${i} ${big}`,
      stack: `    at frame${i} (https://pos.example.test/assets/${big}.js:1:1)`,
      user_agent: big,
      count: 1,
    }))
    plant(junk)
    captureMessage('window', 'trigger')
    expect(queue().length).toBeLessThanOrEqual(40)
    expect(storedRaw().length).toBeLessThanOrEqual(64 * 1024)
  })
})

describe('устойчивость отправки', () => {
  it('reject сети не теряет очередь и не бросает', async () => {
    rpc.mockRejectedValue(new Error('network down'))
    captureMessage('window', 'a')
    await expect(flushTelemetry()).resolves.toBeUndefined()
    expect(queue()).toHaveLength(1)
  })

  it('параллельные flush дают один RPC', async () => {
    captureMessage('window', 'a')
    await Promise.all([flushTelemetry(), flushTelemetry(), flushTelemetry()])
    const calls = rpc.mock.calls.filter((c) => c[0] === 'report_client_errors')
    expect(calls).toHaveLength(1)
  })

  it('успешный batch не удаляет ошибку, пойманную во время отправки', async () => {
    captureMessage('window', 'in batch')
    let release: (v: RpcResult) => void = () => {}
    rpc.mockImplementation(() => new Promise<RpcResult>((res) => { release = res }))
    const flight = flushTelemetry()
    await untilSent()
    captureMessage('print', 'during flight')
    release({ data: 1, error: null })
    await flight
    const rest = queue()
    expect(rest).toHaveLength(1)
    expect(rest[0].message).toContain('during flight')
  })

  it('недоступный localStorage не ломает flush', async () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('denied') }
    try {
      await expect(flushTelemetry()).resolves.toBeUndefined()
    } finally {
      Storage.prototype.getItem = orig
    }
  })

  it('финансовый outbox не трогается телеметрией', async () => {
    const outboxRaw = JSON.stringify({ state: { ops: [{ id: 'op-1' }] } })
    localStorage.setItem('kassa-outbox', outboxRaw)
    captureMessage('window', 'a')
    await flushTelemetry()
    rpc.mockRejectedValue(new Error('network down'))
    captureMessage('outbox', 'b')
    await flushTelemetry()
    expect(localStorage.getItem('kassa-outbox')).toBe(outboxRaw)
  })
})

describe('смена контекста устройства', () => {
  it('записи контекста A не уходят как события B', async () => {
    // A: контекст подтверждён при старте (beforeEach)
    captureMessage('window', 'first-A')
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(1)

    // A уходит в офлайн и накапливает диагностику
    online = false
    captureMessage('outbox', 'secret-A-2')
    await flushTelemetry()
    expect(queue()).toHaveLength(1)

    // на терминале вошёл другой аккаунт
    rpc.mockClear()
    session = sessionB()
    online = true
    await flushTelemetry()
    expect(sentRaw()).not.toContain('secret-A-2')
  })

  it('после смены контекста новые ошибки отправляются нормально', async () => {
    captureMessage('window', 'first-A')
    await flushTelemetry()

    session = sessionB()
    await flushTelemetry()
    rpc.mockClear()
    captureMessage('window', 'fresh-B')
    await flushTelemetry()
    expect(String(sentErrors()[0]?.message ?? '')).toContain('fresh-B')
  })

  it('та же учётка в другой точке не забирает очередь прошлой', async () => {
    // F6.1-R1: одного user мало — устройство переводят между точками и орг.
    online = false
    captureMessage('outbox', 'from-location-A')
    online = true
    session = sessionOf('token-A2', USER_A, ORG_A, LOC_A2)
    await flushTelemetry()
    expect(sentRaw()).not.toContain('from-location-A')
    expect(queue()).toHaveLength(0)
  })

  it('выход и повторный вход тем же аккаунтом закрывают поколение', async () => {
    captureMessage('window', 'before-logout')
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(1)

    captureMessage('outbox', 'after-send-before-logout')
    session = null
    await flushTelemetry()

    rpc.mockClear()
    session = sessionA()
    await flushTelemetry()
    expect(sentRaw()).not.toContain('after-send-before-logout')

    // диагностика после повторного входа продолжает работать
    captureMessage('window', 'after-relogin')
    await flushTelemetry()
    expect(sentRaw()).toContain('after-relogin')
  })

  it('запись без подтверждённого входа удаляется, а не досылается', async () => {
    __resetTelemetryForTests() // как первый запуск: входа ещё не было
    captureMessage('window', 'before-any-login')
    expect(queue()).toHaveLength(1)
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(0)
    expect(queue()).toHaveLength(0)
  })

  it('очередь чужого поколения не уходит и не остаётся на диске', async () => {
    plant([{ source: 'window', message: 'foreign tab entry', count: 1 }], 'ffffffffffffffff')
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(0)
    expect(storedRaw()).not.toContain('foreign tab entry')
  })
})

describe('привязка отправки к сессии', () => {
  it('batch уходит с токеном того входа, для которого собран', async () => {
    captureMessage('window', 'a')
    await flushTelemetry()
    expect(rpcHeaders[0].Authorization).toBe('Bearer token-A')
  })

  it('нечем привязать identity — пакет не отправляется', async () => {
    bindable = false
    captureMessage('window', 'a')
    await flushTelemetry()
    expect(rpc).not.toHaveBeenCalled()
    expect(queue()).toHaveLength(1)
  })

  it('поздний успех не трогает очередь нового входа', async () => {
    captureMessage('window', 'from-A')
    let release: (v: RpcResult) => void = () => {}
    rpc.mockImplementation(() => new Promise<RpcResult>((res) => { release = res }))
    const flight = flushTelemetry()
    await untilSent()

    // пока пакет летит, на устройстве сменился вход
    session = sessionB()
    await confirmTelemetryContext()
    captureMessage('print', 'from-B')
    const before = storedRaw()

    release({ data: 1, error: null })
    await flight
    expect(storedRaw()).toBe(before)
    expect(storedRaw()).toContain('from-B')
  })

  it('запись из другой вкладки того же входа переживает успешный batch', async () => {
    captureMessage('window', 'in batch')
    let release: (v: RpcResult) => void = () => {}
    rpc.mockImplementation(() => new Promise<RpcResult>((res) => { release = res }))
    const flight = flushTelemetry()
    await untilSent()

    // другая вкладка пишет в общий ключ localStorage напрямую
    const shared = JSON.parse(storedRaw()) as Array<Record<string, unknown>>
    shared.push({ source: 'print', message: 'from other tab', count: 1, ctx: gen() })
    localStorage.setItem(QUEUE_KEY, JSON.stringify(shared))

    release({ data: 1, error: null })
    await flight
    expect(queue()).toHaveLength(1)
    expect(queue()[0].message).toContain('from other tab')
  })
})

describe('границы секретных значений на диске и в RPC', () => {
  it('обрезанный PIN и экранированный password очищаются до сохранения и отправки', async () => {
    captureMessage('window', `pin="${FAKE.pin} ${'padding '.repeat(300)}"`)
    captureMessage('window', String.raw`password="a\"FakeQaPass9"`)
    const before = storedRaw()
    expect(before).toContain('[redacted]')
    expect(before).not.toContain(FAKE.pin)
    expect(before).not.toContain('FakeQaPass9')
    await flushTelemetry()
    expect(sentErrors().length).toBeGreaterThan(0)
    expect(sentRaw()).toContain('[redacted]')
    expect(sentRaw()).not.toContain(FAKE.pin)
    expect(sentRaw()).not.toContain('FakeQaPass9')
  })
})

describe('стабильность записи на диске', () => {
  it('перечитывание очереди не меняет уже сохранённую запись', async () => {
    captureMessage('outbox', `login failed password=${FAKE.password} for ${FAKE.email}`)
    const first = (JSON.parse(storedRaw()) as Array<Record<string, unknown>>)[0]
    captureMessage('print', 'unrelated')  // очередь перечитана и переписана
    await flushTelemetry()
    rpc.mockClear()
    captureMessage('print', 'unrelated again')
    const again = (JSON.parse(storedRaw()) as Array<Record<string, unknown>>)
      .find((e) => e.source === 'outbox')
    expect(again ?? first).toEqual(first)
  })

  it('повтор той же ошибки после отправки копится заново', async () => {
    captureMessage('window', 'same failure')
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(1)
    expect(sentErrors()[0].count).toBe(1)

    rpc.mockClear()
    captureMessage('window', 'same failure')
    captureMessage('window', 'same failure')
    expect(queue()).toHaveLength(1)
    await flushTelemetry()
    expect(sentErrors()).toHaveLength(1)
    expect(sentErrors()[0].count).toBe(2)
    expect(queue()).toHaveLength(0)
  })
})
