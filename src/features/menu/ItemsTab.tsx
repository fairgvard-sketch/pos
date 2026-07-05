import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  fetchCategories, createCategory, updateCategory, deleteCategory,
  fetchItems, toggleItemAvailability, deleteItem,
} from './api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import type { MenuItem } from '../../types'
import ItemModal from './ItemModal'

export default function ItemsTab() {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const { data: categories = [] } = useQuery({ queryKey: ['menu_categories'], queryFn: fetchCategories })
  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null)
  const [showItemModal, setShowItemModal] = useState(false)
  const [newCatName, setNewCatName] = useState('')

  const activeCat = activeCategoryId ?? categories[0]?.id ?? null
  const catItems = items.filter((i) => i.category_id === activeCat)

  const addCategory = useMutation({
    mutationFn: () => createCategory(newCatName.trim(), categories.length),
    onSuccess: () => {
      setNewCatName('')
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

  // Optimistic: скрыть/показать товар мгновенно
  const toggleAvail = useMutation({
    mutationFn: ({ id, v }: { id: string; v: boolean }) => toggleItemAvailability(id, v),
    onMutate: async ({ id, v }) => {
      await qc.cancelQueries({ queryKey: ['menu_items'] })
      const prev = qc.getQueryData<MenuItem[]>(['menu_items'])
      qc.setQueryData<MenuItem[]>(['menu_items'], (old) =>
        old?.map((i) => (i.id === id ? { ...i, is_available: v } : i))
      )
      return { prev }
    },
    onError: (_e, _v, ctx2) => qc.setQueryData(['menu_items'], ctx2?.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ['menu_items'] }),
  })

  const removeItem = useMutation({
    mutationFn: (id: string) => deleteItem(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu_items'] })
      toast.success(t(lang, 'deleted'))
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="flex gap-6">
      {/* Категории */}
      <aside className="w-56 shrink-0 space-y-2">
        {categories.map((c) => (
          <div key={c.id} className="group relative">
            <button
              onClick={() => setActiveCategoryId(c.id)}
              className={`w-full text-start px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                c.id === activeCat ? 'bg-gray-900 text-white' : 'bg-white border border-gray-100 text-gray-700 hover:border-gray-300'
              }`}
            >
              {c.name}
              <span className={`ms-2 text-xs ${c.id === activeCat ? 'text-gray-400' : 'text-gray-300'}`}>
                {items.filter((i) => i.category_id === c.id).length}
              </span>
            </button>
            <div className="absolute top-1/2 -translate-y-1/2 end-2 hidden group-hover:flex gap-1">
              <button
                onClick={() => {
                  const name = prompt(t(lang, 'categoryName'), c.name)
                  if (name?.trim()) renameCategory.mutate({ id: c.id, name: name.trim() })
                }}
                className={`text-xs px-1.5 py-0.5 rounded ${c.id === activeCat ? 'text-gray-300 hover:text-white' : 'text-gray-400 hover:text-gray-700'}`}
              >
                ✎
              </button>
              <button
                onClick={() => confirm(t(lang, 'confirmDelete')) && removeCategory.mutate(c.id)}
                className={`text-xs px-1.5 py-0.5 rounded ${c.id === activeCat ? 'text-gray-300 hover:text-red-300' : 'text-gray-400 hover:text-red-500'}`}
              >
                ✕
              </button>
            </div>
          </div>
        ))}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (newCatName.trim()) addCategory.mutate()
          }}
          className="flex gap-1.5"
        >
          <input
            className="input !py-2 !text-xs"
            placeholder={t(lang, 'newCategory')}
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
          />
          <button type="submit" disabled={!newCatName.trim() || addCategory.isPending} className="btn-secondary !px-3 !py-2 !text-xs">
            +
          </button>
        </form>
      </aside>

      {/* Товары */}
      <section className="flex-1">
        <div className="flex justify-end mb-4">
          <button
            onClick={() => { setEditingItem(null); setShowItemModal(true) }}
            disabled={!activeCat}
            className="btn-primary"
          >
            {t(lang, 'newItem')}
          </button>
        </div>

        {categories.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-16">{t(lang, 'noCategoriesYet')}</p>
        ) : catItems.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-16">{t(lang, 'noItemsYet')}</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {catItems.map((item) => (
              <div key={item.id} className={`card p-4 ${!item.is_available ? 'opacity-50' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <button
                    onClick={() => { setEditingItem(item); setShowItemModal(true) }}
                    className="text-start font-semibold text-gray-900 hover:underline"
                  >
                    {item.name}
                  </button>
                  <button
                    onClick={() => confirm(t(lang, 'confirmDelete')) && removeItem.mutate(item.id)}
                    className="text-gray-300 hover:text-red-500 text-sm shrink-0"
                  >
                    ✕
                  </button>
                </div>

                <div className="mt-1 text-sm font-bold text-gray-900 tabular-nums">
                  {item.item_variants && item.item_variants.length > 0
                    ? item.item_variants
                        .slice()
                        .sort((a, b) => a.sort_order - b.sort_order)
                        .map((v) => `${v.name} ${formatMoney(v.price, lang)}`)
                        .join(' · ')
                    : formatMoney(item.price, lang)}
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <button
                    onClick={() => toggleAvail.mutate({ id: item.id, v: !item.is_available })}
                    className={item.is_available ? 'badge-green' : 'badge-gray'}
                  >
                    {t(lang, item.is_available ? 'available' : 'unavailable')}
                  </button>
                  {(item.menu_item_modifier_groups?.length ?? 0) > 0 && (
                    <span className="badge-blue">{item.menu_item_modifier_groups!.length} мод.</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {showItemModal && activeCat && (
        <ItemModal
          item={editingItem}
          defaultCategoryId={activeCat}
          onClose={() => setShowItemModal(false)}
        />
      )}
    </div>
  )
}
