import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import type { PrintStatus } from '../../lib/printJobs'
import { printCanvasWithResult } from '../../lib/escpos'

/**
 * Ненавязчивое уведомление об ошибке автопечати с кнопкой «повторить» (P6).
 * Ошибка печати не должна теряться: кассир видит тост и может перепечатать,
 * не прерывая поток продажи. Не блокирует, сам гаснет.
 */
export function notifyPrintFailure(
  status: PrintStatus,
  onRetry: () => void,
  detail?: string | null,
): void {
  const lang = useLangStore.getState().lang
  const reason =
    status === 'no-paper'
      ? t(lang, 'printNoPaper')
      : status === 'disconnected'
        ? t(lang, 'printDisconnected')
        : t(lang, 'printError')
  // Причина от моста/принтера — в лог и мелко в тост: без неё ошибка
  // недиагностируема удалённо (PII в статусах печати нет).
  const code = detail ? `${status} · ${detail}` : status
  console.warn('[print]', code)

  toast(
    (tst) => (
      <span className="flex items-center gap-3">
        <span>
          <span className="block">{reason}</span>
          <span className="block text-xs text-gray-500" dir="ltr">{code}</span>
        </span>
        <button
          onClick={() => {
            toast.dismiss(tst.id)
            onRetry()
          }}
          className="bg-gray-50 text-gray-900 font-bold rounded-lg px-3 py-1.5"
        >
          {t(lang, 'printRetry')}
        </button>
      </span>
    ),
    { duration: 8000 }
  )
}

/** Единый result-aware путь с retry для любой тихой canvas-печати. */
export async function printCanvasWithRetry(
  makeCanvas: () => HTMLCanvasElement,
  allowRawbt: boolean,
): Promise<boolean> {
  try {
    const outcome = await printCanvasWithResult(makeCanvas(), allowRawbt)
    if (outcome.ok) return true
    notifyPrintFailure(outcome.status, () => {
      void printCanvasWithRetry(makeCanvas, allowRawbt)
    }, outcome.message)
    return false
  } catch (e) {
    notifyPrintFailure('error', () => {
      void printCanvasWithRetry(makeCanvas, allowRawbt)
    }, e instanceof Error ? e.message : null)
    return false
  }
}
