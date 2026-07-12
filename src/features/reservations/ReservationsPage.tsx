import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchReservationsForDay } from './api'
import { fetchTables, fetchOpenTableOrders } from '../tables/api'
import { fetchCurrentLocation } from '../auth/api'
import { useLangStore } from '../../store/langStore'
import { t, formatTime } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import type { Reservation, ReservationStatus } from '../../types'
import AppSidebar from '../../components/AppSidebar'
import ReservationSheet from './ReservationSheet'

/** Локальная дата 'YYYY-MM-DD' */
function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const STATUS_STYLE: Record<ReservationStatus, string> = {
  requested: 'bg-amber-50 text-amber-700 border-amber-200',
  confirmed: 'bg-blue-50 text-blue-700 border-blue-200',
  seated: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  completed: 'bg-gray-100 text-gray-500 border-gray-200',
  no_show: 'bg-gray-100 text-gray-400 border-gray-200',
  cancelled: 'bg-gray-100 text-gray-400 border-gray-200',
}

const STATUS_KEY: Record<ReservationStatus, Parameters<typeof t>[1]> = {
  requested: 'resStatusRequested',
  confirmed: 'resStatusConfirmed',
  seated: 'resStatusSeated',
  completed: 'resStatusCompleted',
  no_show: 'resStatusNoShow',
  cancelled: 'resStatusCancelled',
}

const ACTIVE = new Set<ReservationStatus>(['requested', 'confirmed', 'seated'])

export default function ReservationsPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()

  const [date, setDate] = useState(() => toDateStr(new Date()))
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  // null — закрыто; 'new' — создание; Reservation — детали/правка
  const [editing, setEditing] = useState<Reservation | 'new' | null>(null)

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const { data: tables = [] } = useQuery({ queryKey: ['tables'], queryFn: fetchTables })
  const { data: openOrders = [] } = useQuery({ queryKey: ['open_table_orders'], queryFn: fetchOpenTableOrders })
  const { data: reservations = [] } = useQuery({
    queryKey: ['reservations', date],
    queryFn: () => fetchReservationsForDay(date),
  })

  // Realtime: правка брони на другом устройстве видна сразу
  useEffect(() => {
    const ch = supabase
      .channel('reservations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, () =>
        qc.invalidateQueries({ queryKey: ['reservations'] })
      )
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [qc])

  const tableLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const tb of tables) m.set(tb.id, tb.label)
    return m
  }, [tables])

  const busyTableIds = useMemo(
    () => new Set(openOrders.map((o) => o.table_id)),
    [openOrders],
  )

  const visible = useMemo(
    () => reservations.filter((r) => (filter === 'all' ? true : ACTIVE.has(r.status))),
    [reservations, filter],
  )

  const modeOk = location?.service_mode === 'tables'
  const today = toDateStr(new Date())
  const dateObj = new Date(`${date}T00:00:00`)
  const dateHuman = dateObj.toLocaleDateString(lang === 'he' ? 'he-IL' : 'ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long',
  })
  const shiftDay = (delta: number) => {
    const d = new Date(`${date}T00:00:00`)
    d.setDate(d.getDate() + delta)
    setDate(toDateStr(d))
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="reservations" />

      <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6 gap-3">
          <h1 className="text-2xl font-black text-gray-900">{t(lang, 'reservations')}</h1>
          {modeOk && (
            <button onClick={() => setEditing('new')} className="btn-primary !py-2.5 !px-5">
              {t(lang, 'reservationNew')}
            </button>
          )}
        </div>

        {!modeOk ? (
          <p className="text-gray-500 text-sm">{t(lang, 'serviceModeHint')}</p>
        ) : (
          <>
            {/* Навигация по дате */}
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => shiftDay(-1)}
                className="w-11 h-11 rounded-xl border border-gray-200 flex items-center justify-center text-gray-500 hover:border-gray-400 active:scale-[0.95]"
                aria-label={t(lang, 'back')}
              >
                <span className="rtl:rotate-180">‹</span>
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black text-gray-900 capitalize truncate">{dateHuman}</div>
                {date === today && <div className="text-[11px] text-emerald-600 font-semibold">{t(lang, 'resToday')}</div>}
              </div>
              <label className="relative w-11 h-11 rounded-xl border border-gray-200 flex items-center justify-center text-gray-500 hover:border-gray-400 cursor-pointer">
                <CalendarIcon />
                <input
                  type="date"
                  value={date}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
              <button
                onClick={() => shiftDay(1)}
                className="w-11 h-11 rounded-xl border border-gray-200 flex items-center justify-center text-gray-500 hover:border-gray-400 active:scale-[0.95]"
                aria-label={t(lang, 'back')}
              >
                <span className="rtl:rotate-180">›</span>
              </button>
            </div>

            {/* Фильтр */}
            <div className="inline-flex gap-1 p-1 rounded-xl bg-gray-100 mb-5">
              {(['active', 'all'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`h-9 px-4 rounded-lg text-sm font-semibold transition-colors ${
                    filter === f ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  {t(lang, f === 'active' ? 'resFilterActive' : 'resFilterAll')}
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <p className="text-center text-sm text-gray-400 pt-20">{t(lang, 'resEmpty')}</p>
            ) : (
              <div className="space-y-2 max-w-2xl">
                {visible.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setEditing(r)}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl border border-gray-200 text-start hover:border-gray-400 transition-all active:scale-[0.99]"
                  >
                    <div className="text-lg font-black text-gray-900 tabular-nums w-14 shrink-0">
                      {formatTime(r.reserved_at, lang)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-gray-900 truncate">{r.customer_name}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {r.party_size} {t(lang, 'resPartySize').toLowerCase()}
                        {r.table_id && tableLabel.has(r.table_id) && <> · {t(lang, 'resTable')} {tableLabel.get(r.table_id)}</>}
                        {r.note && <> · {r.note}</>}
                      </div>
                    </div>
                    <span className={`shrink-0 text-[11px] font-bold px-2.5 py-1 rounded-full border ${STATUS_STYLE[r.status]}`}>
                      {t(lang, STATUS_KEY[r.status])}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {editing && (
        <ReservationSheet
          reservation={editing === 'new' ? null : editing}
          defaultDate={date}
          tables={tables}
          busyTableIds={busyTableIds}
          resConfig={location?.settings?.reservations}
          onClose={() => setEditing(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['reservations'] }); setEditing(null) }}
        />
      )}
    </div>
  )
}

function CalendarIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4 10h16M8 3.5v4M16 3.5v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
