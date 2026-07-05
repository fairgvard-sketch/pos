import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  fetchXReport, fetchZReport, fetchLastShifts, fetchActiveShift, closeShift,
  fetchClockEvents, fetchAllStaff, fetchDiscountReport,
  type ReportData, type ClockEvent, type DiscountRow,
} from '../analytics/api'
import { useLangStore } from '../../store/langStore'
import HubButton from '../../components/ui/HubButton'
import LangToggle from '../../components/ui/LangToggle'
import { useAuthStore } from '../../store/authStore'
import { t } from '../../lib/i18n'

const VAT_RATE = 0.17

function fmt(n: number) {
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
}
function formatDuration(ms: number) {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h}ч ${m}м` : `${m}м`
}

type View = 'menu' | 'x' | 'z' | 'attendance' | 'staff-hours' | 'discounts' | 'z-history'

function ReportTable({ data, type }: { data: ReportData & { closedAt?: string }; type: 'X' | 'Z' }) {
  const lang = useLangStore((s) => s.lang)
  const isRu = lang === 'ru'
  const rows = [
    { ru: 'Период с',     he: 'מתאריך',      value: fmtDate(data.from) },
    { ru: 'Период по',    he: 'עד תאריך',     value: fmtDate(data.to) },
    null,
    { ru: 'Кол-во чеков', he: 'מספר קבלות',  value: String(data.receiptsCount), large: true },
    { ru: 'Средний чек',  he: 'ממוצע לקבלה', value: `${fmt(data.avgReceipt)} ₪` },
    null,
    { ru: 'Наличные',     he: 'מזומן',        value: `${fmt(data.cashRevenue)} ₪` },
    { ru: 'Карта',        he: 'אשראי',        value: `${fmt(data.cardRevenue)} ₪` },
    null,
    { ru: `НДС (מע"מ ${Math.round(VAT_RATE * 100)}%)`, he: `מע"מ ${Math.round(VAT_RATE * 100)}%`, value: `${fmt(data.vatAmount)} ₪` },
    null,
    { ru: 'ИТОГО', he: 'סה"כ', value: `${fmt(data.totalRevenue)} ₪`, total: true },
  ]
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
      <div className={`px-5 py-4 flex items-center justify-between ${type === 'Z' ? 'bg-gray-900' : 'bg-gray-50 border-b border-gray-100'}`}>
        <div>
          <p className={`text-xs font-semibold uppercase tracking-widest ${type === 'Z' ? 'text-gray-400' : 'text-gray-500'}`}>
            {type === 'X' ? (isRu ? 'X-отчёт — промежуточный' : 'דוח X — ביניים') : (isRu ? 'Z-отчёт — закрытие смены' : 'דוח Z — סגירת משמרת')}
          </p>
          {type === 'Z' && data.closedAt && <p className="text-white/70 text-xs mt-0.5">{fmtDate(data.closedAt)}</p>}
        </div>
        <span className={`text-5xl font-black leading-none ${type === 'Z' ? 'text-white' : 'text-gray-200'}`}>{type}</span>
      </div>
      <div className="px-5 py-2">
        {rows.map((row, i) =>
          row === null ? (
            <div key={i} className="border-t border-dashed border-gray-100 my-1.5" />
          ) : (
            <div key={i} className="flex items-baseline justify-between py-1.5">
              <span className={`text-sm ${row.total ? 'font-bold text-gray-900' : 'text-gray-500'}`}>
                {isRu ? row.ru : row.he}
              </span>
              <span className={`tabular-nums ${row.total ? 'text-2xl font-black text-gray-900' : row.large ? 'text-lg font-bold text-gray-900' : 'text-sm font-medium text-gray-800'}`}>
                {row.value}
              </span>
            </div>
          )
        )}
      </div>
      <div className="px-5 pb-4 pt-2">
        <button onClick={() => window.print()} className="btn-secondary w-full py-2 text-sm flex items-center justify-center gap-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.056 48.056 0 011.913-.247m10.5 0a48.536 48.536 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5zm-3 0h.008v.008H15V10.5z" />
          </svg>
          {isRu ? 'Распечатать' : 'הדפס'}
        </button>
      </div>
    </div>
  )
}

// ─── Tile grid ────────────────────────────────────────────────────────────────
const TILES: { key: View; ru: string; he: string; icon: string }[] = [
  { key: 'x',           ru: 'X-отчёт',              he: 'דוח X',                    icon: 'X'  },
  { key: 'attendance',  ru: 'Табель сотрудников',    he: 'דוח שעות עובדים',           icon: 'T'  },
  { key: 'z',           ru: 'Z-отчёт',              he: 'דוח Z',                    icon: 'Z'  },
  { key: 'staff-hours', ru: 'Часы по сотруднику',   he: 'דוח שעות לעובד',            icon: 'H'  },
  { key: 'z-history',   ru: 'История смен',         he: 'ריקוז Z',                   icon: 'ZZ' },
  { key: 'discounts',   ru: 'Отчёт скидок',         he: 'דוח מבצעים',                icon: '%'  },
]

// ─── Sub-views ────────────────────────────────────────────────────────────────

function AttendanceReport({ isRu }: { isRu: boolean }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const { data: events = [], isLoading } = useQuery<ClockEvent[]>({
    queryKey: ['clock-events-report', date],
    queryFn: () => fetchClockEvents(date + 'T00:00:00', date + 'T23:59:59'),
  })
  const { data: allStaff = [] } = useQuery({ queryKey: ['all-staff'], queryFn: fetchAllStaff })

  function workedMs(staffId: string) {
    const es = events.filter(e => e.staff_id === staffId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    let total = 0; let lastIn: number | null = null
    for (const e of es) {
      if (e.event_type === 'clock_in') lastIn = new Date(e.created_at).getTime()
      else if (e.event_type === 'clock_out' && lastIn !== null) { total += new Date(e.created_at).getTime() - lastIn; lastIn = null }
    }
    if (lastIn !== null) total += Date.now() - lastIn
    return total
  }

  const staffWithEvents = allStaff.filter(s => events.some(e => e.staff_id === s.id))

  return (
    <div className="flex flex-col gap-4">
      <input type="date" value={date} onChange={e => setDate(e.target.value)} className="input text-sm w-48" />
      {isLoading ? <div className="card p-8 text-center text-gray-400 text-sm animate-pulse">...</div>
        : staffWithEvents.length === 0
        ? <div className="card p-8 text-center text-gray-400 text-sm">{isRu ? 'Нет данных за этот день' : 'אין נתונים ליום זה'}</div>
        : (
          <div className="card overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 grid grid-cols-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <span>{isRu ? 'Сотрудник' : 'עובד'}</span>
              <span>{isRu ? 'Приход' : 'כניסה'}</span>
              <span>{isRu ? 'Уход' : 'יציאה'}</span>
              <span className="text-right">{isRu ? 'Итого' : 'סה"כ'}</span>
            </div>
            {staffWithEvents.map(s => {
              const ins = events.filter(e => e.staff_id === s.id && e.event_type === 'clock_in')
              const outs = events.filter(e => e.staff_id === s.id && e.event_type === 'clock_out')
              const ms = workedMs(s.id)
              return (
                <div key={s.id} className="px-4 py-3 border-b border-gray-50 last:border-0 grid grid-cols-4 items-center">
                  <span className="text-sm font-semibold text-gray-900">{s.name}</span>
                  <span className="text-sm text-gray-600">{ins.map(e => fmtTime(e.created_at)).join(', ') || '—'}</span>
                  <span className="text-sm text-gray-600">{outs.map(e => fmtTime(e.created_at)).join(', ') || '—'}</span>
                  <span className="text-sm font-bold text-gray-900 text-right">{ms > 0 ? formatDuration(ms) : '—'}</span>
                </div>
              )
            })}
          </div>
        )
      }
    </div>
  )
}

function StaffHoursReport({ isRu }: { isRu: boolean }) {
  const [dateFrom, setDateFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10) })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [selectedStaff, setSelectedStaff] = useState<string>('')
  const { data: allStaff = [] } = useQuery({ queryKey: ['all-staff'], queryFn: fetchAllStaff })
  const { data: events = [], isLoading } = useQuery<ClockEvent[]>({
    queryKey: ['clock-events-staff', dateFrom, dateTo, selectedStaff],
    queryFn: () => fetchClockEvents(new Date(dateFrom).toISOString(), new Date(dateTo + 'T23:59:59').toISOString()),
    enabled: !!selectedStaff,
  })

  const filtered = events.filter(e => e.staff_id === selectedStaff)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  // Group by day
  const byDay: Record<string, ClockEvent[]> = {}
  for (const e of filtered) {
    const day = e.created_at.slice(0, 10)
    if (!byDay[day]) byDay[day] = []
    byDay[day].push(e)
  }

  function dayWorkedMs(dayEvents: ClockEvent[]) {
    let total = 0; let lastIn: number | null = null
    for (const e of dayEvents) {
      if (e.event_type === 'clock_in') lastIn = new Date(e.created_at).getTime()
      else if (e.event_type === 'clock_out' && lastIn !== null) { total += new Date(e.created_at).getTime() - lastIn; lastIn = null }
    }
    return total
  }

  const totalMs = Object.values(byDay).reduce((s, es) => s + dayWorkedMs(es), 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs text-gray-500 mb-1 block">{isRu ? 'Сотрудник' : 'עובד'}</label>
          <select value={selectedStaff} onChange={e => setSelectedStaff(e.target.value)} className="input text-sm">
            <option value="">{isRu ? '— выберите —' : '— בחר —'}</option>
            {allStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">{isRu ? 'С' : 'מ'}</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">{isRu ? 'По' : 'עד'}</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input text-sm" />
        </div>
      </div>

      {!selectedStaff
        ? <div className="card p-8 text-center text-gray-400 text-sm">{isRu ? 'Выберите сотрудника' : 'בחר עובד'}</div>
        : isLoading
        ? <div className="card p-8 text-center text-gray-400 text-sm animate-pulse">...</div>
        : Object.keys(byDay).length === 0
        ? <div className="card p-8 text-center text-gray-400 text-sm">{isRu ? 'Нет данных за период' : 'אין נתונים לתקופה'}</div>
        : (
          <>
            <div className="card overflow-hidden">
              <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 grid grid-cols-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <span>{isRu ? 'Дата' : 'תאריך'}</span>
                <span>{isRu ? 'Время' : 'שעות'}</span>
                <span className="text-right">{isRu ? 'Итого' : 'סה"כ'}</span>
              </div>
              {Object.entries(byDay).map(([day, es]) => (
                <div key={day} className="px-4 py-3 border-b border-gray-50 last:border-0 grid grid-cols-3 items-center">
                  <span className="text-sm text-gray-800">{day}</span>
                  <span className="text-xs text-gray-500">
                    {es.filter(e => e.event_type === 'clock_in').map(e => fmtTime(e.created_at)).join(', ')}
                    {' → '}
                    {es.filter(e => e.event_type === 'clock_out').map(e => fmtTime(e.created_at)).join(', ') || '?'}
                  </span>
                  <span className="text-sm font-bold text-gray-900 text-right">{formatDuration(dayWorkedMs(es))}</span>
                </div>
              ))}
            </div>
            <div className="card p-4 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-700">{isRu ? 'Итого за период:' : 'סה"כ לתקופה:'}</span>
              <span className="text-2xl font-black text-gray-900">{formatDuration(totalMs)}</span>
            </div>
          </>
        )
      }
    </div>
  )
}

function DiscountsReport({ isRu }: { isRu: boolean }) {
  const [dateFrom, setDateFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const { data: rows = [], isLoading } = useQuery<DiscountRow[]>({
    queryKey: ['discount-report', dateFrom, dateTo],
    queryFn: () => fetchDiscountReport(new Date(dateFrom).toISOString(), new Date(dateTo + 'T23:59:59').toISOString()),
  })

  const totalDiscount = rows.reduce((s, r) => s + r.discountAmount, 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3 flex-wrap items-end">
        <div>
          <label className="text-xs text-gray-500 mb-1 block">{isRu ? 'С' : 'מ'}</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">{isRu ? 'По' : 'עד'}</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input text-sm" />
        </div>
      </div>

      {isLoading ? <div className="card p-8 text-center text-gray-400 animate-pulse text-sm">...</div>
        : rows.length === 0
        ? <div className="card p-8 text-center text-gray-400 text-sm">{isRu ? 'Скидок нет за период' : 'אין הנחות לתקופה'}</div>
        : (
          <>
            <div className="card overflow-hidden">
              <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 grid grid-cols-5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <span>{isRu ? 'Блюдо' : 'מנה'}</span>
                <span>{isRu ? 'Стол' : 'שולחן'}</span>
                <span>{isRu ? 'Официант' : 'מלצר'}</span>
                <span className="text-right">{isRu ? 'Было' : 'מחיר'}</span>
                <span className="text-right">{isRu ? 'Скидка' : 'הנחה'}</span>
              </div>
              {rows.map((r, i) => (
                <div key={i} className="px-4 py-2.5 border-b border-gray-50 last:border-0 grid grid-cols-5 items-center">
                  <span className="text-sm text-gray-800 truncate">{r.qty > 1 ? `${r.qty}× ` : ''}{r.itemName}</span>
                  <span className="text-sm text-gray-500">{r.tableNumber ?? '—'}</span>
                  <span className="text-xs text-gray-400 truncate">{r.waiterName}</span>
                  <span className="text-sm tabular-nums text-gray-600 text-right">{fmt(r.originalPrice)} ₪</span>
                  <span className="text-sm font-bold tabular-nums text-red-500 text-right">-{fmt(r.discountAmount)} ₪</span>
                </div>
              ))}
            </div>
            <div className="card p-4 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-700">{isRu ? 'Итого скидок:' : 'סה"כ הנחות:'}</span>
              <span className="text-2xl font-black text-red-500">-{fmt(totalDiscount)} ₪</span>
            </div>
          </>
        )
      }
    </div>
  )
}

function ZHistoryReport({ isRu, activeShift, onClose: _onClose }: { isRu: boolean; activeShift: any; onClose: () => void }) {
  const qc = useQueryClient()

  const [confirm, setConfirm] = useState(false)
  const [zResult, setZResult] = useState<(ReportData & { closedAt?: string }) | null>(null)
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null)
  const [historyZ, setHistoryZ] = useState<(ReportData & { closedAt?: string }) | null>(null)

  const { data: lastShifts = [] } = useQuery({ queryKey: ['last-shifts'], queryFn: () => fetchLastShifts(20) })

  const closeShiftMutation = useMutation({
    mutationFn: async () => {
      if (!activeShift) throw new Error('Нет активной смены')
      const report = await fetchXReport()
      await closeShift(activeShift.id, report.totalRevenue)
      return fetchZReport(activeShift.id)
    },
    onSuccess: (data) => {
      setZResult(data)
      setConfirm(false)
      qc.invalidateQueries({ queryKey: ['active-shift'] })
      qc.invalidateQueries({ queryKey: ['last-shifts'] })
      toast.success(isRu ? 'Смена закрыта' : 'המשמרת נסגרה')
    },
    onError: (e: Error) => { toast.error(e.message); setConfirm(false) },
  })

  const loadHistoryZ = useMutation({
    mutationFn: (shiftId: string) => fetchZReport(shiftId),
    onSuccess: (data) => setHistoryZ(data),
    onError: (e: Error) => toast.error(e.message),
  })

  if (zResult) return (
    <div className="flex flex-col gap-4">
      <div className="card p-4 border-emerald-200 bg-emerald-50 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <p className="text-sm font-medium text-emerald-800">{isRu ? 'Смена успешно закрыта' : 'המשמרת נסגרה בהצלחה'}</p>
      </div>
      <ReportTable data={zResult} type="Z" />
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      {activeShift && !confirm && (
        <button
          onClick={() => setConfirm(true)}
          className="btn-danger w-full py-5 text-base font-bold flex items-center justify-center gap-2 rounded-2xl"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
          {isRu ? 'Снять Z-отчёт и закрыть смену' : 'סגור משמרת — דוח Z'}
        </button>
      )}
      {activeShift && confirm && (
        <div className="card p-5 flex flex-col gap-3">
          <p className="font-bold text-gray-900">{isRu ? 'Закрыть смену?' : 'לסגור את המשמרת?'}</p>
          <p className="text-sm text-gray-500">
            {isRu ? 'Действие необратимо. Счётчики обнулятся, Z-отчёт будет сформирован.' : 'פעולה זו בלתי הפיכה. המונים יאופסו ודוח Z ייוצר.'}
          </p>
          <div className="flex gap-2">
            <button onClick={() => closeShiftMutation.mutate()} disabled={closeShiftMutation.isPending} className="btn-danger flex-1 py-3 font-bold">
              {closeShiftMutation.isPending ? '...' : (isRu ? 'Да, закрыть' : 'כן, סגור')}
            </button>
            <button onClick={() => setConfirm(false)} className="btn-secondary flex-1 py-3">{isRu ? 'Отмена' : 'ביטול'}</button>
          </div>
        </div>
      )}
      {!activeShift && (
        <div className="card p-4 bg-gray-50 text-sm text-gray-500 text-center rounded-2xl">
          {isRu ? 'Нет активной смены' : 'אין משמרת פתוחה'}
        </div>
      )}

      {lastShifts.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
            {isRu ? 'История смен' : 'משמרות קודמות'}
          </p>
          <div className="card p-0 overflow-hidden">
            {lastShifts.map((shift: any, i: number) => (
              <div key={shift.id}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">{fmtDate(shift.opened_at)} — {fmtDate(shift.closed_at)}</p>
                    <p className="text-xs text-gray-400">{shift.staff?.name}</p>
                  </div>
                  <span className="text-sm font-bold tabular-nums text-gray-900">{fmt(shift.total_revenue)} ₪</span>
                  <button
                    onClick={() => { setSelectedShiftId(shift.id); loadHistoryZ.mutate(shift.id) }}
                    className="btn-ghost text-xs py-1.5 px-3 shrink-0 font-bold"
                  >
                    {loadHistoryZ.isPending && selectedShiftId === shift.id ? '...' : 'Z'}
                  </button>
                </div>
                {i < lastShifts.length - 1 && <div className="border-b border-gray-50" />}
              </div>
            ))}
          </div>
        </div>
      )}
      {historyZ && <ReportTable data={historyZ} type="Z" />}
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const navigate = useNavigate()

  const lang = useLangStore((s) => s.lang)
  // const _staff = useAuthStore((s) => s.currentStaff)
  const logout = useAuthStore((s) => s.logout)
  const isRu = lang === 'ru'
  const isRtl = lang === 'he'
  const [view, setView] = useState<View>('menu')

  const { data: activeShift } = useQuery({ queryKey: ['active-shift'], queryFn: fetchActiveShift })
  const { data: xReport } = useQuery({
    queryKey: ['x-report'],
    queryFn: fetchXReport,
    refetchInterval: 60_000,
    enabled: view === 'x',
  })

  const currentTile = TILES.find(t => t.key === view)
  const title = view === 'menu'
    ? (isRu ? 'Отчёты' : 'דוחות')
    : currentTile
    ? (isRu ? currentTile.ru : currentTile.he)
    : ''

  return (
    <div className="min-h-screen bg-[#f8f9fb] flex flex-col" dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="bg-white border-b border-gray-100 h-14 px-5 flex items-center gap-3 shrink-0">
        {view !== 'menu' ? (
          <button
            onClick={() => setView('menu')}
            className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-500 transition-colors"
          >
            {isRtl ? '→' : '←'}
          </button>
        ) : (
          <HubButton />
        )}
        <h1 className="font-semibold text-gray-900 text-sm flex-1">{title}</h1>
        <LangToggle />
        <button onClick={() => { logout(); navigate('/') }} className="btn-ghost text-xs py-1.5 px-3 text-gray-500">
          {t(lang, 'logout')}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-5 max-w-2xl w-full mx-auto">

        {/* Tile grid */}
        {view === 'menu' && (
          <div className="flex flex-col gap-3 mt-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest text-center mb-1">
              {isRu ? 'Выберите отчёт' : 'בחר דוח'}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {TILES.map(tile => (
                <button
                  key={tile.key}
                  onClick={() => setView(tile.key)}
                  className={`card-hover flex flex-col items-center justify-center gap-3 rounded-2xl py-8 px-4 transition-all duration-150 active:scale-[0.97] ${
                    tile.key === 'z' || tile.key === 'z-history' ? 'bg-gray-900 border-gray-900' : ''
                  }`}
                >
                  <span className={`text-4xl font-black leading-none ${
                    tile.key === 'z' || tile.key === 'z-history' ? 'text-white/20' : 'text-gray-200'
                  }`}>{tile.icon}</span>
                  <div className="text-center">
                    <p className={`font-bold text-sm ${tile.key === 'z' || tile.key === 'z-history' ? 'text-white' : 'text-gray-900'}`}>
                      {isRu ? tile.ru : tile.he}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-2">
          {view === 'x' && (
            xReport
              ? <ReportTable data={xReport} type="X" />
              : <div className="card p-8 text-center text-gray-400 text-sm">{isRu ? 'Нет данных за текущую смену' : 'אין נתונים לתקופה זו'}</div>
          )}
          {view === 'z' && <ZHistoryReport isRu={isRu} activeShift={activeShift} onClose={() => setView('menu')} />}
          {view === 'z-history' && <ZHistoryReport isRu={isRu} activeShift={activeShift} onClose={() => setView('menu')} />}
          {view === 'attendance' && <AttendanceReport isRu={isRu} />}
          {view === 'staff-hours' && <StaffHoursReport isRu={isRu} />}
          {view === 'discounts' && <DiscountsReport isRu={isRu} />}
        </div>

      </div>
    </div>
  )
}
