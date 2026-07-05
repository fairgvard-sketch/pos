import { useEffect, useState } from 'react'
import type { Table } from '../../types'
import type { Lang } from '../../lib/i18n'
import { t } from '../../lib/i18n'

function useElapsed(isoDate: string | undefined) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isoDate) return
    const id = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [isoDate])

  if (!isoDate) return null
  const ms = Date.now() - new Date(isoDate).getTime()
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h}ч ${m}м` : `${m}м`
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

interface Props {
  table: Table
  lang: Lang
  onClick: () => void
}

const STATUS_CONFIG = {
  free: {
    dot: 'bg-emerald-400',
    label: 'free' as const,
    accent: 'text-emerald-600',
    ring: 'hover:border-gray-300',
    stripe: '',
  },
  occupied: {
    dot: 'bg-amber-400',
    label: 'occupied' as const,
    accent: 'text-amber-600',
    ring: 'hover:border-gray-300',
    stripe: 'border-l-4 border-l-amber-400',
  },
  reserved: {
    dot: 'bg-blue-400',
    label: 'reserved' as const,
    accent: 'text-blue-600',
    ring: 'hover:border-gray-300',
    stripe: 'border-l-4 border-l-blue-400',
  },
  waiting_bill: {
    dot: 'bg-red-500',
    label: 'waitingBill' as const,
    accent: 'text-red-600',
    ring: 'hover:border-gray-300',
    stripe: 'border-l-4 border-l-red-500',
  },
}

export default function TableCard({ table, lang, onClick }: Props) {
  const cfg = STATUS_CONFIG[table.status]
  const elapsed = useElapsed(table.active_order?.created_at)
  const openedAt = table.active_order ? formatTime(table.active_order.created_at) : null

  return (
    <button
      onClick={onClick}
      className={`
        group relative bg-white border border-gray-200 rounded-2xl p-4
        flex flex-col gap-3 text-left overflow-hidden
        transition-all duration-150 active:scale-[0.97] select-none
        shadow-[0_1px_3px_rgba(0,0,0,0.05)]
        hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)]
        ${cfg.ring} ${cfg.stripe}
      `}
    >
      {/* Status dot */}
      <div className={`absolute top-3.5 right-3.5 w-2 h-2 rounded-full ${cfg.dot} ${
        table.status === 'waiting_bill' ? 'animate-ping' : ''
      }`} />
      {table.status === 'waiting_bill' && (
        <div className={`absolute top-3.5 right-3.5 w-2 h-2 rounded-full ${cfg.dot}`} />
      )}

      {/* Number */}
      <span className="text-4xl font-black text-gray-900 leading-none tabular-nums">{table.number}</span>

      {/* Status + time / zone + capacity */}
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-1">
          <span className={`text-xs font-semibold ${cfg.accent}`}>
            {t(lang, cfg.label)}
          </span>
          {openedAt && (
            <span className="text-[11px] tabular-nums text-gray-400 shrink-0">
              {elapsed ?? openedAt}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-1">
          {table.zone && (
            <span className="text-xs text-gray-400">{table.zone}</span>
          )}
          <div className="flex items-center gap-1 text-gray-300 group-hover:text-gray-400 transition-colors ms-auto">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
            </svg>
            <span className="text-xs font-medium">{table.capacity}</span>
          </div>
        </div>
      </div>

      {/* Order summary */}
      {table.active_order?.order_items?.length ? (
        <p className="text-[11px] text-gray-400 leading-tight truncate">
          {table.active_order.order_items.slice(0, 2).map((oi) => {
            const name = oi.menu_item?.name?.split(' ')[0] ?? '—'
            return oi.qty > 1 ? `${oi.qty}×${name}` : name
          }).join(', ')}
          {table.active_order.order_items.length > 2 && ` +${table.active_order.order_items.length - 2}`}
        </p>
      ) : null}
    </button>
  )
}
