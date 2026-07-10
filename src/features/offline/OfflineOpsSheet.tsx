import { useLangStore } from '../../store/langStore'
import { useAuthStore } from '../../store/authStore'
import { useQuery } from '@tanstack/react-query'
import { fetchCurrentLocation } from '../auth/api'
import { useOutboxStore } from '../../lib/offline/outboxStore'
import { kickDrain } from '../../lib/offline/drain'
import type { OutboxOp } from '../../lib/offline/types'
import { useNetStore } from '../../lib/offline/net'
import { t, type TranslationKey } from '../../lib/i18n'
import { can } from '../../lib/perms'
import { formatMoney } from '../../lib/money'
import toast from 'react-hot-toast'

/**
 * Журнал офлайн-очереди: что ждёт отправки, что упало (и почему),
 * что уже синхронизировалось. Failed-операция останавливает очередь —
 * отсюда её можно повторить (после устранения причины) или удалить
 * (каскадом с зависимыми, право void_order).
 */

const KIND_LABEL: Record<OutboxOp['kind'], TranslationKey> = {
  'order.place': 'offlineOpPlace',
  'order.pay': 'offlineOpPay',
  'table.open': 'offlineOpOpen',
  'table.append': 'offlineOpAppend',
  'table.void': 'offlineOpVoid',
  'table.discount': 'offlineOpDiscount',
  'table.void_item': 'offlineOpVoidItem',
  'queue.item_ready': 'offlineOpReady',
  'queue.order_ready': 'offlineOpReady',
}

/** Сумма операции для списка (только у оплат) */
function opAmount(op: OutboxOp): number | null {
  if (op.kind !== 'order.pay') return null
  return op.payload.payments.reduce((s, p) => s + p.amount, 0)
}

export default function OfflineOpsSheet({ onClose }: { onClose: () => void }) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const ops = useOutboxStore((s) => s.ops)
  const localOrders = useOutboxStore((s) => s.localOrders)
  const retryFailed = useOutboxStore((s) => s.retryFailed)
  const discardOp = useOutboxStore((s) => s.discardOp)
  const online = useNetStore((s) => s.online)

  const canDiscard = can(staff?.role, 'void_order', location?.settings)

  const synced = Object.values(localOrders)
    .filter((o) => o.status === 'synced')
    .sort((a, b) => (b.syncedAt ?? '').localeCompare(a.syncedAt ?? ''))
    .slice(0, 10)

  /** Номер заказа для строки: K-n эха либо серверный #daily */
  function opNumber(op: OutboxOp): string {
    const lo = op.orderKey ? localOrders[op.orderKey] : null
    if (lo?.provisionalNumber) return lo.provisionalNumber
    if (lo?.serverDailyNumber) return `#${lo.serverDailyNumber}`
    if (lo?.tableLabel) return lo.tableLabel
    return ''
  }

  function handleDiscard(op: OutboxOp) {
    if (!canDiscard) {
      toast.error(t(lang, 'permManagerToast'))
      return
    }
    if (!confirm(t(lang, 'offlineDiscardConfirm'))) return
    discardOp(op.id)
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden animate-[rise-in_0.2s_ease-out] flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-lg font-bold text-gray-900">{t(lang, 'offlineOpsTitle')}</h2>
          <div className="flex items-center gap-3">
            <span className={online ? 'badge-green' : 'badge-yellow'}>
              {online ? t(lang, 'offlineSyncing') : t(lang, 'offlineBadge')}
            </span>
            <button
              onClick={onClose}
              aria-label={t(lang, 'close')}
              className="w-11 h-11 -me-2 rounded-full flex items-center justify-center text-gray-400
                         hover:bg-gray-100 hover:text-gray-900 transition-all active:scale-[0.94]"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 5L15 15M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-4 overflow-y-auto space-y-2">
          {ops.length === 0 && synced.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-10">{t(lang, 'offlineOpsEmpty')}</p>
          )}

          {ops.map((op) => {
            const amount = opAmount(op)
            const failed = op.status === 'failed'
            return (
              <div
                key={op.id}
                className={`rounded-2xl border p-3 ${failed ? 'border-red-200 bg-red-50' : 'border-gray-100 bg-gray-50'}`}
              >
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-900">
                      {t(lang, KIND_LABEL[op.kind])}
                      {opNumber(op) && <span className="text-gray-500 font-medium"> · {opNumber(op)}</span>}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {new Date(op.createdAt).toLocaleTimeString(isRtl ? 'he-IL' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })}
                      {' · '}
                      {failed ? t(lang, 'offlineFailedLabel') : t(lang, 'offlinePendingLabel')}
                      {failed && op.lastError && <span className="text-red-600"> — {op.lastError}</span>}
                    </div>
                  </div>
                  {amount !== null && (
                    <span className="text-sm font-bold text-gray-900 tabular-nums shrink-0">{formatMoney(amount, lang)}</span>
                  )}
                </div>
                {failed && (
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => {
                        retryFailed(op.id)
                        void kickDrain()
                      }}
                      className="btn-primary !py-2 !px-4 !text-sm !rounded-xl"
                    >
                      {t(lang, 'offlineRetry')}
                    </button>
                    <button onClick={() => handleDiscard(op)} className="btn-danger !py-2 !px-4 !text-sm !rounded-xl">
                      {t(lang, 'offlineDiscard')}
                    </button>
                  </div>
                )}
              </div>
            )
          })}

          {synced.length > 0 && (
            <>
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wide pt-2 px-1">
                {t(lang, 'offlineSyncedLabel')}
              </div>
              {synced.map((o) => (
                <div key={o.key} className="rounded-2xl border border-gray-100 p-3 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-700">
                      {o.provisionalNumber ?? ''}
                      {o.serverDailyNumber && <span className="text-gray-500"> → #{o.serverDailyNumber}</span>}
                      {o.serverReceiptNumber && (
                        <span className="text-gray-500"> · {t(lang, 'receiptNumber')}{o.serverReceiptNumber}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {o.syncedAt &&
                        new Date(o.syncedAt).toLocaleTimeString(isRtl ? 'he-IL' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <span className="text-sm font-bold text-gray-500 tabular-nums shrink-0">{formatMoney(o.total, lang)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
