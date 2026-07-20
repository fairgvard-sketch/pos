import { supabase } from './supabase'
import { deviceUuid } from './deviceSync'
import { isOnline, useNetStore } from './offline/net'
import { useOutboxStore, pendingOpsCount, hasFailedOps } from './offline/outboxStore'
import { bridgeVersion } from './androidBridge'

/**
 * Телеметрия парка (074): журнал клиентских ошибок + heartbeat устройства.
 *
 * Свойства, ради которых модуль написан руками, а не взят SDK:
 *  * никогда не роняет кассу — каждый вход обёрнут try/catch, сбой отправки
 *    молча откладывается до следующего окна сети;
 *  * offline-first — ошибки копятся в localStorage (отдельно от финансового
 *    outbox: телеметрию МОЖНО потерять, операции — нельзя) и дедуплицируются
 *    по fingerprint, шторм повторов растит count, а не очередь;
 *  * укладывается в бюджет startup-бандла (см. check:bundle) и работает на
 *    старом WebView T2 без внешних зависимостей.
 *
 * Не логировать PII: в payload идут message/stack/route, никогда — содержимое
 * заказов, имена гостей, PIN или токены (см. AGENTS.md «Авторизация»).
 */

export type TelemetrySource = 'window' | 'promise' | 'react' | 'outbox' | 'print' | 'shift'

interface QueuedError {
  fingerprint: string
  source: TelemetrySource
  message: string
  stack?: string
  route: string
  app_version: string
  user_agent: string
  count: number
}

const QUEUE_KEY = 'kassa-telemetry'
const QUEUE_MAX = 40
const BATCH_MAX = 20
const FLUSH_DEBOUNCE_MS = 5_000
const HEARTBEAT_MS = 5 * 60_000
const FIRST_HEARTBEAT_MS = 15_000
/** Предохранитель от циклов: не больше стольких capture в минуту */
const RATE_MAX_PER_MIN = 20

let initialized = false
let flushing = false
let flushTimer: ReturnType<typeof setTimeout> | null = null
let rateWindowStart = 0
let rateCount = 0

/** djb2 — стабильный дешёвый хеш для fingerprint (Chrome 52-safe) */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function fingerprintOf(source: TelemetrySource, message: string, stack?: string): string {
  // Первый содержательный кадр стека отделяет одинаковые сообщения из разных мест
  const frame = (stack ?? '').split('\n').find((l) => l.includes('at ') || l.includes('@')) ?? ''
  return hash(`${source}|${message.slice(0, 200)}|${frame.trim().slice(0, 120)}`)
}

function loadQueue(): QueuedError[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function saveQueue(q: QueuedError[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(0, QUEUE_MAX)))
  } catch { /* localStorage переполнен/недоступен — телеметрию теряем молча */ }
}

function rateLimited(): boolean {
  const now = Date.now()
  if (now - rateWindowStart > 60_000) {
    rateWindowStart = now
    rateCount = 0
  }
  return ++rateCount > RATE_MAX_PER_MIN
}

/** Поставить ошибку в очередь. Публичная точка для boundary/outbox/печати. */
export function captureError(source: TelemetrySource, err: unknown): void {
  try {
    if (rateLimited()) return
    const message = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 500)
    if (!message) return
    const stack = err instanceof Error ? err.stack?.slice(0, 4000) : undefined
    const fingerprint = fingerprintOf(source, message, stack)

    const q = loadQueue()
    const existing = q.find((e) => e.fingerprint === fingerprint)
    if (existing) {
      existing.count += 1
    } else {
      q.push({
        fingerprint,
        source,
        message,
        stack,
        route: window.location.pathname.slice(0, 200),
        app_version: __APP_VERSION__,
        user_agent: navigator.userAgent.slice(0, 256),
        count: 1,
      })
    }
    saveQueue(q)
    scheduleFlush()
  } catch { /* телеметрия не должна ронять кассу */ }
}

export function captureMessage(source: TelemetrySource, message: string): void {
  captureError(source, new Error(message))
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushTelemetry()
  }, FLUSH_DEBOUNCE_MS)
}

/** Отправить накопленное. Сбой любого рода — очередь остаётся до следующего окна. */
export async function flushTelemetry(): Promise<void> {
  if (flushing || !isOnline()) return
  flushing = true
  try {
    const batch = loadQueue().slice(0, BATCH_MAX)
    if (batch.length === 0) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const { error } = await supabase.rpc('report_client_errors', {
      p_device_uuid: deviceUuid(),
      p_errors: batch,
    })
    if (error) return

    // Вычесть отправленные count: пойманное во время полёта не теряется
    const sent = new Map(batch.map((e) => [e.fingerprint, e.count]))
    const rest = loadQueue()
      .map((e) => ({ ...e, count: e.count - (sent.get(e.fingerprint) ?? 0) }))
      .filter((e) => e.count > 0)
    saveQueue(rest)
  } catch { /* сеть/авторизация — попробуем в следующий раз */ } finally {
    flushing = false
  }
}

/** Heartbeat: версия приложения/моста и здоровье offline-очереди. */
export async function sendHeartbeat(): Promise<void> {
  try {
    if (!isOnline()) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const outbox = useOutboxStore.getState()
    await supabase.rpc('device_heartbeat', {
      p_device_uuid: deviceUuid(),
      p_app_version: __APP_VERSION__,
      p_bridge_version: bridgeVersion(),
      p_outbox_pending: pendingOpsCount(outbox),
      p_outbox_oldest: outbox.ops[0]?.createdAt ?? null,
      p_outbox_failed: hasFailedOps(outbox),
    })
  } catch { /* heartbeat не критичен */ }
  void flushTelemetry()
}

/**
 * Установить глобальные обработчики и таймер heartbeat. Вызывается один раз
 * из App.tsx рядом с initNet/initDrain. ErrorBoundary остаются без импортов —
 * они сигналят событием kassa:client-error (см. AppErrorBoundary).
 */
export function initTelemetry(): void {
  if (initialized) return
  initialized = true

  window.addEventListener('error', (e) => {
    captureError('window', e.error ?? e.message)
  })
  window.addEventListener('unhandledrejection', (e) => {
    captureError('promise', e.reason)
  })
  window.addEventListener('kassa:client-error', (e) => {
    const d = (e as CustomEvent<{ source?: TelemetrySource; message?: string; stack?: string }>).detail
    if (!d?.message) return
    const err = new Error(d.message)
    err.stack = d.stack
    captureError(d.source ?? 'react', err)
  })

  // Восстановление сети (детектор net.ts надёжнее browser-события на T2)
  useNetStore.subscribe((state, prev) => {
    if (state.online && !prev.online) void flushTelemetry()
  })

  setTimeout(() => void sendHeartbeat(), FIRST_HEARTBEAT_MS)
  setInterval(() => void sendHeartbeat(), HEARTBEAT_MS)
}

/** Только для тестов: сброс модульного состояния */
export function __resetTelemetryForTests(): void {
  initialized = false
  flushing = false
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  rateWindowStart = 0
  rateCount = 0
  try { localStorage.removeItem(QUEUE_KEY) } catch { /* ignore */ }
}
