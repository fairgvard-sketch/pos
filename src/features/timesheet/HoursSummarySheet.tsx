import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchStaffHours, toDateKey } from './api'
import { formatDay, formatHm, decimalHours, buildHoursCsv, downloadCsv, HEBREW_DOW, RU_DOW } from './hours'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t } from '../../lib/i18n'
import { printHoursSummary } from '../receipt/printService'

interface Props {
  from: Date
  to: Date
  onClose: () => void
  /** Открыть карточку конкретного человека прямо из свода */
  onOpenStaff?: (staffId: string, staffName: string) => void
}

/** Часовой пояс точки: сервер режет сутки по нему, клиент им же и показывает */
const TZ = 'Asia/Jerusalem'

/**
 * Свод часов по всем сотрудникам за период — «דוח שעות עובדים מרוכז»
 * старой кассы: строка на человека, дни, смены и часы, итог снизу.
 *
 * Его несут бухгалтеру вместе с личными табелями, поэтому печать и
 * выгрузка стоят рядом, а строка сотрудника открывает его дни: цифра,
 * которую нельзя развернуть, вызывает вопрос, на который некому ответить.
 */
export default function HoursSummarySheet({ from, to, onClose, onOpenStaff }: Props) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const printMode = useDeviceStore((s) => s.printMode)

  const { data, isLoading, error } = useQuery({
    queryKey: ['staffHours', 'summary', toDateKey(from), toDateKey(to)],
    queryFn: () => fetchStaffHours({ from, to, tz: TZ }),
  })

  const staff = useMemo(() => data?.staff ?? [], [data?.staff])
  const totalSeconds = data?.totals?.seconds ?? 0
  const locationName = staff[0]?.entries[0]?.location_name ?? null

  async function print() {
    const ok = await printHoursSummary({
      locationName: locationName ?? undefined,
      periodFrom: formatDay(toDateKey(from)),
      periodTo: formatDay(toDateKey(to)),
      rows: staff.map((s) => ({
        name: s.name,
        days: s.days,
        hours: formatHm(s.seconds),
        decimal: decimalHours(s.seconds),
      })),
      totalHours: formatHm(totalSeconds),
      totalDecimal: decimalHours(totalSeconds),
    }, printMode === 'rawbt')
    if (!ok) {
      // Тихого пути нет (браузер на ноутбуке) — печатаем скрытый блок
      toast(t(lang, 'tsNoSilentPrinter'))
      window.print()
    }
  }

  function exportExcel() {
    downloadCsv(
      buildHoursCsv(staff, TZ, {
        employee: t(lang, 'tsEmployee'), date: t(lang, 'tsDate'), weekday: t(lang, 'tsWeekday'),
        clockIn: t(lang, 'tsClockIn'), clockOut: t(lang, 'tsClockOut'),
        breakTime: t(lang, 'tsBreak'), hours: t(lang, 'hoursWorked'),
        decimal: t(lang, 'tsDecimalHours'), ranges: t(lang, 'tsRanges'),
        location: t(lang, 'tsLocation'), note: t(lang, 'tsNote'),
        total: t(lang, 'total'), days: t(lang, 'tsDaysShort'), shifts: t(lang, 'tsShiftsCount'),
      }, isRtl ? HEBREW_DOW : RU_DOW),
      `hours_${toDateKey(from)}_${toDateKey(to)}.csv`,
    )
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
        <header className="px-6 pt-6 pb-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-black text-gray-900">{t(lang, 'tsSummaryTitle')}</h2>
            <p className="text-sm text-gray-500 tabular-nums" dir="ltr">
              {formatDay(toDateKey(from))} — {formatDay(toDateKey(to))}
            </p>
            {locationName && <p className="text-sm text-gray-500 truncate">{locationName}</p>}
          </div>
          <button onClick={onClose} className="btn-ghost !h-11 !px-4 shrink-0">{t(lang, 'close')}</button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {error ? (
            <p className="text-sm text-red-600">{error.message}</p>
          ) : isLoading ? (
            <p className="text-sm text-gray-500">…</p>
          ) : staff.length === 0 ? (
            <p className="text-sm text-gray-500">{t(lang, 'noEntriesYet')}</p>
          ) : (
            <div>
              <div className="flex items-center gap-3 pb-2 text-[11px] font-bold uppercase tracking-wide text-gray-400">
                <span className="flex-1">{t(lang, 'tsEmployee')}</span>
                <span className="w-14 text-end shrink-0">{t(lang, 'tsDaysShort')}</span>
                <span className="w-14 text-end shrink-0">{t(lang, 'tsShiftsCount')}</span>
                <span className="w-28 text-end shrink-0">{t(lang, 'total')}</span>
              </div>
              <div className="divide-y divide-gray-50">
                {staff.map((row) => (
                  <button
                    key={row.staff_id}
                    onClick={() => onOpenStaff?.(row.staff_id, row.name)}
                    disabled={!onOpenStaff}
                    className="w-full flex items-center gap-3 py-3 text-start hover:bg-gray-50 rounded-lg px-1 -mx-1 transition-colors"
                  >
                    <span className="flex-1 min-w-0 flex items-center gap-2">
                      {row.has_open && <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />}
                      <span className="font-bold text-gray-900 truncate">{row.name}</span>
                    </span>
                    <span className="w-14 text-end shrink-0 tabular-nums text-gray-500">{row.days}</span>
                    <span className="w-14 text-end shrink-0 tabular-nums text-gray-500">{row.shifts}</span>
                    <span className="w-28 text-end shrink-0 tabular-nums font-bold text-gray-900" dir="ltr">
                      {formatHm(row.seconds)}
                      <span className="text-gray-400 font-normal ms-1.5">{decimalHours(row.seconds)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="px-6 py-4 border-t border-gray-100">
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-sm font-bold text-gray-500">{t(lang, 'total')}</span>
            <span className="text-xl font-black text-gray-900 tabular-nums" dir="ltr">
              {formatHm(totalSeconds)}
              <span className="text-sm font-normal text-gray-400 ms-1.5">{decimalHours(totalSeconds)}</span>
            </span>
          </div>
          <div className="flex gap-2">
            <button onClick={print} disabled={staff.length === 0} className="btn-primary flex-1 !py-3.5 !rounded-2xl">
              {t(lang, 'printReceipt')}
            </button>
            <button onClick={exportExcel} disabled={staff.length === 0} className="btn-secondary flex-1 !py-3.5 !rounded-2xl">
              {t(lang, 'tsExport')}
            </button>
          </div>
        </footer>
      </div>

      {/* Источник браузерной печати: на экране скрыт, в печать уходит один он */}
      <div className="print-source receipt-print" dir="rtl">
        <div style={{ textAlign: 'center', fontWeight: 700 }}>ריכוז שעות עובדים</div>
        {locationName && <div style={{ textAlign: 'center' }}>{locationName}</div>}
        <div style={{ textAlign: 'center' }}>
          {formatDay(toDateKey(from))} — {formatDay(toDateKey(to))}
        </div>
        <hr />
        {staff.map((row) => (
          <div key={row.staff_id} style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
            <span dir="ltr">{formatHm(row.seconds)}</span>
            <span dir="ltr">{row.days}</span>
            <span>{row.name}</span>
          </div>
        ))}
        <hr />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
          <span dir="ltr">{formatHm(totalSeconds)}</span>
          <span>סה"כ שעות</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span dir="ltr">{decimalHours(totalSeconds)}</span>
          <span>סה"כ עשרוני</span>
        </div>
      </div>
    </div>
  )
}
