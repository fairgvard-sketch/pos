import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  fetchXReport,
  fetchZReport,
  fetchLastShifts,
  fetchActiveShift,
  closeShift,
  type ReportData,
} from './api'
import { useLangStore } from '../../store/langStore'

const VAT_LABEL = 'מע"מ 17%'

function fmt(n: number) {
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

interface ReportViewProps {
  data: ReportData & { closedAt?: string }
  type: 'X' | 'Z'
  shiftId?: string
  onPrint: () => void
}

function ReportView({ data, type, onPrint }: ReportViewProps) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'

  const rows: { label: string; labelHe: string; value: string; bold?: boolean; separator?: boolean }[] = [
    { label: 'Период с',        labelHe: 'מתאריך',       value: fmtDate(data.from) },
    { label: 'Период по',       labelHe: 'עד תאריך',      value: fmtDate(data.to) },
    { label: '',                labelHe: '',              value: '', separator: true },
    { label: 'Кол-во чеков',    labelHe: 'מספר קבלות',   value: String(data.receiptsCount) },
    { label: 'Средний чек',     labelHe: 'ממוצע לקבלה',  value: `${fmt(data.avgReceipt)} ₪` },
    { label: '',                labelHe: '',              value: '', separator: true },
    { label: 'Наличные',        labelHe: 'מזומן',         value: `${fmt(data.cashRevenue)} ₪` },
    { label: 'Карта',           labelHe: 'אשראי',         value: `${fmt(data.cardRevenue)} ₪` },
    { label: '',                labelHe: '',              value: '', separator: true },
    { label: VAT_LABEL,         labelHe: VAT_LABEL,       value: `${fmt(data.vatAmount)} ₪` },
    { label: '',                labelHe: '',              value: '', separator: true },
    { label: 'ИТОГО',           labelHe: 'סה"כ',          value: `${fmt(data.totalRevenue)} ₪`, bold: true },
  ]

  return (
    <div className="card p-0 overflow-hidden max-w-md w-full" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Report header */}
      <div className={`px-5 py-4 flex items-center justify-between ${type === 'Z' ? 'bg-gray-900' : 'bg-gray-100'}`}>
        <div>
          <p className={`text-xs font-semibold uppercase tracking-widest ${type === 'Z' ? 'text-gray-400' : 'text-gray-500'}`}>
            {type === 'X'
              ? (lang === 'he' ? 'דוח X — ביניים' : 'X-отчёт — промежуточный')
              : (lang === 'he' ? 'דוח Z — סגירת משמרת' : 'Z-отчёт — закрытие смены')}
          </p>
          {type === 'Z' && data.closedAt && (
            <p className="text-white text-xs mt-0.5">{fmtDate(data.closedAt)}</p>
          )}
        </div>
        <span className={`text-4xl font-black ${type === 'Z' ? 'text-white' : 'text-gray-900'}`}>{type}</span>
      </div>

      {/* Rows */}
      <div className="px-5 py-3 flex flex-col gap-0">
        {rows.map((row, i) =>
          row.separator ? (
            <div key={i} className="border-t border-dashed border-gray-200 my-2" />
          ) : (
            <div key={i} className="flex items-baseline justify-between py-1">
              <span className={`text-sm ${row.bold ? 'font-bold text-gray-900' : 'text-gray-500'}`}>
                {isRtl ? row.labelHe : row.label}
              </span>
              <span className={`text-sm tabular-nums ${row.bold ? 'font-black text-gray-900 text-base' : 'font-medium text-gray-800'}`}>
                {row.value}
              </span>
            </div>
          )
        )}
      </div>

      {/* Print button */}
      <div className="px-5 pb-4 pt-2">
        <button onClick={onPrint} className="btn-secondary w-full py-2 text-sm flex items-center justify-center gap-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
          </svg>
          {lang === 'he' ? 'הדפס' : 'Печать'}
        </button>
      </div>
    </div>
  )
}

export default function ReportsTab() {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null)
  const [zReport, setZReport] = useState<(ReportData & { closedAt?: string }) | null>(null)

  const { data: activeShift } = useQuery({
    queryKey: ['active-shift'],
    queryFn: fetchActiveShift,
  })

  const { data: xReport } = useQuery({
    queryKey: ['x-report'],
    queryFn: fetchXReport,
    refetchInterval: 60_000,
  })

  const { data: lastShifts = [] } = useQuery({
    queryKey: ['last-shifts'],
    queryFn: () => fetchLastShifts(10),
  })

  const closeShiftMutation = useMutation({
    mutationFn: async () => {
      if (!activeShift) throw new Error('Нет активной смены')
      const report = await fetchXReport()
      await closeShift(activeShift.id, report.totalRevenue)
      const zData = await fetchZReport(activeShift.id)
      setZReport(zData)
      return zData
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['active-shift'] })
      qc.invalidateQueries({ queryKey: ['last-shifts'] })
      qc.invalidateQueries({ queryKey: ['x-report'] })
      toast.success(lang === 'he' ? 'המשמרת נסגרה' : 'Смена закрыта')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const loadZReportMutation = useMutation({
    mutationFn: (shiftId: string) => fetchZReport(shiftId),
    onSuccess: (data) => setZReport(data),
    onError: (e: Error) => toast.error(e.message),
  })

  const handlePrint = () => window.print()

  return (
    <div className="flex flex-col gap-6">
      {/* X-report */}
      <div>
        <h3 className="font-bold text-gray-800 mb-3 text-sm uppercase tracking-wide">
          {lang === 'he' ? 'דוח X — נוכחי' : 'X-отчёт — текущая смена'}
        </h3>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          {xReport ? (
            <ReportView data={xReport} type="X" onPrint={handlePrint} />
          ) : (
            <div className="card p-8 text-center text-gray-400 text-sm max-w-md w-full">
              {lang === 'he' ? 'אין נתונים לתקופה זו' : 'Нет данных за текущую смену'}
            </div>
          )}

          {/* Close shift = Z */}
          {activeShift && (
            <div className="card p-4 max-w-xs w-full flex flex-col gap-3">
              <p className="text-sm font-semibold text-gray-900">
                {lang === 'he' ? 'סגירת משמרת (Z)' : 'Закрыть смену (Z-отчёт)'}
              </p>
              <p className="text-xs text-gray-500">
                {lang === 'he' ? 'פתיחה: ' : 'Открыта: '}{fmtDate(activeShift.opened_at)}
              </p>
              <p className="text-xs text-gray-400">
                {lang === 'he'
                  ? 'סגירת משמרת תאפס את המונים ותיצור דוח Z'
                  : 'Закрытие смены сбросит счётчики и сформирует Z-отчёт'}
              </p>
              <button
                onClick={() => closeShiftMutation.mutate()}
                disabled={closeShiftMutation.isPending}
                className="btn-danger py-2.5 text-sm"
              >
                {closeShiftMutation.isPending
                  ? (lang === 'he' ? 'סוגר...' : 'Закрываю...')
                  : (lang === 'he' ? 'סגור משמרת' : 'Закрыть смену')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Z-report result */}
      {zReport && (
        <div>
          <h3 className="font-bold text-gray-800 mb-3 text-sm uppercase tracking-wide">
            {lang === 'he' ? 'דוח Z — תוצאה' : 'Z-отчёт — результат'}
          </h3>
          <ReportView data={zReport} type="Z" onPrint={handlePrint} />
        </div>
      )}

      {/* Past shifts */}
      {lastShifts.length > 0 && (
        <div>
          <h3 className="font-bold text-gray-800 mb-3 text-sm uppercase tracking-wide">
            {lang === 'he' ? 'משמרות קודמות' : 'Прошлые смены'}
          </h3>
          <div className="card p-0 overflow-hidden max-w-2xl">
            {lastShifts.map((shift: any, i: number) => (
              <div
                key={shift.id}
                className={`flex items-center justify-between px-4 py-3 gap-4 ${i < lastShifts.length - 1 ? 'border-b border-gray-50' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">
                    {fmtDate(shift.opened_at)} — {fmtDate(shift.closed_at)}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{shift.staff?.name}</p>
                </div>
                <span className="text-sm font-bold text-gray-900 tabular-nums shrink-0">
                  {fmt(shift.total_revenue)} ₪
                </span>
                <button
                  onClick={() => {
                    setSelectedShiftId(shift.id)
                    loadZReportMutation.mutate(shift.id)
                  }}
                  className="btn-ghost text-xs py-1.5 px-3 shrink-0"
                >
                  {loadZReportMutation.isPending && selectedShiftId === shift.id
                    ? '...'
                    : (lang === 'he' ? 'דוח Z' : 'Z-отчёт')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
