import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchSalesReport, type SalesReport } from '../reports/api'
import { fetchCurrentShift } from '../shift/api'
import { fetchCurrentLocation } from '../auth/api'
import BackButton from '../../components/BackButton'
import Icon from '../../components/Icon'
import { useLangStore } from '../../store/langStore'
import { t, formatTime, type TranslationKey } from '../../lib/i18n'
import { payMethodIcon, payMethodLabel } from '../../lib/payMethods'
import { formatMoney } from '../../lib/money'

/**
 * Дашборд владельца: выручка с телефона, не отходя от дивана.
 * Mobile-first (портрет), но нормально живёт и на кассе. Данные —
 * sales_report (049: сервер требует manager-сессию), автообновление
 * раз в минуту. Один график (одна серия, gray-900), значения по тапу —
 * hover на телефоне нет; идентичность способов/товаров — строками.
 */

type Period = 'today' | 'yesterday' | '7d'

const PERIODS: { key: Period; label: TranslationKey }[] = [
  { key: 'today', label: 'today' },
  { key: 'yesterday', label: 'periodYesterday' },
  { key: '7d', label: 'period7d' },
]

function startOfDay(offsetDays = 0): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays)
  return d
}

function periodRange(p: Period): { from: Date; to: Date } {
  if (p === 'today') return { from: startOfDay(0), to: startOfDay(1) }
  if (p === 'yesterday') return { from: startOfDay(-1), to: startOfDay(0) }
  return { from: startOfDay(-6), to: startOfDay(1) } // 7 дней включая сегодня
}

interface Bar {
  key: string
  /** Подпись на оси (короткая) */
  label: string
  /** Подпись в ридауте при тапе (полная) */
  full: string
  amount: number
  count: number
}

/** Часы min..max с заполнением пропусков нулями (ось непрерывна) */
function hourBars(r: SalesReport): Bar[] {
  if (r.by_hour.length === 0) return []
  const byHour = new Map(r.by_hour.map((h) => [h.hour, h]))
  const min = Math.min(...r.by_hour.map((h) => h.hour))
  const max = Math.max(...r.by_hour.map((h) => h.hour))
  const bars: Bar[] = []
  for (let h = min; h <= max; h++) {
    const row = byHour.get(h)
    bars.push({
      key: String(h),
      label: `${h}`,
      full: `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`,
      amount: row?.amount ?? 0,
      count: row?.count ?? 0,
    })
  }
  return bars
}

function dayBars(r: SalesReport, lang: 'ru' | 'he'): Bar[] {
  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  return r.by_day.map((d) => {
    const date = new Date(`${d.day}T00:00:00`)
    return {
      key: d.day,
      label: date.toLocaleDateString(locale, { weekday: 'short' }),
      full: date.toLocaleDateString(locale, { day: 'numeric', month: 'long', weekday: 'long' }),
      amount: d.amount,
      count: d.count,
    }
  })
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'

  const [period, setPeriod] = useState<Period>('today')
  const { from, to } = useMemo(() => periodRange(period), [period])

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const { data: shift } = useQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
  const { data: report, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['dashboard_sales', period, from.toDateString()],
    queryFn: () => fetchSalesReport(from, to),
    // Сегодня — живой экран: тихое обновление раз в минуту
    refetchInterval: period === 'today' ? 60_000 : false,
  })
  // Ориентир «вчера за день» под hero-числом (только на вкладке «Сегодня»)
  const { data: refReport } = useQuery({
    queryKey: ['dashboard_sales', 'ref_yesterday', startOfDay(-1).toDateString()],
    queryFn: () => fetchSalesReport(startOfDay(-1), startOfDay(0)),
    enabled: period === 'today',
    staleTime: 10 * 60_000,
  })

  const s = report?.summary
  const net = s ? s.gross_sales - s.refunds : 0
  const refNet = refReport ? refReport.summary.gross_sales - refReport.summary.refunds : null

  const bars = useMemo<Bar[]>(() => {
    if (!report) return []
    return period === '7d' ? dayBars(report, lang) : hourBars(report)
  }, [report, period, lang])
  const maxAmount = bars.reduce((m, b) => Math.max(m, b.amount), 0)
  const maxIdx = bars.findIndex((b) => b.amount === maxAmount)
  // Тап по столбику — ридаут над графиком (замена hover-тултипу на таче)
  const [picked, setPicked] = useState<number | null>(null)
  const readout = picked !== null && bars[picked] ? bars[picked] : maxIdx >= 0 ? bars[maxIdx] : null

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#eceef1]">
      <div className="max-w-md mx-auto p-4 pb-10 space-y-3">

        {/* Шапка */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <BackButton onClick={() => navigate(-1)} />
          <div className="text-end min-w-0">
            <h1 className="text-lg font-black text-gray-900 leading-tight">{t(lang, 'dashboard')}</h1>
            <p className="text-xs text-gray-500 truncate">{location?.receipt_business_name || location?.name || ''}</p>
          </div>
        </div>

        {/* Период */}
        <div className="grid grid-cols-3 gap-1 p-1 bg-gray-200/70 rounded-2xl">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => { setPeriod(p.key); setPicked(null) }}
              className={`h-11 rounded-xl text-sm font-bold transition-colors ${
                period === p.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              {t(lang, p.label)}
            </button>
          ))}
        </div>

        {/* Hero: чистая выручка */}
        <div className="card p-6">
          <div className="text-sm text-gray-500">{t(lang, 'netSales')}</div>
          <div className="text-4xl font-black text-gray-900 tabular-nums mt-1">
            {isLoading && !report ? '…' : formatMoney(net, lang)}
          </div>
          {period === 'today' && refNet !== null && (
            <div className="text-xs text-gray-500 mt-2 tabular-nums">
              {t(lang, 'dbVsYesterday')}: {formatMoney(refNet, lang)}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 mt-5 pt-4 border-t border-gray-100">
            <div>
              <div className="text-xs text-gray-500">{t(lang, 'ordersCount')}</div>
              <div className="text-xl font-black text-gray-900 tabular-nums">{s?.orders_count ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">{t(lang, 'avgCheck')}</div>
              <div className="text-xl font-black text-gray-900 tabular-nums">
                {s ? formatMoney(s.avg_check, lang) : '—'}
              </div>
            </div>
          </div>
          {s && (s.refunds > 0 || s.discounts > 0) && (
            <div className="space-y-1 mt-4 pt-3 border-t border-gray-100 text-sm">
              {s.discounts > 0 && (
                <div className="flex justify-between text-gray-500">
                  <span>{t(lang, 'discountsLabel')}</span>
                  <span className="tabular-nums">−{formatMoney(s.discounts, lang)}</span>
                </div>
              )}
              {s.refunds > 0 && (
                <div className="flex justify-between text-gray-500">
                  <span>{t(lang, 'refundsLabel')} ×{s.refunds_count}</span>
                  <span className="tabular-nums text-red-500">−{formatMoney(s.refunds, lang)}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Смена */}
        <div className="card px-5 py-4 flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${shift ? 'bg-emerald-500' : 'bg-gray-300'}`} />
          <span className="text-sm font-semibold text-gray-900">
            {shift
              ? `${t(lang, 'dbShiftOpenSince')} ${formatTime(shift.opened_at, lang)}`
              : t(lang, 'dbShiftClosed')}
          </span>
        </div>

        {/* График: часы (день) / дни (неделя). Одна серия — без легенды. */}
        <div className="card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-bold text-gray-900">
              {t(lang, period === '7d' ? 'dbByDay' : 'dbByHour')}
            </h2>
            {/* Ридаут выбранного столбика (по умолчанию — пиковый) */}
            {readout && (
              <span className="text-xs text-gray-500 tabular-nums">
                {readout.full} · <span className="font-bold text-gray-900">{formatMoney(readout.amount, lang)}</span>
                {readout.count > 0 && ` · ×${readout.count}`}
              </span>
            )}
          </div>
          {bars.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">{t(lang, 'dbNoSales')}</p>
          ) : (
            // Ось времени всегда LTR — даже в иврит-интерфейсе часы/дни идут слева направо
            <div dir="ltr">
              <div className="flex items-end gap-[2px] h-32" role="img" aria-label={t(lang, period === '7d' ? 'dbByDay' : 'dbByHour')}>
                {bars.map((b, i) => {
                  const hPct = maxAmount > 0 ? Math.max((b.amount / maxAmount) * 100, b.amount > 0 ? 3 : 0) : 0
                  const active = picked === null ? i === maxIdx : picked === i
                  return (
                    <button
                      key={b.key}
                      onClick={() => setPicked(picked === i ? null : i)}
                      aria-label={`${b.full}: ${formatMoney(b.amount, lang)}`}
                      className="flex-1 h-full flex items-end min-w-0"
                    >
                      <span
                        className={`w-full rounded-t-[4px] transition-colors ${active ? 'bg-gray-900' : 'bg-gray-300'}`}
                        style={{ height: `${hPct}%` }}
                      />
                    </button>
                  )
                })}
              </div>
              <div className="flex gap-[2px] mt-1">
                {bars.map((b, i) => (
                  <span
                    key={b.key}
                    className={`flex-1 text-center text-[10px] tabular-nums truncate ${
                      (picked === null ? i === maxIdx : picked === i) ? 'text-gray-900 font-bold' : 'text-gray-400'
                    }`}
                  >
                    {bars.length > 14 ? (i % 3 === 0 ? b.label : '') : b.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Способы оплаты (нетто) */}
        {report && report.by_method.length > 0 && (
          <div className="card p-5">
            <h2 className="text-sm font-bold text-gray-900 mb-3">{t(lang, 'paymentMethods')}</h2>
            <div className="space-y-2.5 text-sm">
              {report.by_method.map((m) => (
                <div key={m.method} className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-gray-600">
                    <Icon name={payMethodIcon(m.method)} size={16} />
                    {payMethodLabel(lang, m.method)}
                    {m.count > 0 && <span className="text-gray-400 text-xs">×{m.count}</span>}
                  </span>
                  <span className="tabular-nums font-semibold text-gray-900">{formatMoney(m.amount, lang)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Топ товаров */}
        {report && report.top_items.length > 0 && (
          <div className="card p-5">
            <h2 className="text-sm font-bold text-gray-900 mb-3">{t(lang, 'topItems')}</h2>
            <div className="space-y-2.5 text-sm">
              {report.top_items.slice(0, 5).map((i) => (
                <div key={i.name} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-gray-600">
                    {i.name} <span className="text-gray-400 text-xs">×{i.qty}</span>
                  </span>
                  <span className="tabular-nums font-semibold text-gray-900 shrink-0">{formatMoney(i.amount, lang)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {dataUpdatedAt > 0 && (
          <p className="text-center text-[11px] text-gray-400 tabular-nums">
            {formatTime(new Date(dataUpdatedAt).toISOString(), lang)}
          </p>
        )}
      </div>
    </div>
  )
}
