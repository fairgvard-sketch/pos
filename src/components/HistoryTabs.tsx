import { t, type TranslationKey } from '../lib/i18n'
import type { HistoryPeriod } from '../features/online/api'

/**
 * Общие кирпичи вкладки «История» (113) для онлайн-заказов и броней:
 * переключатель Активные/История и панель фильтров (период + поиск).
 * Живут отдельным модулем, чтобы два lazy-маршрута не тянули друг друга.
 */

/** Переключатель «Активные / История» в шапке экрана */
export function TabSwitch({
  value, onChange, activeLabel, historyLabel,
}: {
  value: 'active' | 'history'
  onChange: (v: 'active' | 'history') => void
  activeLabel: string
  historyLabel: string
}) {
  const opts = [
    { v: 'active' as const, label: activeLabel },
    { v: 'history' as const, label: historyLabel },
  ]
  return (
    <div className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5 shrink-0">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`h-10 px-4 rounded-lg text-sm font-semibold transition-all whitespace-nowrap ${
            value === o.v
              ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const PERIODS: { v: HistoryPeriod; label: TranslationKey }[] = [
  { v: 'today', label: 'periodToday' },
  { v: '7d', label: 'period7d' },
  { v: '30d', label: 'period30d' },
]

/** Фильтры истории: период + поиск по имени/телефону */
export function HistoryFilters({
  lang, period, onPeriod, search, onSearch,
}: {
  lang: 'ru' | 'he'
  period: HistoryPeriod
  onPeriod: (p: HistoryPeriod) => void
  search: string
  onSearch: (v: string) => void
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap mb-5">
      <div className="inline-flex rounded-xl border border-gray-100 bg-gray-50 p-0.5 gap-0.5 shrink-0">
        {PERIODS.map((p) => (
          <button
            key={p.v}
            onClick={() => onPeriod(p.v)}
            className={`h-10 px-4 rounded-lg text-sm font-semibold transition-all whitespace-nowrap ${
              period === p.v
                ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t(lang, p.label)}
          </button>
        ))}
      </div>
      <input
        className="input flex-1 min-w-[200px] max-w-xs"
        placeholder={t(lang, 'historySearchPh')}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
    </div>
  )
}
