import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import type { PrintStatus } from '../../lib/printJobs'

/**
 * Ненавязчивое уведомление об ошибке автопечати с кнопкой «повторить» (P6).
 * Ошибка печати не должна теряться: кассир видит тост и может перепечатать,
 * не прерывая поток продажи. Не блокирует, сам гаснет.
 */
export function notifyPrintFailure(status: PrintStatus, onRetry: () => void): void {
  const lang = useLangStore.getState().lang
  const reason =
    status === 'no-paper'
      ? t(lang, 'printNoPaper')
      : status === 'disconnected'
        ? t(lang, 'printDisconnected')
        : t(lang, 'printError')

  toast(
    (tst) => (
      <span className="flex items-center gap-3">
        <span>{reason}</span>
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
    { duration: 8000, icon: '🖨️' }
  )
}
