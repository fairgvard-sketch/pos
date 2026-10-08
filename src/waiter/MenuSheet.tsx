import { useMemo, useState } from 'react'
import { useLangStore } from '../store/langStore'
import { t } from '../lib/i18n'
import { formatMoney } from '../lib/money'
import type { WaiterMenu, WaiterMenuItem } from './api'

interface Props {
  menu: WaiterMenu
  /** Сколько штук товара уже в новом заказе — счётчик на строке */
  counts: Map<string, number>
  total: number
  onPick: (item: WaiterMenuItem) => void
  onClose: () => void
}

/**
 * Меню на весь экран: категории чипами, блюда списком под палец.
 * Тап добавляет блюдо сразу (или открывает выбор модификаторов),
 * лист не закрывается — официант набирает весь заказ стола подряд.
 */
export default function MenuSheet({ menu, counts, total, onPick, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)
  const categories = useMemo(
    () => menu.categories.filter((c) => menu.items.some((i) => i.category_id === c.id && i.is_available)),
    [menu]
  )
  const [cat, setCat] = useState<string | null>(categories[0]?.id ?? null)
  const [query, setQuery] = useState('')

  const visibleCats = useMemo(() => new Set(categories.map((c) => c.id)), [categories])
  const items = useMemo(() => {
    const sellable = menu.items.filter((i) => i.is_available && visibleCats.has(i.category_id))
    const q = query.trim().toLowerCase()
    if (q) return sellable.filter((i) => i.name.toLowerCase().includes(q))
    return sellable.filter((i) => i.category_id === cat)
  }, [menu, visibleCats, query, cat])

  return (
    <div className="fixed inset-0 z-40 bg-[#f8f9fb] flex flex-col">
      <div
        className="shrink-0 px-4 pb-3 space-y-3 border-b border-gray-100 bg-[#f8f9fb]"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-3">
          <input
            className="input flex-1"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(lang, 'wSearch')}
          />
          <button className="btn-primary shrink-0" onClick={onClose}>
            {t(lang, 'done')}{total > 0 ? ` · ${total}` : ''}
          </button>
        </div>
        {!query.trim() && (
          <div className="flex gap-2 overflow-x-auto -mx-4 px-4">
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setCat(c.id)}
                className={`shrink-0 h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.97] ${
                  cat === c.id ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-700'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        {items.map((item) => {
          const n = counts.get(item.id) ?? 0
          return (
            <button
              key={item.id}
              onClick={() => onPick(item)}
              className="card w-full min-h-14 px-4 py-3 flex items-center gap-3 text-start active:scale-[0.98] transition-transform"
            >
              <span className="flex-1 min-w-0 font-semibold text-gray-900">{item.name}</span>
              <span className="text-sm text-gray-500 tabular-nums shrink-0">{formatMoney(item.price, lang)}</span>
              {n > 0 && (
                <span className="shrink-0 min-w-7 h-7 px-2 rounded-full bg-gray-900 text-white text-sm font-bold flex items-center justify-center tabular-nums">
                  {n}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
