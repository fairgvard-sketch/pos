import { useState } from 'react'
import { useNetStore } from '../lib/offline/net'
import { useOutboxStore, pendingOpsCount, hasFailedOps, hasBlockedAuthOps } from '../lib/offline/outboxStore'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'
import OfflineOpsSheet from '../features/offline/OfflineOpsSheet'

/**
 * Индикатор офлайн-режима в сайдбаре. Ничего не рисует, пока сеть есть
 * и очередь пуста (обычный день). Янтарный — нет сети; серый — сеть
 * вернулась, очередь дренируется; красный — операция упала, нужен разбор.
 * Тап открывает журнал операций.
 */
export default function OfflineBadge() {
  const lang = useLangStore((s) => s.lang)
  const online = useNetStore((s) => s.online)
  const ops = useOutboxStore((s) => s.ops)
  const [showSheet, setShowSheet] = useState(false)

  const pending = pendingOpsCount({ ops })
  const failed = hasFailedOps({ ops })
  const waitingPin = !failed && hasBlockedAuthOps({ ops })

  if (online && pending === 0 && !failed) return null

  // Порядок приоритета цвета: красный (разбор) → синий (ждёт PIN) → серый
  // (синк) → янтарный (нет сети). blocked_auth решается вводом PIN, не разбором.
  const style = failed
    ? 'bg-red-50 text-red-700 border-red-200'
    : waitingPin
      ? 'bg-blue-50 text-blue-700 border-blue-200'
      : online
        ? 'bg-gray-100 text-gray-600 border-gray-200'
        : 'bg-amber-50 text-amber-700 border-amber-200'

  const label = failed
    ? t(lang, 'offlineAttention')
    : waitingPin
      ? t(lang, 'offlineWaitingPin')
      : online
        ? t(lang, 'offlineSyncing')
        : t(lang, 'offlineBadge')

  const dot = failed
    ? 'bg-red-500'
    : waitingPin
      ? 'bg-blue-500'
      : online
        ? 'bg-gray-400 animate-pulse'
        : 'bg-amber-500'

  return (
    <>
      <button
        onClick={() => setShowSheet(true)}
        className={`w-full flex items-center gap-2 px-3 h-11 rounded-xl border text-sm font-semibold
                    transition-all active:scale-[0.97] ${style}`}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        <span className="truncate">{label}</span>
        {pending > 0 && <span className="ms-auto tabular-nums shrink-0">{pending}</span>}
      </button>
      {showSheet && <OfflineOpsSheet onClose={() => setShowSheet(false)} />}
    </>
  )
}
