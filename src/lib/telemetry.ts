import { supabase } from './supabase'
import { deviceUuid } from './deviceSync'
import { isOnline, useNetStore } from './offline/net'
import { useOutboxStore, pendingOpsCount, hasFailedOps } from './offline/outboxStore'
import { bridgeVersion } from './androidBridge'
import {
  fingerprintOf,
  sanitizeCount,
  sanitizeEntry,
  sanitizeMessage,
  sanitizeRoute,
  sanitizeSource,
  sanitizeStack,
  sanitizeUserAgent,
  sanitizeVersion,
  toWireError,
  type QueuedError,
  type TelemetrySource,
} from './telemetry-sanitize'
import {
  accessTokenOf,
  clearContext,
  identityOf,
  matchesContext,
  newContext,
  readContext,
  writeContext,
  UNVERIFIED_CTX,
  type TelemetryContext,
} from './telemetry-context'

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
 * Безопасность payload (F6.1): сообщение, стек, маршрут, источник и UA
 * очищаются в telemetry-sanitize ДО записи в localStorage, до fingerprint и
 * до отправки. Очередь при каждом чтении проходит ту же очистку — записи
 * прошлых версий и любой посторонний JSON в ключе `kassa-telemetry`
 * доверенными не считаются.
 *
 * Принадлежность (F6.1-R1): очередь помечена поколением входа
 * (telemetry-context, тройка user+org+location). Записи чужого или
 * неподтверждённого поколения удаляются, а не досылаются от имени текущего
 * аккаунта, а сам batch уезжает с токеном той сессии, для которой он собран.
 *
 * Жизненный цикл входа (F6.1-R2): поколение ведёт одна подписка на события
 * Auth, поднятая в initTelemetry. Выход закрывает поколение сразу и в offline
 * (flush для этого не нужен), повторный SIGNED_IN/обновление токена той же
 * тройки поколение сохраняет, а новая запись метится подтверждённым
 * контекстом ЭТОГО экземпляра модуля, а не тем, что лежит в общем ключе
 * localStorage: соседняя вкладка могла уже подтвердить другой вход.
 * Что именно гарантируется и что сознательно теряется — docs/deployment.md,
 * раздел «Наблюдаемость парка».
 */

export type { TelemetrySource }

const QUEUE_KEY = 'kassa-telemetry'
const QUEUE_MAX = 40
/** Потолок на весь ключ: диагностика не занимает место финансовой очереди. */
const QUEUE_BYTES_MAX = 64 * 1024
/** Сколько элементов чужого/старого JSON вообще разбираем за чтение */
const PARSE_MAX = 160
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

/**
 * Вход, подтверждённый ЭТИМ экземпляром модуля (этой вкладкой). Общий ключ
 * localStorage читают и пишут все вкладки, поэтому «что сейчас на диске» —
 * не ответ на вопрос «под кем работаю я».
 */
let localCtx: TelemetryContext | null = null
/**
 * Счётчик живых сигналов Auth. Асинхронные читатели (confirmTelemetryContext,
 * flushTelemetry) снимают его до await и не применяют устаревший снимок
 * сессии, если за время ожидания пришло более новое событие входа/выхода.
 */
let authSeq = 0
/** Отписки слушателей и таймеров: без них повторный init течёт (в т.ч. в тестах). */
const teardown: Array<() => void> = []

/**
 * Прочитать очередь как недоверенный вход: любой элемент проходит allowlist
 * полей и очистку, повреждённое отбрасывается, дубликаты схлопываются.
 */
function loadQueue(): QueuedError[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(QUEUE_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: QueuedError[] = []
  const seen = new Map<string, QueuedError>()
  for (const item of parsed.slice(0, PARSE_MAX)) {
    const entry = sanitizeEntry(item)
    if (!entry) continue
    const key = `${entry.ctx}|${entry.fingerprint}`
    const prev = seen.get(key)
    if (prev) {
      prev.count = sanitizeCount(prev.count + entry.count)
      continue
    }
    seen.set(key, entry)
    out.push(entry)
    if (out.length >= QUEUE_MAX) break
  }
  return out
}

function saveQueue(q: QueuedError[]): void {
  try {
    let list = q.slice(0, QUEUE_MAX)
    let raw = JSON.stringify(list)
    while (raw.length > QUEUE_BYTES_MAX && list.length > 0) {
      list = list.slice(0, list.length - 1)
      raw = JSON.stringify(list)
    }
    localStorage.setItem(QUEUE_KEY, raw)
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
    // source приходит из runtime вызывающего кода: приводим до fingerprint и
    // до записи, иначе на диск ляжет произвольное значение (F6.1-R1)
    const safeSource = sanitizeSource(source)
    const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    const message = sanitizeMessage(raw)
    if (!message) return
    const stack = err instanceof Error ? sanitizeStack(err.stack) : undefined
    const fingerprint = fingerprintOf(safeSource, message, stack)
    const ctx = captureGen()

    const q = loadQueue()
    const existing = q.find((e) => e.fingerprint === fingerprint && e.ctx === ctx)
    if (existing) {
      existing.count = sanitizeCount(existing.count + 1)
    } else {
      q.push({
        fingerprint,
        source: safeSource,
        message,
        stack,
        route: sanitizeRoute(window.location.pathname),
        app_version: sanitizeVersion(__APP_VERSION__),
        user_agent: sanitizeUserAgent(navigator.userAgent),
        count: 1,
        ctx,
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

/**
 * Поколение, которым МОЖНО пометить новую запись прямо сейчас.
 *
 * Берём подтверждённый контекст этого экземпляра и убеждаемся, что общий
 * ключ всё ещё принадлежит ему. Соседняя вкладка могла законно подтвердить
 * другой вход, пока сюда событие Auth ещё не дошло: тогда своей метки у
 * записи нет — она останется неподтверждённой (UNVERIFIED_CTX) и будет
 * удалена при ближайшей сверке. Приписать её соседу нельзя (F6.1-R2).
 */
function captureGen(): string {
  if (!localCtx) return UNVERIFIED_CTX
  const shared = readContext()
  return shared && shared.gen === localCtx.gen ? localCtx.gen : UNVERIFIED_CTX
}

/**
 * Закрыть поколение текущего входа.
 *
 * `purge` разделяет два разных состояния «сессии нет»:
 *  * событие Auth без сессии — вход действительно завершён, SDK это знает.
 *    Записи закрытого и неподтверждённого поколения отправить уже некому,
 *    поэтому убираем их с диска сразу, не дожидаясь следующего входа;
 *  * пустое чтение внутри flush — состояние переходное (обновление токена,
 *    занятый auth lock, ранний старт). Поколение закрываем, но очередь
 *    оставляем ждать: она помечена и чужому входу не достанется.
 */
function retireGeneration(purge: boolean): void {
  const shared = readContext()
  const retired = shared?.gen ?? localCtx?.gen ?? null
  localCtx = null
  if (shared) clearContext()
  if (!purge) return
  const all = loadQueue()
  const rest = all.filter((e) => e.ctx !== retired && e.ctx !== UNVERIFIED_CTX)
  if (rest.length !== all.length) saveQueue(rest)
}

/**
 * Сверить владельца очереди с переданным входом и вернуть его поколение.
 *
 * Совпадение считается по тройке user+org+location: одного user мало, на
 * терминале тот же аккаунт может быть переведён в другую организацию или
 * точку. Ничего не «усыновляем»: записи другого поколения и записи,
 * пойманные до подтверждения контекста, удаляются. Потерять диагностику
 * здесь безопаснее, чем приписать её чужой организации.
 *
 * Тот же вход, пришедший повторно (SIGNED_IN дубликатом, обновление токена),
 * поколение сохраняет — очередь при этом не теряется (F6.1-R2).
 */
function reconcileCtx(session: unknown): string | null {
  const id = identityOf(session)
  if (!id) {
    retireGeneration(false)
    return null
  }
  const shared = readContext()
  let ctx: TelemetryContext
  if (localCtx && shared && shared.gen === localCtx.gen && matchesContext(localCtx, id)) {
    ctx = localCtx // тот же вход: повтор события или обновление токена
  } else if (shared && matchesContext(shared, id)) {
    ctx = shared // этот же вход уже подтвердила соседняя вкладка
  } else {
    ctx = newContext(id) // новый вход: новое поколение
    writeContext(ctx)
  }
  localCtx = ctx
  // Чужое и неподтверждённое не копится на диске до следующей ротации
  const all = loadQueue()
  const owned = all.filter((e) => e.ctx === ctx.gen)
  if (owned.length !== all.length) saveQueue(owned)
  return ctx.gen
}

/**
 * Одно управляемое наблюдение за Auth на весь модуль.
 *
 * Callback синхронный и работает **переданной** сессией: повторный запрос
 * Auth внутри callback может встать на том же lock, а сеть здесь не нужна
 * вовсе — выход обязан закрывать поколение и в offline (F6.1-R2).
 * Возвращает false, если подписки нет (старый клиент/подмена): тогда вход
 * подтверждается разовым чтением.
 */
function subscribeAuth(): boolean {
  try {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      try {
        authSeq++
        if (identityOf(session)) reconcileCtx(session)
        else retireGeneration(true)
      } catch { /* телеметрия не должна ронять кассу */ }
    })
    const sub = data?.subscription
    if (!sub) return false
    teardown.push(() => sub.unsubscribe())
    return true
  } catch {
    return false
  }
}

/**
 * Привязать отправку к сессии, для которой собран batch.
 *
 * Между `getSession` и сетевым вызовом SDK успевает заново спросить токен: без
 * явного заголовка пакет аккаунта A уходил с `Authorization` аккаунта B
 * (F6.1-R1). `fetchWithAuth` уважает уже выставленный заголовок, поэтому
 * ставим его сами. Если у клиента нет `setHeader` (старый SDK или подмена в
 * тестах), привязать нечем — тогда не отправляем вовсе.
 */
interface AuthBindable { setHeader?: (name: string, value: string) => unknown }

function bindToSession(request: unknown, token: string): boolean {
  const bindable = request as AuthBindable
  if (typeof bindable.setHeader !== 'function') return false
  bindable.setHeader('Authorization', `Bearer ${token}`)
  return true
}

/**
 * Подтвердить контекст без сети: пометить, чьи записи копятся дальше, и
 * удалить чужие. Вызывается на старте (initTelemetry) — до этого момента
 * пойманные ошибки поколения не имеют и отправлены не будут.
 */
export async function confirmTelemetryContext(): Promise<void> {
  try {
    const seq = authSeq
    const { data: { session } } = await supabase.auth.getSession()
    // Пока читали initial session, мог прийти вход или выход: живое событие
    // новее этого снимка и перезаписывать его нельзя (F6.1-R2).
    if (seq !== authSeq) return
    reconcileCtx(session)
  } catch { /* контекст не подтверждён — новые записи останутся неизвестными */ }
}

/** Отправить накопленное. Сбой любого рода — очередь остаётся до следующего окна. */
export async function flushTelemetry(): Promise<void> {
  if (flushing || !isOnline()) return
  flushing = true
  try {
    const seq = authSeq
    const { data: { session } } = await supabase.auth.getSession()
    // Снимок устарел: вход/выход произошёл, пока читали сессию. Ждём окна.
    if (seq !== authSeq) return
    const gen = reconcileCtx(session)
    const token = accessTokenOf(session)
    if (!gen || !token) return

    const batch = loadQueue().filter((e) => e.ctx === gen).slice(0, BATCH_MAX)
    if (batch.length === 0) return

    const request = supabase.rpc('report_client_errors', {
      p_device_uuid: deviceUuid(),
      p_errors: batch.map(toWireError),
    })
    if (!bindToSession(request, token)) return
    const { error } = await request
    if (error) return

    // Поздний ответ не трогает очередь нового входа: пока пакет летел,
    // мог случиться выход и повторный вход, и та очередь принадлежит уже
    // другому поколению — даже если это тот же аккаунт.
    if (captureGen() !== gen) return

    // Вычесть отправленные count: пойманное во время полёта не теряется
    const sent = new Map(batch.map((e) => [e.fingerprint, e.count]))
    const rest = loadQueue()
      .map((e) => (e.ctx === gen ? { ...e, count: e.count - (sent.get(e.fingerprint) ?? 0) } : e))
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

function on(type: string, handler: (e: Event) => void): void {
  window.addEventListener(type, handler)
  teardown.push(() => window.removeEventListener(type, handler))
}

/**
 * Установить глобальные обработчики и таймер heartbeat. Вызывается один раз
 * из App.tsx рядом с initNet/initDrain. ErrorBoundary остаются без импортов —
 * они сигналят событием kassa:client-error (см. AppErrorBoundary).
 */
export function initTelemetry(): void {
  if (initialized) return
  initialized = true

  // Владелец очереди ведётся событиями Auth: вход/выход приходят сюда сами,
  // в том числе без сети. Если подписки нет — разовое чтение сессии.
  if (!subscribeAuth()) void confirmTelemetryContext()

  on('error', (e) => {
    const ev = e as ErrorEvent
    captureError('window', ev.error ?? ev.message)
  })
  on('unhandledrejection', (e) => {
    captureError('promise', (e as PromiseRejectionEvent).reason)
  })
  on('kassa:client-error', (e) => {
    const d = (e as CustomEvent<{ source?: TelemetrySource; message?: string; stack?: string }>).detail
    if (!d?.message) return
    const err = new Error(d.message)
    err.stack = d.stack
    captureError(d.source ?? 'react', err)
  })

  // Восстановление сети (детектор net.ts надёжнее browser-события на T2)
  const unsubNet = useNetStore.subscribe((state, prev) => {
    if (state.online && !prev.online) void flushTelemetry()
  })
  if (typeof unsubNet === 'function') teardown.push(unsubNet)

  const firstBeat = setTimeout(() => void sendHeartbeat(), FIRST_HEARTBEAT_MS)
  const beat = setInterval(() => void sendHeartbeat(), HEARTBEAT_MS)
  teardown.push(() => {
    clearTimeout(firstBeat)
    clearInterval(beat)
  })
}

/** Только для тестов: сброс модульного состояния */
export function __resetTelemetryForTests(): void {
  // Слушатели Auth/window, подписка на сеть и heartbeat снимаются полностью:
  // иначе повторный init копит дубликаты обработчиков (F6.1-R2).
  for (const undo of teardown.splice(0)) {
    try { undo() } catch { /* ignore */ }
  }
  initialized = false
  flushing = false
  localCtx = null
  authSeq = 0
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  rateWindowStart = 0
  rateCount = 0
  try { localStorage.removeItem(QUEUE_KEY) } catch { /* ignore */ }
  clearContext()
}
