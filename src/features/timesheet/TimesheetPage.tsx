import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchTimesheetReport, clockIn, clockOut, type TimeEntryRow } from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import AppSidebar from '../../components/AppSidebar'

type Period = 'today' | 'week'

/** Границы периода в локальном времени устройства */
function periodRange(period: Period): { from: Date; to: Date } {
  const now = new Date()
  const to = new Date(now)
  to.setHours(23, 59, 59, 999)
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  if (period === 'week') from.setDate(from.getDate() - 6)
  return { from, to }
}

/** Секунды → «Ч:ММ» */
function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}

export default function TimesheetPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const me = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const [period, setPeriod] = useState<Period>('today')
  const { from, to } = periodRange(period)

  const { data: report } = useQuery({
    queryKey: ['timesheet', period],
    queryFn: () => fetchTimesheetReport(from, to),
    refetchInterval: 30_000,
  })

  // Тик для живых таймеров открытых записей
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const invalidate = () => qc.invalidateQueries({ queryKey: ['timesheet'] })

  const startDay = useMutation({
    mutationFn: (staffId: string) => clockIn(staffId),
    onSuccess: () => { invalidate(); toast.success(t(lang, 'workdayStarted')) },
    onError: (e) => toast.error(e.message),
  })
  const endDay = useMutation({
    mutationFn: (staffId: string) => clockOut(staffId),
    onSuccess: () => { invalidate(); toast.success(t(lang, 'workdayEnded')) },
    onError: (e) => toast.error(e.message),
  })

  const entries = report?.entries ?? []
  const openEntries = entries.filter((e) => e.clock_out === null)
  const meOpen = me ? openEntries.some((e) => e.staff_id === me.id) : false

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="timesheet" />

      <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-black text-gray-900">{t(lang, 'timesheet')}</h1>
            {/* Своя кнопка отметки — быстрый доступ */}
            {me && (
              meOpen ? (
                <button
                  onClick={() => endDay.mutate(me.id)}
                  disabled={endDay.isPending}
                  className="btn-secondary !py-2.5 !px-5"
                >
                  {t(lang, 'endWorkday')}
                </button>
              ) : (
                <button
                  onClick={() => startDay.mutate(me.id)}
                  disabled={startDay.isPending}
                  className="btn-primary !py-2.5 !px-5"
                >
                  {t(lang, 'startWorkday')}
                </button>
              )
            )}
          </div>

          {/* Сейчас на смене */}
          <section className="mb-8">
            <h2 className="text-base font-bold text-gray-900 mb-3">{t(lang, 'onShiftNow')}</h2>
            {openEntries.length === 0 ? (
              <p className="text-sm text-gray-500">{t(lang, 'noEntriesYet')}</p>
            ) : (
              <div className="space-y-2">
                {openEntries.map((e) => (
                  <div key={e.id} className="flex items-center gap-3 rounded-2xl border border-gray-200 p-4">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-gray-900 truncate">{e.staff_name}</div>
                      <div className="text-sm text-gray-500 tabular-nums">
                        {t(lang, 'hoursWorked')}: {fmtDuration(liveSeconds(e))}
                        <span className="text-gray-400"> · {t(lang, 'since')} {fmtTime(e.clock_in, lang)}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => endDay.mutate(e.staff_id)}
                      disabled={endDay.isPending}
                      className="btn-ghost !py-2 !px-3 !text-xs shrink-0"
                    >
                      {t(lang, 'endWorkday')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* История за период */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-bold text-gray-900">{t(lang, 'hoursWorked')}</h2>
              <div className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5">
                {(['today', 'week'] as Period[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={`h-9 px-4 rounded-lg text-sm font-semibold transition-all ${
                      period === p
                        ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                        : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    {t(lang, p === 'today' ? 'today' : 'thisWeek')}
                  </button>
                ))}
              </div>
            </div>

            {(report?.totals.length ?? 0) === 0 ? (
              <p className="text-sm text-gray-500">{t(lang, 'noEntriesYet')}</p>
            ) : (
              <div className="space-y-2">
                {report!.totals.map((row) => (
                  <div key={row.staff_id} className="flex items-center justify-between rounded-2xl border border-gray-200 p-4">
                    <div className="flex items-center gap-2 min-w-0">
                      {row.on_shift && <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />}
                      <span className="font-bold text-gray-900 truncate">{row.name}</span>
                    </div>
                    <span className="tabular-nums font-black text-gray-900">{fmtDuration(row.seconds)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  )
}

/** Секунды открытой записи до текущего момента */
function liveSeconds(e: TimeEntryRow): number {
  return Math.max(0, Math.floor((Date.now() - new Date(e.clock_in).getTime()) / 1000))
}

function fmtTime(iso: string, lang: 'ru' | 'he'): string {
  return new Date(iso).toLocaleTimeString(lang === 'he' ? 'he-IL' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })
}
