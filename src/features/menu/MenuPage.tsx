import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCategories, createCategory, updateCategory, deleteCategory, fetchItems } from './api'
import { useLangStore } from '../../store/langStore'
import { t, type TranslationKey } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import AppSidebar from '../../components/AppSidebar'
import ItemImage from '../../components/ItemImage'
import ItemEditor from './ItemEditor'
import ModifierGroupsTab from './ModifierGroupsTab'
import StationsTab from './StationsTab'

type Tab = 'items' | 'modifiers' | 'stations'

const CATEGORY_ICONS = ['☕', '🍵', '🥤', '🧃', '🥐', '🍞', '🥪', '🍰', '🍪', '🥗', '🛍', '🎁']

const TABS: { id: Tab; label: TranslationKey }[] = [
  { id: 'items', label: 'items' },
  { id: 'modifiers', label: 'modifiersTab' },
  { id: 'stations', label: 'stations' },
]

export default function MenuPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const qc = useQueryClient()

  const { data: categories = [] } = useQuery({ queryKey: ['menu_categories'], queryFn: fetchCategories })
  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })

  const [tab, setTab] = useState<Tab>('items')
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [newCatName, setNewCatName] = useState('')
  const [newCatIcon, setNewCatIcon] = useState<string | null>(null)
  const [showCatForm, setShowCatForm] = useState(false)

  const activeCat = activeCategoryId ?? categories[0]?.id ?? null
  const selectedItem = items.find((i) => i.id === selectedItemId) ?? null

  const listItems = useMemo(() => {
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      return items.filter((i) => i.name.toLowerCase().includes(q))
    }
    return items.filter((i) => i.category_id === activeCat)
  }, [items, activeCat, search])

  const addCategory = useMutation({
    mutationFn: () => createCategory(newCatName.trim(), categories.length, newCatIcon),
    onSuccess: () => {
      setNewCatName('')
      setNewCatIcon(null)
      setShowCatForm(false)
      qc.invalidateQueries({ queryKey: ['menu_categories'] })
    },
    onError: (e) => toast.error(e.message),
  })

  const removeCategory = useMutation({
    mutationFn: (id: string) => deleteCategory(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu_categories'] })
      qc.invalidateQueries({ queryKey: ['menu_items'] })
      toast.success(t(lang, 'deleted'))
    },
    onError: (e) => toast.error(e.message),
  })

  const renameCategory = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => updateCategory(id, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu_categories'] }),
  })

  function selectItem(id: string) {
    setSelectedItemId(id)
    setCreating(false)
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="menu" />

      {/* ── Колонка каталога ──────────────────────── */}
      <div className="w-64 shrink-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-4 pb-0 shrink-0">
          <h1 className="font-black text-gray-900 mb-3">{t(lang, 'menu')}</h1>
          <div className="flex rounded-xl overflow-hidden border border-gray-100 bg-gray-50 p-0.5 gap-0.5 mb-4">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  tab === tb.id
                    ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {t(lang, tb.label)}
              </button>
            ))}
          </div>
        </div>

        {tab === 'items' && (
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
            {/* Категории */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                  {t(lang, 'categories')}
                </span>
                <button onClick={() => setShowCatForm(!showCatForm)} className="text-xs text-gray-400 hover:text-gray-900 font-semibold">
                  +
                </button>
              </div>

              {showCatForm && (
                <form
                  onSubmit={(e) => { e.preventDefault(); if (newCatName.trim()) addCategory.mutate() }}
                  className="mb-2 space-y-1.5"
                >
                  <div className="flex gap-1.5">
                    <input
                      className="input !py-1.5 !text-xs"
                      placeholder={t(lang, 'categoryName')}
                      value={newCatName}
                      autoFocus
                      onChange={(e) => setNewCatName(e.target.value)}
                    />
                    <button type="submit" disabled={!newCatName.trim()} className="btn-secondary !px-2.5 !py-1.5 !text-xs">✓</button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {CATEGORY_ICONS.map((ic) => (
                      <button
                        key={ic}
                        type="button"
                        onClick={() => setNewCatIcon(newCatIcon === ic ? null : ic)}
                        className={`w-7 h-7 rounded-lg text-sm flex items-center justify-center transition-all ${
                          newCatIcon === ic ? 'bg-gray-900' : 'bg-gray-50 hover:bg-gray-100'
                        }`}
                      >
                        {ic}
                      </button>
                    ))}
                  </div>
                </form>
              )}

              <div className="space-y-0.5">
                {categories.map((c) => (
                  <div key={c.id} className="group relative">
                    <button
                      onClick={() => { setActiveCategoryId(c.id); setSearch('') }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm font-semibold transition-all ${
                        !search && c.id === activeCat ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      <span className="truncate">
                        {c.icon && <span className="me-1.5">{c.icon}</span>}
                        {c.name}
                      </span>
                      <span className="text-xs text-gray-300 group-hover:hidden">
                        {items.filter((i) => i.category_id === c.id).length}
                      </span>
                    </button>
                    <div className="absolute top-1/2 -translate-y-1/2 end-2 hidden group-hover:flex gap-1 bg-inherit">
                      <button
                        onClick={() => {
                          const name = prompt(t(lang, 'categoryName'), c.name)
                          if (name?.trim()) renameCategory.mutate({ id: c.id, name: name.trim() })
                        }}
                        className="text-xs text-gray-400 hover:text-gray-700"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => confirm(t(lang, 'confirmDelete')) && removeCategory.mutate(c.id)}
                        className="text-xs text-gray-400 hover:text-red-500"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Все товары */}
            <div>
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
                {t(lang, 'allItems')}
              </div>
              <input
                className="input !py-2 !text-xs mb-2"
                placeholder={t(lang, 'searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                onClick={() => { setCreating(true); setSelectedItemId(null) }}
                className={`w-full py-2 rounded-xl text-sm font-semibold border transition-all mb-2 ${
                  creating
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white border-gray-200 text-gray-600 hover:border-gray-400'
                }`}
              >
                {t(lang, 'addItem')}
              </button>

              <div className="space-y-0.5">
                {listItems.map((i) => (
                  <button
                    key={i.id}
                    onClick={() => selectItem(i.id)}
                    className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-xl transition-all text-start ${
                      i.id === selectedItemId ? 'bg-gray-100' : 'hover:bg-gray-50'
                    } ${!i.is_available ? 'opacity-40' : ''}`}
                  >
                    <ItemImage item={i} size="mini" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-gray-900 truncate leading-tight">
                        {i.is_favorite && <span className="text-amber-400">★ </span>}
                        {i.name}
                      </span>
                      <span className="block text-xs text-gray-400 tabular-nums">
                        {formatMoney(i.price, lang)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab !== 'items' && <div className="flex-1" />}
      </div>

      {/* ── Основная область ──────────────────────── */}
      {tab === 'items' ? (
        creating || selectedItem ? (
          <ItemEditor
            key={creating ? 'new' : selectedItem?.id}
            item={creating ? null : selectedItem}
            defaultCategoryId={activeCat ?? ''}
            onSaved={(id) => { setCreating(false); setSelectedItemId(id) }}
            onDeleted={() => { setSelectedItemId(null); setCreating(false) }}
            onBack={() => { setSelectedItemId(null); setCreating(false) }}
          />
        ) : (
          <main className="flex-1 bg-white rounded-3xl flex items-center justify-center">
            <p className="text-gray-300 text-sm">
              {categories.length === 0 ? t(lang, 'noCategoriesYet') : t(lang, 'selectOrCreateItem')}
            </p>
          </main>
        )
      ) : (
        <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
          {tab === 'modifiers' && <ModifierGroupsTab />}
          {tab === 'stations' && <StationsTab />}
        </main>
      )}
    </div>
  )
}
