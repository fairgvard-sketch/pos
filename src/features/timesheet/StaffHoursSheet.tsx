import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchStaffHours, toDateKey, type StaffHoursEntry } from './api'
import {
  groupByDay, formatDay, formatTime, formatHm, decimalHours, formatRanges,
  dayBounds, dayBreakSeconds, buildHoursCsv, downloadCsv,
  monthRange, monthTitle, HEBREW_DOW, RU_DOW,
} from './hours'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t } from '../../lib/i18n'
import { printTimesheet } from '../receipt/printService'
import type { TimesheetPrintData } from '../receipt/printCanvas'

interface Props {
  staffId: string
  staffName: string
  onClose: () => void
  /** Правка смены (менеджер): открывает EntryEditSheet у родителя */
  onEdit?: (entry: StaffHoursEntry) => void
  onAdd?: () => void
}

/** Часовой пояс точки: сервер режет сутки по нему, клиент им же и показывает */
const TZ = 'Asia/Jerusalem'

/**
 * Часы одного сотрудника за период — то, что распечатывают и отдают
 * бухгалтеру.
 *
 * Раскладка повторяет «דוח שעות לעובד» старой системы, к которой привык
 * владелец: шапка с периодом, человеком и точкой, затем колонки
 * приход / уход / перерыв / итог. Перерыв касса отдельно не отбивает —
 * он считается из разрыва между сменами дня.
 *
 * Итог показывается двумя числами: «8:30» читает сотрудник, «8,50» —
 * бухгалтер. Одно из них всё равно пришлось бы пересчитывать руками.
 *
 * Период по умолчанию — текущий месяц: за месяц считают зарплату. Стрелки
 * листают месяцы, «Даты» открывают произвольный диапазон.
 */
export default function StaffHoursSheet({ staffId, staffName, onClose, onEdit, onAdd }: Props) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const locale = isRtl ? 'he-IL' : 'ru-RU'
  const printMode = useDeviceStore((s) => s.printMode)

  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null)

  const [from, to] = useMemo<[Date, Date]>(() => {
    if (custom) {
      const parse = (s: string) => {
        const [y, m, d] = s.split('-').map(Number)
        return new Date(y, m - 1, d)
      }
      let f = parse(custom.from)
      let tt = parse(custom.to)
      if (tt < f) [f, tt] = [tt, f] // перепутанный диапазон — молча чиним
      return [f, tt]
    }
    return monthRange(cursor.year, cursor.month)
  }, [custom, cursor])

  const { data, isLoading, error } = useQuery({
    queryKey: ['staffHours', staffId, toDateKey(from), toDateKey(to)],
    queryFn: () => fetchStaffHours({ from, to, staffIds: [staffId], tz: TZ }),
  })

  const person = data?.staff.find((s) => s.staff_id === staffId)
  const days = useMemo(() => groupByDay(person?.entries ?? []), [person?.entries])
  const breakSeconds = useMemo(() => days.reduce((sum, d) => sum + dayBreakSeconds(d), 0), [days])
  const locationName = person?.entries[0]?.location_name ?? null

  const periodLabel = custom
    ? `${formatDay(toDateKey(from))} — ${formatDay(toDateKey(to))}`
    : monthTitle(cursor.year, cursor.month, locale)

  async function print() {
    if (!person) return
    const payload: TimesheetPrintData = {
      staffName: person.name,
      periodFrom: formatDay(toDateKey(from)),
      periodTo: formatDay(toDateKey(to)),
      // Печать — только иврит (как чек): бумагу читает бухгалтер
      days: days.map((d) => ({
        date: formatDay(d.day),
        dow: HEBREW_DOW[d.dow] ?? '',
        rows: d.entries.map((e) => ({
          range: `${formatTime(e.clock_in, TZ)} - ${e.clock_out ? formatTime(e.clock_out, TZ) : '…'}`,
          hours: formatHm(e.seconds),
        })),
      })),
      locationName: locationName ?? undefined,
      totalHours: formatHm(person.seconds),
      totalDecimal: decimalHours(person.seconds),
      daysCount: person.days,
      shiftsCount: person.shifts,
      breakHours: breakSeconds > 0 ? formatHm(breakSeconds) : undefined,
    }
    const ok = await printTimesheet(payload, printMode === 'rawbt')
    if (!ok) {
      // Тихого пути нет (браузер на ноутбуке) — печатаем скрытый блок
      toast(t(lang, 'tsNoSilentPrinter'))
      window.print()
    }
  }

  function exportExcel() {
    if (!person) return
    downloadCsv(
      buildHoursCsv([person], TZ, {
        employee: t(lang, 'tsEmployee'), date: t(lang, 'tsDate'), weekday: t(lang, 'tsWeekday'),
        clockIn: t(lang, 'tsClockIn'), clockOut: t(lang, 'tsClockOut'),
        breakTime: t(lang, 'tsBreak'), hours: t(lang, 'hoursWorked'),
        decimal: t(lang, 'tsDecimalHours'), ranges: t(lang, 'tsRanges'),
        location: t(lang, 'tsLocation'), note: t(lang, 'tsNote'),
        total: t(lang, 'total'), days: t(lang, 'tsDaysShort'), shifts: t(lang, 'tsShiftsCount'),
      }, isRtl ? HEBREW_DOW : RU_DOW),
      `hours_${person.name}_${toDateKey(from)}_${toDateKey(to)}.csv`,
    )
  }

  function shiftMonth(delta: number) {
    setCustom(null)
    setCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-stretch justify-center p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl flex flex-col overflow-hidden animate-[rise-in_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Шапка: кто и за какой период ── */}
        <header className="px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-black text-gray-900 truncate">{staffName}</h2>
              {/* Шапка отчёта: период и точка — то, что первым спрашивает
                  бухгалтер, глядя на бумагу */}
              <p className="text-sm text-gray-500 tabular-nums" dir="ltr">
                {formatDay(toDateKey(from))} — {formatDay(toDateKey(to))}
              </p>
              {locationName && <p className="text-sm text-gray-500 truncate">{locationName}</p>}
            </div>
            <button onClick={onClose} className="btn-ghost !h-11 !px-4 shrink-0">
              {t(lang, 'close')}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-4">
            <div className="inline-flex items-center rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5">
              <button onClick={() => shiftMonth(-1)} aria-label={t(lang, 'tsPrevMonth')}
                className="h-11 w-11 rounded-lg text-gray-500 hover:text-gray-900 text-lg">
                {isRtl ? '›' : '‹'}
              </button>
              <span className="h-11 min-w-[9rem] px-3 flex items-center justify-center text-sm font-bold text-gray-900">
                {periodLabel}
              </span>
              <button onClick={() => shiftMonth(1)} aria-label={t(lang, 'tsNextMonth')}
                className="h-11 w-11 rounded-lg text-gray-500 hover:text-gray-900 text-lg">
                {isRtl ? '‹' : '›'}
              </button>
            </div>
            <button
              onClick={() => setCustom(custom ? null : { from: toDateKey(from), to: toDateKey(to) })}
              className={`h-11 px-4 rounded-xl text-sm font-semibold ${
                custom ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-500 hover:text-gray-900'
              }`}
            >
              {t(lang, 'periodCustom')}
            </button>
          </div>

          {custom && (
            <div className="flex items-center gap-2 mt-2">
              <input type="date" className="input !w-auto !py-2" value={custom.from}
                onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
              <span className="text-gray-400">—</span>
              <input type="date" className="input !w-auto !py-2" value={custom.to}
                onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
            </div>
          )}
        </header>

        {/* ── Дни ── */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {error ? (
            <p className="text-sm text-red-600">{error.message}</p>
          ) : isLoading ? (
            <p className="text-sm text-gray-500">…</p>
          ) : days.length === 0 ? (
            <p className="text-sm text-gray-500">{t(lang, 'noEntriesYet')}</p>
          ) : (
            <div>
              {/* Колонки те же, что в отчёте, к которому привык владелец:
                  приход, уход, перерыв, итог */}
              <div className="flex items-center gap-3 pb-2 text-[11px] font-bold uppercase tracking-wide text-gray-400">
                <span className="shrink-0 w-[6.5rem]">{t(lang, 'tsDate')}</span>
                <span className="w-5 shrink-0" />
                <span className="w-14 text-end shrink-0">{t(lang, 'tsClockIn')}</span>
                <span className="w-14 text-end shrink-0">{t(lang, 'tsClockOut')}</span>
                <span className="w-14 text-end shrink-0">{t(lang, 'tsBreak')}</span>
                <span className="flex-1 text-end">{t(lang, 'total')}</span>
                {onEdit && <span className="w-11 shrink-0" />}
              </div>

              <div className="divide-y divide-gray-50">
                {days.map((day) => {
                  const bounds = dayBounds(day)
                  const gap = dayBreakSeconds(day)
                  return (
                    <div key={day.day} className="flex items-center gap-3 py-2.5"
                      // Разбитый день: интервалы целиком — подсказкой, чтобы
                      // строка осталась одной, а правда о дне не потерялась
                      title={day.entries.length > 1 ? formatRanges(day, TZ) : undefined}>
                      <span className="tabular-nums text-gray-900 font-semibold shrink-0 w-[6.5rem]" dir="ltr">
                        {formatDay(day.day)}
                      </span>
                      <span className="text-gray-400 w-5 text-center shrink-0">
                        {isRtl ? HEBREW_DOW[day.dow] : RU_DOW[day.dow]}
                      </span>
                      <span className="tabular-nums text-gray-600 w-14 text-end shrink-0" dir="ltr">
                        {formatTime(bounds.in, TZ)}
                      </span>
                      <span className="tabular-nums text-gray-600 w-14 text-end shrink-0" dir="ltr">
                        {bounds.out ? formatTime(bounds.out, TZ) : '…'}
                      </span>
                      <span className={`tabular-nums w-14 text-end shrink-0 ${gap > 0 ? 'text-gray-600' : 'text-gray-300'}`} dir="ltr">
                        {formatHm(gap)}
                      </span>
                      <span className={`flex-1 text-end tabular-nums font-bold ${
                        day.hasOpen ? 'text-emerald-600' : 'text-gray-900'
                      }`} dir="ltr">
                        {formatHm(day.seconds)}
                        <span className="text-gray-400 font-normal ms-1.5">{decimalHours(day.seconds)}</span>
                      </span>
                      {onEdit && (
                        <span className="flex shrink-0">
                          {day.entries.map((e) => (
                            <button key={e.id} onClick={() => onEdit(e)}
                              className="w-11 h-11 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-100"
                              aria-label={t(lang, 'edit')}
                              title={e.edited_at ? `${t(lang, 'tsEdited')}${e.edited_by_name ? ` · ${e.edited_by_name}` : ''}` : undefined}>
                              {e.edited_at ? '✎*' : '✎'}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {onAdd && (
            <button onClick={onAdd} className="w-full py-3 text-sm font-semibold text-gray-400 hover:text-gray-900 text-start">
              + {t(lang, 'tsAddShift')}
            </button>
          )}
        </div>

        {/* ── Итог и действия ── */}
        <footer className="px-6 py-4 border-t border-gray-100">
          <div className={`grid gap-3 mb-3 ${breakSeconds > 0 ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <Stat
              label={t(lang, 'hoursWorked')}
              value={formatHm(person?.seconds ?? 0)}
              /* Десятичные — то число, которым считают зарплату; держим
                 рядом, чтобы никто не пересчитывал «8:30 → 8.5» руками */
              sub={decimalHours(person?.seconds ?? 0)}
            />
            <Stat label={t(lang, 'tsDaysShort')} value={String(person?.days ?? 0)} />
            <Stat label={t(lang, 'tsShiftsCount')} value={String(person?.shifts ?? 0)} />
            {breakSeconds > 0 && <Stat label={t(lang, 'tsBreak')} value={formatHm(breakSeconds)} />}
          </div>
          <div className="flex gap-2">
            <button onClick={print} disabled={!person || days.length === 0} className="btn-primary flex-1 !py-3.5 !rounded-2xl">
              {t(lang, 'printReceipt')}
            </button>
            <button onClick={exportExcel} disabled={!person || days.length === 0} className="btn-secondary flex-1 !py-3.5 !rounded-2xl">
              {t(lang, 'tsExport')}
            </button>
          </div>
        </footer>
      </div>

      {/* Источник браузерной печати: на экране скрыт, в печать уходит один он */}
      <div className="print-source receipt-print" dir="rtl">
        <div style={{ textAlign: 'center', fontWeight: 700 }}>דו"ח שעות עבודה</div>
        <div style={{ textAlign: 'center', fontWeight: 700 }}>{staffName}</div>
        {locationName && <div style={{ textAlign: 'center' }}>{locationName}</div>}
        <div style={{ textAlign: 'center' }}>
          {formatDay(toDateKey(from))} — {formatDay(toDateKey(to))}
        </div>
        <hr />
        {days.map((day) => (
          <div key={day.day} style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
            <span dir="ltr">{formatDay(day.day)}</span>
            <span>{HEBREW_DOW[day.dow]}</span>
            <span dir="ltr">{formatRanges(day, TZ)}</span>
            <span dir="ltr">{formatHm(day.seconds)}</span>
          </div>
        ))}
        <hr />
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span dir="ltr">{person?.days ?? 0}</span>
          <span>ימי עבודה</span>
        </div>
        {breakSeconds > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span dir="ltr">{formatHm(breakSeconds)}</span>
            <span>הפסקות</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
          <span dir="ltr">{formatHm(person?.seconds ?? 0)}</span>
          <span>סה"כ שעות</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span dir="ltr">{decimalHours(person?.seconds ?? 0)}</span>
          <span>סה"כ עשרוני</span>
        </div>
        <div style={{ marginTop: '8px' }}>חתימת העובד/ת: ____________</div>
      </div>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-gray-100 p-3">
      <div className="text-xs font-semibold text-gray-500 mb-0.5">{label}</div>
      <div className="text-lg font-black tabular-nums text-gray-900" dir="ltr">
        {value}
        {sub && <span className="text-sm font-normal text-gray-400 ms-1.5">{sub}</span>}
      </div>
    </div>
  )
}
