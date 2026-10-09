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
  /** Убрать одну порцию — из последней добавленной строки этого блюда */
  onDecrement: (item: WaiterMenuItem) => void
  onClose: () => void
}

/**
 * Меню на весь экран: категории колонкой сбоку (как навигация кассы),
 * блюда списком рядом. Тап по блюду или «+» добавляет порцию (или
 * открывает выбор модификаторов), «−» убирает последнюю — количество
 * меняется прямо на строке, лист не закрывается: официант набирает весь
 * заказ стола подряд. При поиске колонка прячется: ищем по всему меню.
 */
export default function MenuSheet({ menu, counts, total, onPick, onDecrement, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)
  const categories = useMemo(
    () => menu.categories.filter((c) => menu.items.some((i) => i.category_id === c.id && i.is_available)),
    [menu]
  )
  const [cat, setCat] = useState<string | null>(categories[0]?.id ?? null)
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''

  const visibleCats = useMemo(() => new Set(categories.map((c) => c.id)), [categories])
  const items = useMemo(() => {
    const sellable = menu.items.filter((i) => i.is_available && visibleCats.has(i.category_id))
    const q = query.trim().toLowerCase()
    if (q) return sellable.filter((i) => i.name.toLowerCase().includes(q))
    return sellable.filter((i) => i.category_id === cat)
  }, [menu, visibleCats, query, cat])

  // Сколько уже набрано в каждой категории — видно, куда официант заходил
  const perCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of menu.items) {
      const n = counts.get(i.id) ?? 0
      if (n > 0) m.set(i.category_id, (m.get(i.category_id) ?? 0) + n)
    }
    return m
  }, [menu, counts])

  return (
    <div className="fixed inset-0 z-40 bg-[#f8f9fb] flex flex-col">
      <div
        className="shrink-0 px-4 pb-3 border-b border-gray-100 bg-[#f8f9fb]"
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
      </div>

      <div className="flex-1 min-h-0 flex">
        {!searching && (
          <nav
            className="w-24 shrink-0 overflow-y-auto bg-white border-e border-gray-100 px-2 py-2 space-y-1"
            style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
            aria-label={t(lang, 'categories')}
          >
            {categories.map((c) => {
              const active = cat === c.id
              const n = perCategory.get(c.id) ?? 0
              return (
                <button
                  key={c.id}
                  onClick={() => setCat(c.id)}
                  aria-current={active ? 'true' : undefined}
                  className={`w-full min-h-16 rounded-2xl px-1 py-2 flex flex-col items-center justify-center gap-1 transition-colors active:scale-[0.97] ${
                    active ? 'bg-gray-100 text-gray-900' : 'text-gray-500'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`relative w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold ${
                      active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {c.name.trim().charAt(0).toUpperCase()}
                    {n > 0 && (
                      <span className="absolute -top-1.5 -end-1.5 min-w-5 h-5 px-1 rounded-full bg-gray-900 text-white text-[11px] font-bold flex items-center justify-center tabular-nums ring-2 ring-white">
                        {n}
                      </span>
                    )}
                  </span>
                  <span className={`w-full text-center text-xs leading-tight line-clamp-2 break-words ${active ? 'font-bold' : 'font-semibold'}`}>
                    {c.name}
                  </span>
                </button>
              )
            })}
          </nav>
        )}

        <div
          className="flex-1 min-w-0 overflow-y-auto px-3 py-3 space-y-2"
          style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
        >
          {items.map((item) => {
            const n = counts.get(item.id) ?? 0
            return (
              <div key={item.id} className="card w-full min-h-14 ps-3 pe-2 py-2 flex items-center gap-2">
                <button
                  onClick={() => onPick(item)}
                  className="flex-1 min-w-0 min-h-11 py-1 text-start active:opacity-60"
                >
                  <span className="block font-semibold text-gray-900 leading-snug break-words">{item.name}</span>
                  <span className="block text-sm text-gray-500 tabular-nums">{formatMoney(item.price, lang)}</span>
                </button>
                <div className="shrink-0 flex items-center gap-1" dir="ltr">
                  {n > 0 && (
                    <>
                      <button
                        onClick={() => onDecrement(item)}
                        aria-label={`− ${item.name}`}
                        className="w-11 h-11 rounded-xl border border-gray-200 bg-white text-xl font-bold text-gray-900 active:scale-[0.95]"
                      >
                        −
                      </button>
                      <span className="w-7 text-center text-base font-bold text-gray-900 tabular-nums" aria-live="polite">{n}</span>
                    </>
                  )}
                  <button
                    onClick={() => onPick(item)}
                    aria-label={`${t(lang, 'add')} ${item.name}`}
                    className={`w-11 h-11 rounded-xl text-xl font-bold active:scale-[0.95] ${
                      n > 0 ? 'bg-gray-900 text-white' : 'border border-gray-200 bg-white text-gray-900'
                    }`}
                  >
                    +
                  </button>
                </div>
              </div>
            )
          })}
          {searching && items.length === 0 && (
            <p className="text-center text-gray-500 py-8">{t(lang, 'nothingFound')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
