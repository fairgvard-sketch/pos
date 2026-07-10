import { create } from 'zustand'
import { onlineManager } from '@tanstack/react-query'

/**
 * Детекция сети для офлайн-режима. Источники истины:
 *   * события window online/offline (мгновенно, но врут про «Wi-Fi без интернета»)
 *   * активная проба GoTrue /auth/v1/health (лёгкий GET без авторизации)
 *   * таймаут боевой мутации (withOfflineFallback) — зависшая сеть = офлайн
 * Пока офлайн — проба каждые 20с; успех переводит в онлайн и будит drain.
 *
 * Без AbortController (нет в Chrome 52 на T2) — таймауты через Promise.race:
 * «проигравший» запрос продолжает жить в фоне, это безопасно — все операции
 * очереди идемпотентны (042), долетевший дубль вернёт сохранённый результат.
 */

const PROBE_TIMEOUT_MS = 5000
const PROBE_INTERVAL_MS = 20000
/** Таймаут боевого вызова в потоке продажи: дольше 4с кассир не ждёт */
export const SALE_TIMEOUT_MS = 4000

interface NetState {
  online: boolean
}

export const useNetStore = create<NetState>(() => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
}))

export function isOnline(): boolean {
  return useNetStore.getState().online
}

/** Бросается, когда операция ушла в офлайн-очередь вместо сети */
export class OfflineError extends Error {
  constructor() {
    super('offline')
    this.name = 'OfflineError'
  }
}

/** Сетевая ошибка (fetch упал/завис/5xx) — retry, НЕ доменная ошибка Postgres */
export function isNetworkishError(e: unknown): boolean {
  if (e instanceof OfflineError) return true
  if (e instanceof TypeError) return true // Failed to fetch и родня
  const msg = e instanceof Error ? e.message : String(e)
  return /failed to fetch|networkerror|network request failed|load failed|timed? ?out|fetch failed|502|503|504/i.test(msg)
}

let probeTimer: ReturnType<typeof setTimeout> | null = null
let probing = false

function setOnline(v: boolean) {
  if (useNetStore.getState().online !== v) {
    useNetStore.setState({ online: v })
    // Синхронизируем React Query: пауза/возобновление его собственных мутаций
    onlineManager.setOnline(v)
  }
  if (!v) scheduleProbe()
}

/** Разовая проба доступности Supabase. true = сеть есть. */
async function probe(): Promise<boolean> {
  try {
    await Promise.race([
      fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/health`, { method: 'GET', cache: 'no-store' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), PROBE_TIMEOUT_MS)),
    ])
    return true // любой HTTP-ответ = сеть жива
  } catch {
    return false
  }
}

function scheduleProbe() {
  if (probeTimer !== null) return
  probeTimer = setTimeout(() => {
    probeTimer = null
    void kickProbe()
  }, PROBE_INTERVAL_MS)
}

/** Проверить сеть сейчас (на online-событии, из drain, по таймеру офлайна) */
export async function kickProbe(): Promise<void> {
  if (probing) return
  probing = true
  try {
    const ok = await probe()
    setOnline(ok)
  } finally {
    probing = false
  }
}

/** Пометить сеть упавшей (зовёт withOfflineFallback/drain при таймауте) */
export function markOffline(): void {
  setOnline(false)
}

/**
 * Боевой примитив потока продажи: гонка вызова с таймаутом.
 *   * уже офлайн → OfflineError сразу, без похода в сеть;
 *   * таймаут/сетевая ошибка → флип в офлайн + OfflineError (вызывающий
 *     ставит операцию в очередь; если вызов всё же долетел — replay
 *     дедупится ключами 042);
 *   * доменная ошибка сервера пробрасывается как есть.
 */
export async function withOfflineFallback<T>(fn: () => Promise<T>, timeoutMs = SALE_TIMEOUT_MS): Promise<T> {
  if (!isOnline()) throw new OfflineError()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new OfflineError()), timeoutMs)
      }),
    ])
  } catch (e) {
    if (isNetworkishError(e)) {
      markOffline()
      void kickProbe()
      throw new OfflineError()
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

let inited = false

/** Подключить слушатели браузера + стартовая проба. Зовётся один раз из App. */
export function initNet(): void {
  if (inited) return
  inited = true
  window.addEventListener('offline', () => setOnline(false))
  // online-событие браузера — только повод проверить: Wi-Fi может быть без интернета
  window.addEventListener('online', () => void kickProbe())
  if (!navigator.onLine) setOnline(false)
  else void kickProbe()
}
