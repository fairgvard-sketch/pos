import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchTimesheetReport, type TimeEntryRow, type TimesheetReport } from './api'
import { idleStaff } from './hours'
import { fetchStaffList } from '../staff/api'
import { fetchCurrentLocation } from '../auth/api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t, type Lang, localeOf } from '../../lib/i18n'
import AppSidebar from '../../components/AppSidebar'
import EntryEditSheet, { type EditableEntry } from './EntryEditSheet'
import StaffHoursSheet from './StaffHoursSheet'
import HoursReportSheet, { type HoursReportRequest } from './HoursReportSheet'
import HoursSummarySheet from './HoursSummarySheet'

type Period = 'today' | 'week' | 'month' | 'custom'

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
 * Табель: кто сейчас на смене и статистика отработанного за период (день/неделя/месяц/даты)
 * с детализацией смен по каждому сотруднику.
 */
export default function TimesheetPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const locale = localeOf(lang)
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

  // Штат точки — чтобы в списке был и тот, кто в этом периоде не работал
  const { data: staffList = [] } = useQuery({ queryKey: ['staff_list'], queryFn: fetchStaffList })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })

  // Тик для живых таймеров открытых записей
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  // Стабильная ссылка: `?? []` иначе даёт новый массив каждый рендер и рушит
  // мемоизацию byStaff ниже
  const entries = useMemo(() => report?.entries ?? [], [report?.entries])
  const totals = useMemo(() => report?.totals ?? [], [report?.totals])
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

  /**
   * Список людей = смены за период ПЛЮС остальной штат точки с нулём.
   *
   * Раньше в списке был только тот, кто в этом периоде отметился: человека
   * в отпуске, в выходной или просто забывшего отметиться на экране не
   * существовало — а именно его и надо открыть, чтобы посмотреть часы или
   * дописать пропущенную смену. Уволенные (`is_active = false`) не
   * добавляются, но если у них есть смены периода, они остаются: часы
   * отработаны, из табеля их не вычёркивают.
   */
  const rows = useMemo(() => [
    ...totals,
    ...idleStaff(totals, staffList, location?.id ?? null)
      .map((s) => ({ staff_id: s.id, name: s.name, seconds: 0, on_shift: false })),
  ], [totals, staffList, location?.id])

  const multiDay = period !== 'today'
  const [expanded, setExpanded] = useState<string | null>(null)

  // Правка менеджером: существующая запись или новая смена сотрудника
  const [editTarget, setEditTarget] = useState<
    { entry: EditableEntry; staffName: string } | { staffId: string; staffName: string } | null
  >(null)

  /**
   * Карточка часов сотрудника (143). Открывается только менеджеру: отчёт по
   * дням — зарплатные данные, сервер требует право manage, и барista получил
   * бы отказ вместо экрана.
   */
  const [card, setCard] = useState<
    { staffId: string; staffName: string; from?: Date; to?: Date } | null
  >(null)

  /**
   * Отчёты по часам открываются плитками, как в кассе, к которой привык
   * владелец: сначала «какой отчёт», потом форма «кто и за когда», потом
   * сам отчёт. Плитки видит только менеджер — сервер требует право manage.
   */
  const [reportForm, setReportForm] = useState<'staff' | 'summary' | null>(null)
  const [summary, setSummary] = useState<{ from: Date; to: Date } | null>(null)

  function runReport(req: HoursReportRequest) {
    setReportForm(null)
    if (req.staffId) setCard({ staffId: req.staffId, staffName: req.staffName, from: req.from, to: req.to })
    else setSummary({ from: req.from, to: req.to })
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="timesheet" />

      {/* Отметка прихода/ухода переехала на экран PIN («Команда», 10.10.2026);
          здесь — кто на смене, статистика и отчёты */}
      <div className="flex-1 min-w-0 flex gap-3">
          {/* ── Статусы и статистика ── */}
          <main className="flex-1 min-w-0 bg-white rounded-3xl overflow-y-auto p-6">
            <h1 className="text-2xl font-black text-gray-900 mb-6">{t(lang, 'timesheet')}</h1>
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

            {isManager && (
              <section className="mb-8">
                <h2 className="text-base font-bold text-gray-900 mb-3">{t(lang, 'tsReports')}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <ReportTile
                    title={t(lang, 'tsReportStaff')}
                    hint={t(lang, 'tsReportStaffHint')}
                    onClick={() => setReportForm('staff')}
                  />
                  <ReportTile
                    title={t(lang, 'tsReportSummary')}
                    hint={t(lang, 'tsReportSummaryHint')}
                    onClick={() => setReportForm('summary')}
                  />
                </div>
              </section>
            )}

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

              {rows.length === 0 ? (
                <p className="text-sm text-gray-500">{t(lang, 'noEntriesYet')}</p>
              ) : (
                <>
                  {/* Сводка периода */}
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <Stat label={t(lang, 'total')} value={fmtDuration(totalSeconds)} />
                    <Stat label={t(lang, 'tsShiftsCount')} value={String(entries.length)} />
                    <Stat label={t(lang, 'tsStaffCount')} value={String(totals.length)} />
                  </div>

                  {/* По сотрудникам, тап — детализация смен. Люди без смен
                      в этом периоде идут следом, тише и с прочерком: их
                      открывают, чтобы посмотреть другой месяц или дописать
                      пропущенную отметку. */}
                  <div className="space-y-2">
                    {rows.map((row) => {
                      const detail = byStaff.get(row.staff_id)
                      const days = detail?.days ?? 0
                      const worked = detail !== undefined
                      const isOpen = expanded === row.staff_id
                      return (
                        <div key={row.staff_id} className={`rounded-2xl border overflow-hidden ${
                          worked ? 'border-gray-200' : 'border-gray-100'
                        }`}>
                          <button
                            onClick={() => setExpanded(isOpen ? null : row.staff_id)}
                            className="w-full flex items-center justify-between gap-3 p-4 text-start hover:bg-gray-50 transition-colors">
                            <span className="flex items-center gap-2 min-w-0">
                              {row.on_shift && <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />}
                              <span className={`font-bold truncate ${worked ? 'text-gray-900' : 'text-gray-500'}`}>
                                {row.name}
                              </span>
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
                              <span className={`tabular-nums font-black ${worked ? 'text-gray-900' : 'text-gray-400'}`}>
                                {worked ? fmtDuration(row.seconds) : '—'}
                              </span>
                            </span>
                          </button>

                          {/* Личный табель открывается плиткой отчёта, а не
                              отсюда: два входа в один документ — это два
                              разных ответа на вопрос «где смотреть часы» */}
                          {isOpen && (
                            <div className="border-t border-gray-100 px-4 py-2 divide-y divide-gray-50">
                              {!worked && (
                                <p className="py-2 text-sm text-gray-500">{t(lang, 'noEntriesYet')}</p>
                              )}
                              {(detail?.entries ?? []).map((e) => (
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
                                    <button onClick={() => setEditTarget({ entry: e, staffName: e.staff_name })}
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

      {reportForm && (
        <HoursReportSheet
          mode={reportForm}
          staff={rows}
          onCancel={() => setReportForm(null)}
          onSubmit={runReport}
        />
      )}

      {summary && (
        <HoursSummarySheet
          from={summary.from}
          to={summary.to}
          onClose={() => setSummary(null)}
          // Из свода открывается личный табель с тем же периодом: цифра,
          // которую нельзя развернуть, вызывает вопрос без ответа
          onOpenStaff={(staffId, staffName) =>
            setCard({ staffId, staffName, from: summary.from, to: summary.to })}
        />
      )}

      {card && (
        <StaffHoursSheet
          staffId={card.staffId}
          staffName={card.staffName}
          initialFrom={card.from}
          initialTo={card.to}
          onClose={() => setCard(null)}
          // В отчёте по дням сотрудник задан карточкой, в самой смене его id
          // не дублируется — подставляем владельца карточки
          onEdit={(e) => setEditTarget({ entry: { ...e, staff_id: card.staffId }, staffName: card.staffName })}
          onAdd={() => setEditTarget({ staffId: card.staffId, staffName: card.staffName })}
        />
      )}
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
  const locale = localeOf(lang)
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

/** Плитка отчёта: крупная цель под палец, название и что внутри */
function ReportTile({ title, hint, onClick }: { title: string; hint: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="card-hover p-4 text-start min-h-[4.5rem] active:scale-[0.98]">
      <div className="font-bold text-gray-900">{title}</div>
      <div className="text-xs text-gray-500 mt-0.5">{hint}</div>
    </button>
  )
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
