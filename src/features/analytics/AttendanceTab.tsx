import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { clockIn, clockOut, fetchClockEvents, fetchAllStaff, fetchTodayClockStatus } from './api'
import { useLangStore } from '../../store/langStore'
import { useAuthStore } from '../../store/authStore'

type ViewMode = 'today' | 'history'

const ROLE_LABEL: Record<string, { ru: string; he: string }> = {
  waiter:  { ru: 'Официант', he: 'מלצר' },
  manager: { ru: 'Менеджер', he: 'מנהל' },
  kitchen: { ru: 'Кухня',    he: 'מטבח' },
}

function formatDuration(ms: number) {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h === 0) return `${m} мин`
  return `${h}ч ${m}м`
}

type ClockEvent = { id: string; staff_id: string; event_type: string; created_at: string; staff?: { name: string; role: string } }
type StaffMember = { id: string; name: string; role: string }

function HistorySummary({
  events,
  staff,
  lang,
  formatTime,
  isRu,
}: {
  events: ClockEvent[]
  staff: StaffMember[]
  lang: string
  formatTime: (iso: string) => string
  isRu: boolean
}) {
  // Build per-staff summary: first clock_in, last clock_out, total worked ms
  const summaries = staff.map((s) => {
    const staffEvents = events
      .filter((e) => e.staff_id === s.id)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

    if (staffEvents.length === 0) return null

    const firstIn = staffEvents.find((e) => e.event_type === 'clock_in')
    const lastOut = [...staffEvents].reverse().find((e) => e.event_type === 'clock_out')

    let totalMs = 0
    let lastInTs: number | null = null
    for (const e of staffEvents) {
      if (e.event_type === 'clock_in') {
        lastInTs = new Date(e.created_at).getTime()
      } else if (e.event_type === 'clock_out' && lastInTs !== null) {
        totalMs += new Date(e.created_at).getTime() - lastInTs
        lastInTs = null
      }
    }

    return { staff: s, firstIn, lastOut, totalMs, stillWorking: lastInTs !== null }
  }).filter((x): x is NonNullable<typeof x> => x !== null)

  if (summaries.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400 text-sm">
        {isRu ? 'Нет событий за этот день' : 'אין אירועים ביום זה'}
      </div>
    )
  }

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-gray-100 grid grid-cols-[1fr_auto_auto_auto] gap-4">
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
          {isRu ? 'Сотрудник' : 'עובד'}
        </span>
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide w-14 text-center">
          {isRu ? 'Пришёл' : 'כניסה'}
        </span>
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide w-14 text-center">
          {isRu ? 'Ушёл' : 'יציאה'}
        </span>
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide w-16 text-right">
          {isRu ? 'Итого' : 'סה"כ'}
        </span>
      </div>

      {summaries.map(({ staff: s, firstIn, lastOut, totalMs, stillWorking }, i) => (
        <div
          key={s.id}
          className={`px-4 py-3 grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center ${
            i !== summaries.length - 1 ? 'border-b border-gray-50' : ''
          }`}
        >
          <div>
            <p className="text-sm font-semibold text-gray-900">{s.name}</p>
            <p className="text-[11px] text-gray-400">{ROLE_LABEL[s.role]?.[lang as 'ru' | 'he'] ?? s.role}</p>
          </div>

          <span className="text-sm tabular-nums text-emerald-600 font-medium w-14 text-center">
            {firstIn ? formatTime(firstIn.created_at) : '—'}
          </span>

          <span className="text-sm tabular-nums w-14 text-center font-medium">
            {lastOut
              ? <span className="text-red-500">{formatTime(lastOut.created_at)}</span>
              : stillWorking
                ? <span className="text-amber-500">{isRu ? 'ещё тут' : 'עדיין כאן'}</span>
                : <span className="text-gray-300">—</span>
            }
          </span>

          <span className="text-sm tabular-nums font-bold text-gray-700 w-16 text-right">
            {totalMs > 0 ? formatDuration(totalMs) : <span className="text-gray-300">—</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function AttendanceTab() {
  const lang = useLangStore((s) => s.lang)
  const currentStaff = useAuthStore((s) => s.currentStaff)
  const qc = useQueryClient()
  const [mode, setMode] = useState<ViewMode>('today')
  const [historyDate, setHistoryDate] = useState(() => new Date().toISOString().slice(0, 10))

  const isRu = lang === 'ru'

  const { data: allStaff = [] } = useQuery({
    queryKey: ['all-staff'],
    queryFn: fetchAllStaff,
  })

  const { data: todayStatus = {} } = useQuery({
    queryKey: ['today-clock-status'],
    queryFn: fetchTodayClockStatus,
    refetchInterval: 30_000,
  })

  const { data: historyEvents = [], isLoading: histLoading } = useQuery({
    queryKey: ['clock-events', historyDate],
    queryFn: () => {
      const from = historyDate + 'T00:00:00'
      const to = historyDate + 'T23:59:59'
      return fetchClockEvents(from, to)
    },
    enabled: mode === 'history',
  })

  const { data: todayEvents = [] } = useQuery({
    queryKey: ['clock-events-today'],
    queryFn: () => {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const from = today.toISOString()
      const to = new Date().toISOString()
      return fetchClockEvents(from, to)
    },
    refetchInterval: 30_000,
  })

  const clockInMutation = useMutation({
    mutationFn: (staffId: string) => clockIn(staffId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['today-clock-status'] })
      qc.invalidateQueries({ queryKey: ['clock-events-today'] })
      toast.success(isRu ? 'Приход отмечен' : 'כניסה סומנה')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const clockOutMutation = useMutation({
    mutationFn: (staffId: string) => clockOut(staffId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['today-clock-status'] })
      qc.invalidateQueries({ queryKey: ['clock-events-today'] })
      toast.success(isRu ? 'Уход отмечен' : 'יציאה סומנה')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  // Compute worked hours per staff from today's events (pairs clock_in → clock_out)
  function computeWorkedMs(staffId: string): number {
    const events = todayEvents
      .filter((e) => e.staff_id === staffId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

    let total = 0
    let lastIn: number | null = null
    for (const e of events) {
      if (e.event_type === 'clock_in') {
        lastIn = new Date(e.created_at).getTime()
      } else if (e.event_type === 'clock_out' && lastIn !== null) {
        total += new Date(e.created_at).getTime() - lastIn
        lastIn = null
      }
    }
    if (lastIn !== null) {
      total += Date.now() - lastIn
    }
    return total
  }

  function getFirstClockIn(staffId: string): string | null {
    const first = todayEvents
      .filter((e) => e.staff_id === staffId && e.event_type === 'clock_in')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0]
    return first ? first.created_at : null
  }

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(lang === 'he' ? 'he-IL' : 'ru-RU', {
      hour: '2-digit', minute: '2-digit',
    })

  return (
    <div className="flex flex-col gap-4">
      {/* Mode toggle */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        {(['today', 'history'] as ViewMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              mode === m ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {m === 'today'
              ? (isRu ? 'Сегодня' : 'היום')
              : (isRu ? 'История' : 'היסטוריה')}
          </button>
        ))}
      </div>

      {mode === 'today' && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-gray-400 uppercase tracking-widest font-semibold">
            {isRu ? 'Учёт рабочего времени — сегодня' : 'שעון נוכחות — היום'}
          </p>
          {allStaff.map((s) => {
            const status = todayStatus[s.id] ?? null
            const isClockedIn = status === 'clock_in'
            const worked = computeWorkedMs(s.id)
            const firstClockIn = getFirstClockIn(s.id)
            const isMe = s.id === currentStaff?.id
            const isPending =
              clockInMutation.isPending || clockOutMutation.isPending

            return (
              <div key={s.id} className="card p-4 flex items-center gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900 text-sm">{s.name}</span>
                    {isMe && (
                      <span className="badge-blue text-[10px]">
                        {isRu ? 'я' : 'אני'}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400">
                    {ROLE_LABEL[s.role]?.[lang] ?? s.role}
                  </span>
                </div>

                {worked > 0 && (
                  <div className="flex flex-col items-end">
                    <span className="text-sm font-bold text-gray-700 tabular-nums">
                      {formatDuration(worked)}
                    </span>
                    {firstClockIn && (
                      <span className="text-[11px] text-gray-400 tabular-nums">
                        {isRu ? 'с ' : 'מ-'}{formatTime(firstClockIn)}
                      </span>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  {status === null && (
                    <span className="w-2 h-2 rounded-full bg-gray-300" title={isRu ? 'Не отмечался' : 'לא סומן'} />
                  )}
                  {isClockedIn && (
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" title={isRu ? 'На месте' : 'נוכח'} />
                  )}
                  {status === 'clock_out' && (
                    <span className="w-2 h-2 rounded-full bg-gray-400" title={isRu ? 'Ушёл' : 'יצא'} />
                  )}

                  {!isClockedIn ? (
                    <button
                      onClick={() => clockInMutation.mutate(s.id)}
                      disabled={isPending}
                      className="btn-success text-xs px-3 py-1.5"
                    >
                      {isRu ? 'Пришёл' : 'כניסה'}
                    </button>
                  ) : (
                    <button
                      onClick={() => clockOutMutation.mutate(s.id)}
                      disabled={isPending}
                      className="btn-danger text-xs px-3 py-1.5"
                    >
                      {isRu ? 'Ушёл' : 'יציאה'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {mode === 'history' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <input
              type="date"
              value={historyDate}
              onChange={(e) => setHistoryDate(e.target.value)}
              className="input text-sm"
            />
          </div>

          {histLoading ? (
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded-xl bg-gray-100 animate-pulse" />
              ))}
            </div>
          ) : (
            <HistorySummary
              events={historyEvents}
              staff={allStaff}
              lang={lang}
              formatTime={formatTime}
              isRu={isRu}
            />
          )}
        </div>
      )}
    </div>
  )
}
