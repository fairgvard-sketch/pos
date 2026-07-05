import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchTodayStats, fetchOrderHistory, fetchItemSalesByPeriod, fetchStatsByPeriod } from './api'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t, formatDate } from '../../lib/i18n'
import LangToggle from '../../components/ui/LangToggle'

type Tab = 'dashboard' | 'history'

export default function ManagerPage() {
  const navigate = useNavigate()
  const staff = useAuthStore((s) => s.currentStaff)
  const logout = useAuthStore((s) => s.logout)
  const lang = useLangStore((s) => s.lang)
  const [tab, setTab] = useState<Tab>('dashboard')

  const isRtl = lang === 'he'

  return (
    <div className="min-h-screen bg-gray-50" dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/hub')}
            className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-500 hover:text-gray-900 transition-colors"
            title="Главный экран"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
            </svg>
          </button>
          <span className="font-bold text-gray-900">{t(lang, 'management')}</span>
        </div>
        <div className="flex items-center gap-3">
          <LangToggle />
          <span className="text-sm text-gray-600">{staff?.name}</span>
          <button onClick={logout} className="text-sm text-gray-400 hover:text-red-500">
            {t(lang, 'logout')}
          </button>
        </div>
      </header>

      <nav className="bg-white border-b border-gray-200 px-6 flex gap-1">
        {([
          ['dashboard', t(lang, 'analytics')],
          ['history', lang === 'he' ? 'היסטוריה' : 'История'],
        ] as [Tab, string][]).map(([tabKey, label]) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-all ${
              tab === tabKey
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="p-6">
        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'history' && <HistoryTab />}
      </main>
    </div>
  )
}

type Preset = 'today' | 'week' | 'month' | 'custom'

function getPresetRange(preset: Preset): { from: string; to: string } {
  const now = new Date()
  const pad = (d: Date) => d.toISOString().slice(0, 10)
  if (preset === 'today') {
    const s = pad(now)
    return { from: s + 'T00:00:00', to: s + 'T23:59:59' }
  }
  if (preset === 'week') {
    const from = new Date(now); from.setDate(now.getDate() - 6); from.setHours(0, 0, 0, 0)
    return { from: pad(from) + 'T00:00:00', to: pad(now) + 'T23:59:59' }
  }
  if (preset === 'month') {
    const from = new Date(now); from.setDate(now.getDate() - 29); from.setHours(0, 0, 0, 0)
    return { from: pad(from) + 'T00:00:00', to: pad(now) + 'T23:59:59' }
  }
  return { from: pad(now) + 'T00:00:00', to: pad(now) + 'T23:59:59' }
}

function DashboardTab() {
  const lang = useLangStore((s) => s.lang)
  const isRu = lang === 'ru'
  const fmt = (n: number) => n.toLocaleString(lang === 'he' ? 'he-IL' : 'ru-RU')

  const [preset, setPreset] = useState<Preset>('today')
  const [customFrom, setCustomFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10))

  const range = preset === 'custom'
    ? { from: customFrom + 'T00:00:00', to: customTo + 'T23:59:59' }
    : getPresetRange(preset)

  const { data: todayStats } = useQuery({
    queryKey: ['today-stats'],
    queryFn: fetchTodayStats,
    refetchInterval: 60_000,
  })

  const { data: periodStats } = useQuery({
    queryKey: ['period-stats', range.from, range.to],
    queryFn: () => fetchStatsByPeriod(range.from, range.to),
  })

  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['item-sales', range.from, range.to],
    queryFn: () => fetchItemSalesByPeriod(range.from, range.to),
  })

  const presets: { key: Preset; ru: string; he: string }[] = [
    { key: 'today', ru: 'Сегодня', he: 'היום' },
    { key: 'week',  ru: '7 дней',  he: '7 ימים' },
    { key: 'month', ru: '30 дней', he: '30 ימים' },
    { key: 'custom',ru: 'Период',  he: 'תקופה' },
  ]

  const maxRevenue = items.length > 0 ? items[0].revenue : 1

  return (
    <div className="flex flex-col gap-5">
      {/* Live stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="card p-4">
          <p className="text-xs text-gray-400 mb-1">{isRu ? 'Выручка сегодня' : 'הכנסה היום'}</p>
          <p className="text-2xl font-black text-gray-900 tabular-nums">
            {fmt(todayStats?.totalRevenue ?? 0)} ₪
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-gray-400 mb-1">{isRu ? 'Чеков закрыто' : 'קבלות'}</p>
          <p className="text-2xl font-black text-gray-900 tabular-nums">{todayStats?.ordersCount ?? 0}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-gray-400 mb-1">{isRu ? 'Активных столов' : 'שולחנות פעילים'}</p>
          <p className="text-2xl font-black text-emerald-600 tabular-nums">{todayStats?.activeOrders ?? 0}</p>
        </div>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {presets.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                preset === p.key ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {isRu ? p.ru : p.he}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="input text-sm" />
            <span className="text-gray-400 text-sm">—</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="input text-sm" />
          </div>
        )}
      </div>

      {/* Period summary */}
      {periodStats && (
        <div className="grid grid-cols-3 gap-3">
          <div className="card p-4">
            <p className="text-xs text-gray-400 mb-1">{isRu ? 'Выручка за период' : 'הכנסה לתקופה'}</p>
            <p className="text-xl font-black text-gray-900 tabular-nums">{fmt(periodStats.totalRevenue)} ₪</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-gray-400 mb-1">{isRu ? 'Заказов' : 'הזמנות'}</p>
            <p className="text-xl font-black text-gray-900 tabular-nums">{periodStats.ordersCount}</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-gray-400 mb-1">{isRu ? 'Средний чек' : 'ממוצע לקבלה'}</p>
            <p className="text-xl font-black text-gray-900 tabular-nums">{fmt(Math.round(periodStats.avgCheck))} ₪</p>
          </div>
        </div>
      )}

      {/* Items table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bold text-gray-900 text-sm">{isRu ? 'Продажи по позициям' : 'מכירות לפי פריט'}</h2>
          <span className="text-xs text-gray-400">{items.length} {isRu ? 'позиций' : 'פריטים'}</span>
        </div>

        {itemsLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {[1,2,3,4,5].map((i) => <div key={i} className="h-10 rounded-xl bg-gray-100 animate-pulse" />)}
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-gray-400 text-sm">
            {isRu ? 'Нет данных за период' : 'אין נתונים לתקופה זו'}
          </div>
        ) : (
          <>
            <div className="px-5 py-2 grid grid-cols-[2rem_1fr_5rem_6rem] gap-3 border-b border-gray-50">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">#</span>
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">{isRu ? 'Блюдо' : 'מנה'}</span>
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide text-right">{isRu ? 'Кол-во' : 'כמות'}</span>
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide text-right">{isRu ? 'Сумма' : 'סכום'}</span>
            </div>
            <div className="divide-y divide-gray-50">
              {items.map((item, i) => (
                <div key={item.name} className="px-5 py-3 grid grid-cols-[2rem_1fr_5rem_6rem] gap-3 items-center">
                  <span className="text-xs font-bold text-gray-300">{i + 1}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{item.name}</p>
                    <div className="h-1 mt-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className="h-full bg-gray-900 rounded-full"
                        style={{ width: `${(item.revenue / maxRevenue) * 100}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-sm text-gray-600 text-right tabular-nums">{item.qty} {isRu ? 'шт' : 'יח'}</span>
                  <span className="text-sm font-bold text-gray-900 text-right tabular-nums">{fmt(Math.round(item.revenue))} ₪</span>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-gray-100 grid grid-cols-[2rem_1fr_5rem_6rem] gap-3">
              <span />
              <span className="text-sm font-bold text-gray-700">{isRu ? 'Итого' : 'סה"כ'}</span>
              <span className="text-sm font-bold text-gray-900 text-right tabular-nums">
                {items.reduce((s, i) => s + i.qty, 0)} {isRu ? 'шт' : 'יח'}
              </span>
              <span className="text-sm font-bold text-gray-900 text-right tabular-nums">
                {fmt(Math.round(items.reduce((s, i) => s + i.revenue, 0)))} ₪
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}


function HistoryTab() {
  const lang = useLangStore((s) => s.lang)
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10)
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [tableSearch, setTableSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['order-history', dateFrom, dateTo],
    queryFn: () => fetchOrderHistory({
      dateFrom: new Date(dateFrom).toISOString(),
      dateTo: new Date(dateTo + 'T23:59:59').toISOString(),
      limit: 200,
    }),
  })

  const filtered = tableSearch
    ? orders.filter((o) => String((o as any).table?.number).includes(tableSearch.trim()))
    : orders

  const METHOD_LABEL: Record<string, string> = { cash: 'Нал', card: 'Карта', split: 'Разделён' }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="card p-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">С</span>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input text-sm" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">По</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input text-sm" />
        </div>
        <input
          type="number"
          placeholder="Стол №"
          value={tableSearch}
          onChange={(e) => setTableSearch(e.target.value)}
          className="input text-sm w-24"
        />
        <span className="text-sm text-gray-400 ml-auto">
          {filtered.length} заказов · {filtered.reduce((s, o) => s + o.total, 0).toFixed(0)} ₪
        </span>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 rounded-xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">Нет заказов за выбранный период</div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((order) => {
            const isOpen = expanded === order.id
            const paymentMethods = (order as any).payments
              ? [...new Set((order as any).payments.map((p: any) => METHOD_LABEL[p.method] ?? p.method))].join(', ')
              : '—'
            return (
              <div key={order.id} className="card overflow-hidden">
                <button
                  onClick={() => setExpanded(isOpen ? null : order.id)}
                  className="w-full px-4 py-3 flex items-center gap-4 hover:bg-gray-50 transition-colors text-left"
                >
                  <span className="text-sm font-bold text-gray-900 w-16">
                    Стол {(order as any).table?.number ?? '?'}
                  </span>
                  <span className="text-xs text-gray-400 flex-1">
                    {formatDate(order.created_at, lang)}
                  </span>
                  <span className="text-xs text-gray-500">{paymentMethods}</span>
                  <span className="text-sm font-bold text-gray-900 w-20 text-right tabular-nums">
                    {order.total.toFixed(0)} ₪
                  </span>
                  <span className="text-gray-300 text-xs">{isOpen ? '▲' : '▼'}</span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 border-t border-gray-50">
                    <p className="text-xs text-gray-400 mb-2 mt-2">
                      #{order.id.slice(0, 8).toUpperCase()} · {(order as any).waiter?.name}
                    </p>
                    <div className="flex flex-col gap-1">
                      {order.order_items?.map((item: any) => (
                        <div key={item.id} className="flex justify-between text-sm">
                          <span className="text-gray-700">{item.qty}× {item.menu_item?.name}</span>
                          <span className="text-gray-500 tabular-nums">{(item.price * item.qty).toFixed(0)} ₪</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
