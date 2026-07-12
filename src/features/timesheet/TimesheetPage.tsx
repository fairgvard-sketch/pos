import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchTimesheetReport, punchByPin, type TimeEntryRow, type TimesheetReport } from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t, type Lang } from '../../lib/i18n'
import { useNetStore } from '../../lib/offline/net'
import AppSidebar from '../../components/AppSidebar'
import EntryEditSheet from './EntryEditSheet'

type Period = 'today' | 'week' | 'month' | 'custom'
const PIN_LENGTH = 4

const PERIODS: { key: Period; label: 'today' | 'thisWeek' | 'thisMonth' | 'periodCustom' }[] = [
  { key: 'today', label: 'today' },
  { key: 'week', label: 'thisWeek' },
  { key: 'month', label: 'thisMonth' },
  { key: 'custom', label: 'periodCustom' },
]

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** YYYY-MM-DD в локальном поясе (toISOString сдвинул бы дату) */
function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Разбор YYYY-MM-DD как локальной полуночи (не UTC) */
function parseDateInput(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
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
 * Рядом — статистика отработанного за период (день/неделя/месяц/даты)
 * с детализацией смен по каждому сотруднику.
 */
export default function TimesheetPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.staff)
  const isManager = me?.role === 'owner' || me?.role === 'manager'

  const [period, setPeriod] = useState<Period>('today')
  const [customFrom, setCustomFrom] = useState(() => toDateInput(startOfToday()))
  const [customTo, setCustomTo] = useState(() => toDateInput(startOfToday()))

  const [from, to] = useMemo<[Date, Date]>(() => {
    const t0 = startOfToday()
    switch (period) {
      case 'today': return [t0, addDays(t0, 1)]
      case 'week': return [addDays(t0, -6), addDays(t0, 1)]
      case 'month': {
        const first = new Date(t0.getFullYear(), t0.getMonth(), 1)
        return [first, addDays(t0, 1)]
      }
      case 'custom': {
        let f = parseDateInput(customFrom)
        let tt = parseDateInput(customTo)
        if (tt < f) [f, tt] = [tt, f] // перепутанный диапазон — молча чиним
        return [f, addDays(tt, 1)]
      }
    }
  }, [period, customFrom, customTo])

  const { data: report } = useQuery({
    queryKey: ['timesheet', from.toISOString(), to.toISOString()],
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
      // Отметка времени требует сети: PIN сверяет сервер (bcrypt в БД)
      if (!useNetStore.getState().online) {
        toast.error(t(lang, 'offlineBlockedHint'))
        setPin('')
        return
      }
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

  // Стабильная ссылка: `?? []` иначе даёт новый массив каждый рендер и рушит
  // мемоизацию byStaff ниже
  const entries = useMemo(() => report?.entries ?? [], [report?.entries])
  const totals = report?.totals ?? []
  const openEntries = entries.filter((e) => e.clock_out === null)

  // ── Статистика периода ──
  const totalSeconds = totals.reduce((sum, r) => sum + r.seconds, 0)

  // Детализация: записи сотрудника + число отработанных дней (по дате прихода)
  const byStaff = useMemo(() => {
    const map = new Map<string, { entries: TimeEntryRow[]; days: number }>()
    for (const e of entries) {
      const g = map.get(e.staff_id) ?? { entries: [], days: 0 }
      g.entries.push(e)
      map.set(e.staff_id, g)
    }
    for (const g of map.values()) {
      g.days = new Set(g.entries.map((e) => toDateInput(new Date(e.clock_in)))).size
    }
    return map
  }, [entries])

  const multiDay = period !== 'today'
  const [expanded, setExpanded] = useState<string | null>(null)

  // Правка менеджером: существующая запись или новая смена сотрудника
  const [editTarget, setEditTarget] = useState<
    { entry: TimeEntryRow } | { staffId: string; staffName: string } | null
  >(null)

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="timesheet" />

      {/* Две панели, как на продаже: слева PIN-терминал (по центру), справа статистика */}
      <div className="flex-1 min-w-0 flex gap-3">
          {/* ── PIN-терминал отметки ── */}
          <section className="w-[clamp(300px,26vw,380px)] shrink-0 bg-white rounded-3xl
                              flex flex-col items-center justify-center p-6 text-center">
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

          {/* ── Статусы и статистика ── */}
          <main className="flex-1 min-w-0 bg-white rounded-3xl overflow-y-auto p-6">
            <section className="mb-8">
              <h2 className="text-base font-bold text-gray-900 mb-3 h-9 flex items-center">{t(lang, 'onShiftNow')}</h2>
              {openEntries.length === 0 ? (
                <p className="text-sm text-gray-500">{t(lang, 'noEntriesYet')}</p>
              ) : (
                <div className="space-y-2">
                  {openEntries.map((e) => (
                    <div key={e.id} className="flex items-center gap-3 rounded-2xl border border-gray-200 p-4">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0" />
                      <div className="flex-1 min-w-0 flex items-baseline justify-between gap-3">
                        <span className="font-bold text-gray-900 truncate">{e.staff_name}</span>
                        <span className="text-sm text-gray-500 tabular-nums shrink-0">
                          {t(lang, 'since')} {fmtTime(e.clock_in, locale)} · <span className="font-bold text-gray-900">{fmtDuration(liveSeconds(e))}</span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h2 className="text-base font-bold text-gray-900">{t(lang, 'hoursWorked')}</h2>
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5">
                    {PERIODS.map((p) => (
                      <button key={p.key} onClick={() => { setPeriod(p.key); setExpanded(null) }}
                        className={`h-9 px-3 rounded-lg text-sm font-semibold transition-all ${
                          period === p.key ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-gray-400 hover:text-gray-600'
                        }`}>
                        {t(lang, p.label)}
                      </button>
                    ))}
                  </div>
                  {isManager && report && entries.length > 0 && (
                    <button onClick={() => exportCsv(report, byStaff, from, to, lang)}
                      className="btn-secondary !h-10 !px-3 !py-0 text-sm">
                      {t(lang, 'tsExport')}
                    </button>
                  )}
                </div>
              </div>

              {period === 'custom' && (
                <div className="flex items-center gap-2 mb-3">
                  <input type="date" className="input !w-auto !py-2" value={customFrom} max={toDateInput(startOfToday())}
                    onChange={(e) => e.target.value && setCustomFrom(e.target.value)} />
                  <span className="text-gray-400">—</span>
                  <input type="date" className="input !w-auto !py-2" value={customTo} max={toDateInput(startOfToday())}
                    onChange={(e) => e.target.value && setCustomTo(e.target.value)} />
                </div>
              )}

              {totals.length === 0 ? (
                <p className="text-sm text-gray-500">{t(lang, 'noEntriesYet')}</p>
              ) : (
                <>
                  {/* Сводка периода */}
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <Stat label={t(lang, 'total')} value={fmtDuration(totalSeconds)} />
                    <Stat label={t(lang, 'tsShiftsCount')} value={String(entries.length)} />
                    <Stat label={t(lang, 'tsStaffCount')} value={String(totals.length)} />
                  </div>

                  {/* По сотрудникам, тап — детализация смен */}
                  <div className="space-y-2">
                    {totals.map((row) => {
                      const detail = byStaff.get(row.staff_id)
                      const days = detail?.days ?? 0
                      const isOpen = expanded === row.staff_id
                      return (
                        <div key={row.staff_id} className="rounded-2xl border border-gray-200 overflow-hidden">
                          <button
                            onClick={() => setExpanded(isOpen ? null : row.staff_id)}
                            className="w-full flex items-center justify-between gap-3 p-4 text-start hover:bg-gray-50 transition-colors">
                            <span className="flex items-center gap-2 min-w-0">
                              {row.on_shift && <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />}
                              <span className="font-bold text-gray-900 truncate">{row.name}</span>
                              {multiDay && days > 0 && (
                                <span className="text-xs text-gray-500 shrink-0">
                                  {days} {t(lang, 'tsDaysShort')}
                                </span>
                              )}
                            </span>
                            <span className="flex items-baseline gap-3 shrink-0">
                              {multiDay && days > 1 && (
                                <span className="text-xs text-gray-500 tabular-nums">
                                  {fmtDuration(Math.round(row.seconds / days))} {t(lang, 'tsAvgPerDay')}
                                </span>
                              )}
                              <span className="tabular-nums font-black text-gray-900">{fmtDuration(row.seconds)}</span>
                            </span>
                          </button>

                          {isOpen && detail && (
                            <div className="border-t border-gray-100 px-4 py-2 divide-y divide-gray-50">
                              {detail.entries.map((e) => (
                                <div key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                                  <span className="text-gray-600 shrink-0">
                                    {fmtDay(e.clock_in, locale)}
                                    {e.edited_at && (
                                      <span className="text-[10px] text-gray-400 ms-2" title={e.note ?? undefined}>
                                        {t(lang, 'tsEdited')}
                                      </span>
                                    )}
                                  </span>
                                  <span className="text-gray-500 tabular-nums flex-1 text-end">
                                    <span dir="ltr">{fmtTime(e.clock_in, locale)} – {e.clock_out ? fmtTime(e.clock_out, locale) : '…'}</span>
                                  </span>
                                  <span className={`tabular-nums font-semibold shrink-0 w-14 text-end ${e.clock_out ? 'text-gray-900' : 'text-emerald-600'}`}>
                                    {fmtDuration(e.seconds ?? liveSeconds(e))}
                                  </span>
                                  {isManager && (
                                    <button onClick={() => setEditTarget({ entry: e })}
                                      className="w-8 h-8 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-100 shrink-0"
                                      aria-label={t(lang, 'edit')}>
                                      ✎
                                    </button>
                                  )}
                                </div>
                              ))}
                              {isManager && (
                                <button
                                  onClick={() => setEditTarget({ staffId: row.staff_id, staffName: row.name })}
                                  className="w-full py-2.5 text-sm font-semibold text-gray-400 hover:text-gray-900 text-start">
                                  + {t(lang, 'tsAddShift')}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </section>
          </main>
      </div>

      {editTarget && <EntryEditSheet target={editTarget} onClose={() => setEditTarget(null)} />}
    </div>
  )
}

/**
 * Выгрузка табеля в Excel: CSV с BOM (кириллица/иврит читаются),
 * разделитель «;», десятичные часы с запятой — формат ru-Excel.
 * Блок смен + блок итогов по сотрудникам.
 */
function exportCsv(
  report: TimesheetReport,
  byStaff: Map<string, { entries: TimeEntryRow[]; days: number }>,
  from: Date,
  to: Date,
  lang: Lang
) {
  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  const esc = (v: string) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const dec = (seconds: number) => (seconds / 3600).toFixed(2).replace('.', ',')
  const row = (cells: string[]) => cells.map(esc).join(';')

  const lines: string[] = [
    row([
      t(lang, 'tsEmployee'), t(lang, 'tsDate'), t(lang, 'tsClockIn'), t(lang, 'tsClockOut'),
      t(lang, 'hoursWorked'), t(lang, 'tsDecimalHours'), t(lang, 'tsNote'),
    ]),
  ]
  // Смены: хронологически, старые сверху (в отчёте — DESC)
  for (const e of [...report.entries].reverse()) {
    const secs = e.seconds ?? liveSeconds(e)
    lines.push(row([
      e.staff_name,
      new Date(e.clock_in).toLocaleDateString(locale),
      fmtTime(e.clock_in, locale),
      e.clock_out ? fmtTime(e.clock_out, locale) : '',
      fmtDuration(secs),
      dec(secs),
      e.note ?? '',
    ]))
  }

  lines.push('')
  lines.push(row([
    t(lang, 'tsEmployee'), t(lang, 'tsDaysShort'), t(lang, 'tsShiftsCount'),
    t(lang, 'hoursWorked'), t(lang, 'tsDecimalHours'),
  ]))
  for (const r of report.totals) {
    const d = byStaff.get(r.staff_id)
    lines.push(row([
      r.name, String(d?.days ?? 0), String(d?.entries.length ?? 0),
      fmtDuration(r.seconds), dec(r.seconds),
    ]))
  }

  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `timesheet_${toDateInput(from)}_${toDateInput(addDays(to, -1))}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-gray-100 p-4">
      <div className="text-xs font-semibold text-gray-500 mb-1">{label}</div>
      <div className="text-xl font-black tabular-nums text-gray-900">{value}</div>
    </div>
  )
}

/** Секунды открытой записи до текущего момента */
function liveSeconds(e: TimeEntryRow): number {
  return Math.max(0, Math.floor((Date.now() - new Date(e.clock_in).getTime()) / 1000))
}

function fmtTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

function fmtDay(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
}
