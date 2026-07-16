/**
 * Отслеживание заданий печати моста APK (P6).
 *
 * printBase64 у моста возвращает лишь «принято в очередь», не результат.
 * Реальный итог (успех/нет бумаги/ошибка) приходит асинхронно колбэком
 * window.__kassaPrintResult(jobId, status, message). Здесь мы регистрируем
 * этот колбэк и превращаем печать в Promise, чтобы вызывающий мог показать
 * уведомление и кнопку «повторить», а не терять ошибку молча.
 *
 * Старый мост (без jobId/колбэка) результат не шлёт — для него считаем
 * задание успешным по факту приёма (деградация без регресса).
 */
import { captureMessage } from './telemetry'

export type PrintStatus = 'success' | 'error' | 'no-paper' | 'disconnected' | 'timeout'

export interface PrintOutcome {
  ok: boolean
  status: PrintStatus
  message: string | null
}

interface Pending {
  resolve: (o: PrintOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let installed = false

/** Итог печати не пришёл за это время — считаем зависшим (принтер молчит) */
const RESULT_TIMEOUT_MS = 15000

/** Установить глобальный приёмник результатов от моста (идемпотентно) */
export function installPrintResultReceiver(): void {
  if (installed) return
  installed = true
  window.__kassaPrintResult = (jobId, status, message) => {
    // 'queued' — промежуточный, ждём финальный статус
    if (status === 'queued') return
    const p = pending.get(jobId)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(jobId)
    if (status !== 'success') {
      captureMessage('print', `bridge: ${status}${message ? ` (${message})` : ''}`)
    }
    p.resolve({ ok: status === 'success', status: status as PrintStatus, message })
  }
}

/** Только v2+ обещает финальный callback. Старый APK имеет лишь accepted bool. */
export function bridgeSupportsPrintResults(bridge: KassaAndroidBridge | undefined): boolean {
  try {
    return typeof bridge?.bridgeVersion === 'function' && bridge.bridgeVersion() >= 2
  } catch {
    return false
  }
}

/** Сгенерировать id задания печати */
export function newPrintJobId(): string {
  return crypto.randomUUID()
}

/**
 * Дождаться результата задания jobId. Если мост старый (колбэк не придёт) —
 * промис отвалится по таймауту в success (accepted==напечатано, как раньше).
 * accepted=false (мост сразу отказал) → мгновенный error.
 */
export function awaitPrintResult(
  jobId: string,
  accepted: boolean,
  resultAware = true,
): Promise<PrintOutcome> {
  if (!accepted) {
    return Promise.resolve({ ok: false, status: 'error', message: 'not-accepted' })
  }
  installPrintResultReceiver()
  return new Promise<PrintOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(jobId)
      // v2+ обещает callback: его отсутствие — ошибка, а не доказательство
      // физической печати. Для старого APK сохраняем accepted-only fallback.
      if (resultAware) captureMessage('print', 'callback-timeout')
      resolve(resultAware
        ? { ok: false, status: 'timeout', message: 'callback-timeout' }
        : { ok: true, status: 'success', message: 'legacy-no-callback' })
    }, RESULT_TIMEOUT_MS)
    pending.set(jobId, { resolve, timer })
  })
}
