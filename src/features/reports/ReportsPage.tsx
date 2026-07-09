import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchSalesReport } from './api'
import AppSidebar from '../../components/AppSidebar'
import Icon from '../../components/Icon'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t, type TranslationKey } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'year' | 'custom'

const PRESETS: { key: Preset; label: TranslationKey }[] = [
  { key: 'today', label: 'today' },
  { key: 'yesterday', label: 'periodYesterday' },
  { key: '7d', label: 'period7d' },
  { key: '30d', label: 'period30d' },
  { key: 'year', label: 'periodYear' },
  { key: 'custom', label: 'periodCustom' },
]

interface Bar {
  key: string
  label: string
  tick: boolean // подписывать ли на оси
  amount: number
  count: number
}

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

/**
 * Отчёт «Продажи» (Square: Sales summary): период → KPI, график
 * по часам/дням, способы оплаты, топ товаров, категории, сотрудники.
 * Агрегирует сервер (sales_report), клиент только рисует.
 */
export default function ReportsPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  const staff = useAuthStore((s) => s.staff)

  const [preset, setPreset] = useState<Preset>('today')
  const [customFrom, setCustomFrom] = useState(() => toDateInput(startOfToday()))
  const [customTo, setCustomTo] = useState(() => toDateInput(startOfToday()))
  const [selectedBar, setSelectedBar] = useState<string | null>(null)

  const [from, to] = useMemo<[Date, Date]>(() => {
    const t0 = startOfToday()
    switch (preset) {
      case 'today': return [t0, addDays(t0, 1)]
      case 'yesterday': return [addDays(t0, -1), t0]
      case '7d': return [addDays(t0, -6), addDays(t0, 1)]
      case '30d': return [addDays(t0, -29), addDays(t0, 1)]
      case 'year': return [new Date(t0.getFullYear(), 0, 1), addDays(t0, 1)]
      case 'custom': {
        let f = parseDateInput(customFrom)
        let tt = parseDateInput(customTo)
        if (tt < f) [f, tt] = [tt, f] // перепутанный диапазон — молча чиним
        return [f, addDays(tt, 1)]
      }
    }
  }, [preset, customFrom, customTo])

  const { data: report, isLoading, error } = useQuery({
    queryKey: ['sales_report', from.toISOString(), to.toISOString()],
    queryFn: () => fetchSalesReport(from, to),
  })

  const dayCount = Math.round((to.getTime() - from.getTime()) / 86400000)
  // День → часы, до ~2 месяцев → дни, дольше → месяцы (365 баров нечитаемы)
  const granularity: 'hour' | 'day' | 'month' =
    dayCount <= 1 ? 'hour' : dayCount > 62 ? 'month' : 'day'

  // Бары графика с заполнением нулями по всему диапазону
  const bars = useMemo<Bar[]>(() => {
    if (!report) return []
    if (granularity === 'hour') {
      const byHour = new Map(report.by_hour.map((h) => [h.hour, h]))
      const hours = report.by_hour.map((h) => h.hour)
      const first = Math.min(8, ...(hours.length ? hours : [8]))
      const last = Math.max(20, ...(hours.length ? hours : [20]))
      const out: Bar[] = []
      for (let h = first; h <= last; h++) {
        out.push({
          key: `h${h}`,
          label: `${h}:00`,
          tick: h % 3 === 0,
          amount: byHour.get(h)?.amount ?? 0,
          count: byHour.get(h)?.count ?? 0,
        })
      }
      return out
    }
    if (granularity === 'month') {
      // Сервер отдаёт дни — месяцы складываем на клиенте
      const sums = new Map<string, { amount: number; count: number }>()
      for (const d of report.by_day) {
        const k = d.day.slice(0, 7) // YYYY-MM
        const cur = sums.get(k) ?? { amount: 0, count: 0 }
        cur.amount += d.amount
        cur.count += d.count
        sums.set(k, cur)
      }
      const multiYear = from.getFullYear() !== addDays(to, -1).getFullYear()
      const out: Bar[] = []
      const cursor = new Date(from.getFullYear(), from.getMonth(), 1)
      while (cursor < to) {
        const k = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`
        out.push({
          key: k,
          label: cursor.toLocaleDateString(locale, multiYear ? { month: 'short', year: '2-digit' } : { month: 'short' }),
          tick: true,
          amount: sums.get(k)?.amount ?? 0,
          count: sums.get(k)?.count ?? 0,
        })
        cursor.setMonth(cursor.getMonth() + 1)
      }
      return out
    }
    const byDay = new Map(report.by_day.map((d) => [d.day, d]))
    const step = Math.max(1, Math.ceil(dayCount / 10)) // не чаще ~10 подписей
    const out: Bar[] = []
    for (let i = 0; i < dayCount; i++) {
      const d = addDays(from, i)
      const key = toDateInput(d)
      out.push({
        key,
        label: d.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
        tick: i % step === 0,
        amount: byDay.get(key)?.amount ?? 0,
        count: byDay.get(key)?.count ?? 0,
      })
    }
    return out
  }, [report, granularity, dayCount, from, to, locale])

  if (!staff) return null

  const s = report?.summary
  const net = s ? s.gross_sales - s.refunds : 0
  const empty = !!s && s.orders_count === 0 && s.refunds === 0
  const maxBar = Math.max(1, ...bars.map((b) => b.amount))
  const peakKey = bars.reduce((p, b) => (b.amount > (bars.find((x) => x.key === p)?.amount ?? 0) ? b.key : p), bars[0]?.key ?? '')
  const labeledKey = selectedBar && bars.some((b) => b.key === selectedBar) ? selectedBar : peakKey
  const selected = bars.find((b) => b.key === labeledKey)

  const maxItem = Math.max(1, ...(report?.top_items.map((i) => i.amount) ?? []))
  const maxCat = Math.max(1, ...(report?.by_category.map((c) => c.amount) ?? []))

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="analytics" />

      <main className="flex-1 bg-white rounded-3xl overflow-y-auto">
        <div className="max-w-5xl mx-auto p-6">
          {/* Заголовок + период */}
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <h1 className="text-2xl font-black text-gray-900 me-auto">{t(lang, 'reports')}</h1>
            <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => { setPreset(p.key); setSelectedBar(null) }}
                  className={`px-4 h-9 rounded-lg text-sm font-semibold transition-colors ${
                    preset === p.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t(lang, p.label)}
                </button>
              ))}
            </div>
          </div>

          {preset === 'custom' && (
            <div className="flex items-center gap-2 mb-6">
              <input type="date" className="input !w-auto !py-2" value={customFrom} max={toDateInput(startOfToday())}
                onChange={(e) => { setCustomFrom(e.target.value); setSelectedBar(null) }} />
              <span className="text-gray-400">—</span>
              <input type="date" className="input !w-auto !py-2" value={customTo} max={toDateInput(startOfToday())}
                onChange={(e) => { setCustomTo(e.target.value); setSelectedBar(null) }} />
            </div>
          )}

          {isLoading ? (
            <p className="text-center text-gray-400 pt-24">…</p>
          ) : error ? (
            <p className="text-center text-red-500 text-sm pt-24">{(error as Error).message}</p>
          ) : !report || !s ? null : (
            <>
              {/* KPI */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                <Kpi label={t(lang, 'netSales')} value={formatMoney(net, lang)} />
                <Kpi label={t(lang, 'ordersCountLabel')} value={String(s.orders_count)} />
                <Kpi label={t(lang, 'avgCheck')} value={formatMoney(s.avg_check, lang)} />
                <Kpi
                  label={t(lang, 'refundsLabel')}
                  value={s.refunds > 0 ? `−${formatMoney(s.refunds, lang)}` : formatMoney(0, lang)}
                  accent={s.refunds > 0 ? 'text-red-500' : undefined}
                  sub={s.refunds_count > 0 ? `${s.refunds_count}` : undefined}
                />
              </div>

              {empty ? (
                <p className="text-center text-gray-500 text-sm pt-16">{t(lang, 'noSalesPeriod')}</p>
              ) : (
                <>
                  {/* График: часы или дни. Ось времени всегда LTR */}
                  <div className="rounded-2xl border border-gray-100 p-4 mb-3">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-sm font-bold text-gray-900">
                        {t(lang, granularity === 'hour' ? 'salesByHour' : granularity === 'month' ? 'salesByMonth' : 'salesByDay')}
                      </h2>
                      {selected && selected.amount > 0 && (
                        <div className="text-xs text-gray-500 tabular-nums" dir="ltr">
                          {selected.label} · <span className="font-bold text-gray-900">{formatMoney(selected.amount, lang)}</span> · {selected.count}
                        </div>
                      )}
                    </div>
                    <div dir="ltr">
                      <div className="flex items-end gap-0.5 h-40">
                        {bars.map((b) => (
                          <button
                            key={b.key}
                            onClick={() => setSelectedBar(b.key)}
                            className="flex-1 h-full flex flex-col justify-end items-center min-w-0"
                            aria-label={`${b.label}: ${formatMoney(b.amount, lang)}`}
                          >
                            {b.key === labeledKey && b.amount > 0 && (
                              <span className="text-[10px] font-bold text-gray-700 tabular-nums whitespace-nowrap mb-1">
                                {formatMoney(b.amount, lang)}
                              </span>
                            )}
                            {b.amount > 0 ? (
                              <div
                                className={`w-full max-w-[28px] rounded-t ${b.key === labeledKey ? 'bg-gray-900' : 'bg-gray-700'}`}
                                style={{ height: `${Math.max((b.amount / maxBar) * 100, 3)}%` }}
                              />
                            ) : (
                              <div className="w-full max-w-[28px] h-0.5 rounded bg-gray-100" />
                            )}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-0.5 border-t border-gray-100 pt-1.5 mt-0.5">
                        {bars.map((b) => (
                          <div key={b.key} className="flex-1 text-center text-[10px] text-gray-400 tabular-nums whitespace-nowrap min-w-0">
                            {b.tick ? b.label : ''}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {/* Сводка + способы оплаты */}
                    <section className="rounded-2xl border border-gray-100 p-4">
                      <h2 className="text-sm font-bold text-gray-900 mb-3">{t(lang, 'paymentMethods')}</h2>
                      <div className="space-y-2 text-sm mb-4">
                        {report.by_method.map((m) => (
                          <div key={m.method} className="flex items-center justify-between">
                            <span className="flex items-center gap-2 text-gray-600">
                              <Icon name={m.method === 'cash' ? 'cash' : 'card'} size={16} />
                              {t(lang, m.method === 'cash' ? 'payCash' : 'payCard')}
                              <span className="text-gray-400 text-xs">×{m.count}</span>
                            </span>
                            <span className="tabular-nums font-semibold text-gray-900">{formatMoney(m.amount, lang)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="space-y-2 text-sm border-t border-gray-100 pt-3">
                        <Row label={t(lang, 'grossSales')} value={formatMoney(s.gross_sales, lang)} />
                        {s.discounts > 0 && <Row label={t(lang, 'discountsLabel')} value={`−${formatMoney(s.discounts, lang)}`} muted />}
                        {s.refunds > 0 && <Row label={t(lang, 'refundsLabel')} value={`−${formatMoney(s.refunds, lang)}`} accent="text-red-500" />}
                        <Row label={t(lang, 'netSales')} value={formatMoney(net, lang)} bold />
                        <Row label={t(lang, 'vatIncl')} value={formatMoney(s.vat, lang)} muted />
                      </div>
                    </section>

                    {/* Топ товаров */}
                    <section className="rounded-2xl border border-gray-100 p-4">
                      <h2 className="text-sm font-bold text-gray-900 mb-3">{t(lang, 'topItems')}</h2>
                      <div className="space-y-3">
                        {report.top_items.map((item) => (
                          <ShareRow
                            key={item.name}
                            name={item.name}
                            meta={`${item.qty} ${t(lang, 'qtyShort')}`}
                            amount={formatMoney(item.amount, lang)}
                            share={item.amount / maxItem}
                          />
                        ))}
                      </div>
                    </section>

                    {/* Категории */}
                    <section className="rounded-2xl border border-gray-100 p-4">
                      <h2 className="text-sm font-bold text-gray-900 mb-3">{t(lang, 'byCategory')}</h2>
                      <div className="space-y-3">
                        {report.by_category.map((c) => (
                          <ShareRow
                            key={c.category}
                            name={c.category}
                            meta={`${c.qty} ${t(lang, 'qtyShort')}`}
                            amount={formatMoney(c.amount, lang)}
                            share={c.amount / maxCat}
                          />
                        ))}
                      </div>
                    </section>

                    {/* Сотрудники */}
                    <section className="rounded-2xl border border-gray-100 p-4">
                      <h2 className="text-sm font-bold text-gray-900 mb-3">{t(lang, 'byStaff')}</h2>
                      <div className="space-y-2 text-sm">
                        {report.by_staff.map((st) => (
                          <div key={st.name} className="flex items-center justify-between">
                            <span className="text-gray-700 min-w-0 truncate">
                              {st.name}
                              <span className="text-gray-400 text-xs ms-2">×{st.count}</span>
                            </span>
                            <span className="tabular-nums font-semibold text-gray-900 shrink-0 ms-3">
                              {formatMoney(st.amount, lang)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-2xl border border-gray-100 p-4">
      <div className="text-xs font-semibold text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-black tabular-nums ${accent ?? 'text-gray-900'}`}>
        {value}
        {sub && <span className="text-sm font-semibold text-gray-400 ms-2">×{sub}</span>}
      </div>
    </div>
  )
}

function Row({ label, value, bold, muted, accent }: {
  label: string; value: string; bold?: boolean; muted?: boolean; accent?: string
}) {
  return (
    <div className="flex justify-between">
      <span className={muted ? 'text-gray-500' : bold ? 'font-bold text-gray-900' : 'text-gray-600'}>{label}</span>
      <span className={`tabular-nums ${accent ?? (muted ? 'text-gray-500' : bold ? 'font-bold text-gray-900' : 'font-semibold text-gray-900')}`}>
        {value}
      </span>
    </div>
  )
}

/** Строка с долей: имя + количество + сумма и тонкая полоса-доля под ней */
function ShareRow({ name, meta, amount, share }: { name: string; meta: string; amount: string; share: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm mb-1">
        <span className="text-gray-700 min-w-0 truncate">
          {name}
          <span className="text-gray-400 text-xs ms-2">{meta}</span>
        </span>
        <span className="tabular-nums font-semibold text-gray-900 shrink-0 ms-3">{amount}</span>
      </div>
      <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full bg-gray-900" style={{ width: `${Math.max(share * 100, 2)}%` }} />
      </div>
    </div>
  )
}
