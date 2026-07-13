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

export type PrintStatus = 'success' | 'error' | 'no-paper' | 'disconnected'

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
function ensureInstalled(): void {
  if (installed) return
  installed = true
  window.__kassaPrintResult = (jobId, status, message) => {
    // 'queued' — промежуточный, ждём финальный статус
    if (status === 'queued') return
    const p = pending.get(jobId)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(jobId)
    p.resolve({ ok: status === 'success', status: status as PrintStatus, message })
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
export function awaitPrintResult(jobId: string, accepted: boolean): Promise<PrintOutcome> {
  if (!accepted) {
    return Promise.resolve({ ok: false, status: 'error', message: 'not-accepted' })
  }
  ensureInstalled()
  return new Promise<PrintOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(jobId)
      // Нет колбэка вовремя: старый мост или молчащий принтер — не блокируем
      // кассу ошибкой, считаем принятое задание успешным (прежнее поведение).
      resolve({ ok: true, status: 'success', message: 'no-callback' })
    }, RESULT_TIMEOUT_MS)
    pending.set(jobId, { resolve, timer })
  })
}
