import { useState, useEffect, useCallback, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchTimesheetReport, punchByPin, type TimeEntryRow } from './api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import AppSidebar from '../../components/AppSidebar'

type Period = 'today' | 'week'
const PIN_LENGTH = 4

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

/**
 * Табель = терминал отметки: сотрудник вводит свой PIN, сервер сам его
 * определяет и переключает clock-in ⇄ clock-out. Отметить чужой день нельзя.
 */
export default function TimesheetPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
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

  // ── PIN-пад отметки ──
  const [pin, setPin] = useState('')
  const [checking, setChecking] = useState(false)
  const [shake, setShake] = useState(false)
  const submitting = useRef(false)

  const submit = useCallback(
    async (fullPin: string) => {
      if (submitting.current) return
      submitting.current = true
      setChecking(true)
      try {
        const res = await punchByPin(fullPin)
        const msg = res.action === 'in'
          ? `${res.staff_name} — ${t(lang, 'workdayStarted')}`
          : `${res.staff_name} — ${t(lang, 'workdayEnded')}${res.seconds != null ? ` · ${fmtDuration(res.seconds)}` : ''}`
        toast.success(msg)
        setPin('')
        qc.invalidateQueries({ queryKey: ['timesheet'] })
      } catch {
        setShake(true)
        setTimeout(() => setShake(false), 400)
        setPin('')
      } finally {
        setChecking(false)
        submitting.current = false
      }
    },
    [lang, qc]
  )

  const press = useCallback(
    (digit: string) => {
      if (checking) return
      const next = (pin + digit).slice(0, PIN_LENGTH)
      setPin(next)
      if (next.length === PIN_LENGTH) submit(next)
    },
    [pin, checking, submit]
  )
  const backspace = useCallback(() => { if (!checking) setPin((p) => p.slice(0, -1)) }, [checking])

  const entries = report?.entries ?? []
  const openEntries = entries.filter((e) => e.clock_out === null)

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="timesheet" />

      <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto grid md:grid-cols-[auto_1fr] gap-8">
          {/* ── PIN-терминал отметки ── */}
          <section className="shrink-0">
            <h1 className="text-2xl font-black text-gray-900 mb-1">{t(lang, 'timesheet')}</h1>
            <p className="text-sm text-gray-500 mb-6">{t(lang, 'enterPin')}</p>

            <div className={`flex gap-3 mb-6 justify-center ${shake ? 'animate-[shake_0.4s_ease-in-out]' : ''}`}>
              {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                <div key={i} className={`w-3.5 h-3.5 rounded-full transition-all ${i < pin.length ? 'bg-gray-900 scale-110' : 'bg-gray-200'}`} />
              ))}
            </div>

            <div className="grid grid-cols-3 gap-2 w-full max-w-[260px] mx-auto">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} onClick={() => press(d)} disabled={checking}
                  className="card-hover h-14 text-xl font-bold text-gray-900 active:scale-[0.95]">
                  {d}
                </button>
              ))}
              <div />
              <button onClick={() => press('0')} disabled={checking}
                className="card-hover h-14 text-xl font-bold text-gray-900 active:scale-[0.95]">
                0
              </button>
              <button onClick={backspace} disabled={checking} className="btn-ghost h-14 text-lg" aria-label="backspace">⌫</button>
            </div>
          </section>

          {/* ── Статусы и история ── */}
          <div>
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
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-bold text-gray-900">{t(lang, 'hoursWorked')}</h2>
                <div className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5">
                  {(['today', 'week'] as Period[]).map((p) => (
                    <button key={p} onClick={() => setPeriod(p)}
                      className={`h-9 px-4 rounded-lg text-sm font-semibold transition-all ${
                        period === p ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-gray-400 hover:text-gray-600'
                      }`}>
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
