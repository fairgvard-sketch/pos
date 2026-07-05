import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { fetchAllMenuItems, updateMenuItem, createMenuItem, deleteMenuItem, fetchAllMenuCategories, createMenuCategory } from '../menu/api'
import { fetchTables, createTable, updateTable, deleteTable } from '../tables/api'
import { useSettingsStore } from '../../store/settingsStore'
import { useLangStore } from '../../store/langStore'
import LangToggle from '../../components/ui/LangToggle'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import ModifierEditor from '../menu/ModifierEditor'
import type { MenuItem, Table } from '../../types'

type Tab = 'menu' | 'tables' | 'settings'

type ItemForm = {
  name: string
  price: string
  description: string
  prep_time_min: string
  category_id: string
  is_available: boolean
  ask_modifiers: boolean
  image_url: string
}

const EMPTY_FORM: ItemForm = {
  name: '', price: '', description: '', prep_time_min: '10',
  category_id: '', is_available: true, ask_modifiers: true, image_url: '',
}

function ItemToggle({ value, label, color, onToggle }: {
  value: boolean
  label: string
  color: 'gray' | 'emerald'
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      title={label}
      className={`h-8 px-2.5 rounded-xl border flex items-center gap-1.5 transition-all text-xs font-medium ${
        value
          ? color === 'emerald'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
            : 'bg-gray-900 border-gray-900 text-white'
          : 'bg-white border-gray-200 text-gray-400 hover:border-gray-300'
      }`}
    >
      <span className={`w-2 h-2 rounded-full transition-colors ${value ? (color === 'emerald' ? 'bg-emerald-500' : 'bg-white') : 'bg-gray-300'}`} />
      {label}
    </button>
  )
}

function MenuTab() {
  const qc = useQueryClient()


  const [editItem, setEditItem] = useState<MenuItem | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<ItemForm>(EMPTY_FORM)
  const [showCatForm, setShowCatForm] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [stopListOnly, setStopListOnly] = useState(false)
  const [menuSearch, setMenuSearch] = useState('')
  const [modifierEditorItem, setModifierEditorItem] = useState<MenuItem | null>(null)
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<MenuItem | null>(null)

  const { data: items = [] } = useQuery({
    queryKey: ['all-menu-items'],
    queryFn: fetchAllMenuItems,
  })

  const { data: categories = [] } = useQuery({
    queryKey: ['all-menu-categories'],
    queryFn: fetchAllMenuCategories,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['all-menu-items'] })
    qc.invalidateQueries({ queryKey: ['menu-items'] })
  }

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_available }: { id: string; is_available: boolean }) =>
      updateMenuItem(id, { is_available }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })

  const toggleModifiersMutation = useMutation({
    mutationFn: ({ id, ask_modifiers }: { id: string; ask_modifiers: boolean }) =>
      updateMenuItem(id, { ask_modifiers }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        price: parseFloat(form.price),
        description: form.description.trim() || null,
        prep_time_min: parseInt(form.prep_time_min) || 10,
        category_id: form.category_id,
        is_available: form.is_available,
        ask_modifiers: form.ask_modifiers,
        image_url: form.image_url.trim() || null,
      }
      if (editItem) return updateMenuItem(editItem.id, payload)
      return createMenuItem(payload as any)
    },
    onSuccess: () => {
      invalidate()
      setShowForm(false)
      setEditItem(null)
      setForm(EMPTY_FORM)
      toast.success(editItem ? 'Блюдо обновлено' : 'Блюдо добавлено')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMenuItem(id),
    onSuccess: () => { invalidate(); toast.success('Блюдо удалено') },
    onError: (e: Error) => toast.error(e.message),
  })

  const addCatMutation = useMutation({
    mutationFn: () => createMenuCategory(newCatName.trim(), categories.length + 1),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['all-menu-categories'] })
      qc.invalidateQueries({ queryKey: ['menu-categories'] })
      setShowCatForm(false)
      setNewCatName('')
      toast.success('Категория добавлена')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const restoreAllMutation = useMutation({
    mutationFn: async () => {
      const unavailable = items.filter((i) => !i.is_available)
      await Promise.all(unavailable.map((i) => updateMenuItem(i.id, { is_available: true })))
    },
    onSuccess: () => { invalidate(); toast.success('Все блюда восстановлены') },
    onError: (e: Error) => toast.error(e.message),
  })

  const openCreate = () => {
    setEditItem(null)
    setForm({ ...EMPTY_FORM, category_id: categories[0]?.id ?? '' })
    setShowForm(true)
  }

  const openEdit = (item: MenuItem) => {
    setEditItem(item)
    setForm({
      name: item.name,
      price: String(item.price),
      description: item.description ?? '',
      prep_time_min: String(item.prep_time_min),
      category_id: item.category_id,
      is_available: item.is_available,
      ask_modifiers: item.ask_modifiers,
      image_url: item.image_url ?? '',
    })
    setShowForm(true)
  }

  const filteredItems = items.filter((item) => {
    const matchSearch = !menuSearch || item.name.toLowerCase().includes(menuSearch.toLowerCase())
    const matchStop = !stopListOnly || !item.is_available
    return matchSearch && matchStop
  })

  const byCategory = filteredItems.reduce<Record<string, MenuItem[]>>((acc, item) => {
    const cat = item.category?.name ?? 'Без категории'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(item)
    return acc
  }, {})

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={openCreate} className="btn-primary text-sm px-4 py-2">
          + Блюдо
        </button>
        <button onClick={() => setShowCatForm((v) => !v)} className="btn-secondary text-sm px-4 py-2">
          + Категория
        </button>
        <div className="flex-1 min-w-[180px]">
          <input
            type="text"
            placeholder="Поиск блюда..."
            value={menuSearch}
            onChange={(e) => setMenuSearch(e.target.value)}
            className="input w-full text-sm"
          />
        </div>
        <button
          onClick={() => setStopListOnly((v) => !v)}
          className={`text-sm px-4 py-2 rounded-xl border transition-all ${
            stopListOnly
              ? 'bg-red-500 text-white border-red-500'
              : 'bg-white border-gray-200 text-gray-700 hover:border-red-300 hover:text-red-500'
          }`}
        >
          Стоп-лист {stopListOnly && items.filter((i) => !i.is_available).length > 0 && `(${items.filter((i) => !i.is_available).length})`}
        </button>
        {stopListOnly && items.some((i) => !i.is_available) && (
          <button
            onClick={() => restoreAllMutation.mutate()}
            disabled={restoreAllMutation.isPending}
            className="btn-success text-sm px-4 py-2"
          >
            Восстановить все
          </button>
        )}
      </div>

      {showCatForm && (
        <div className="card p-4 flex items-center gap-3">
          <input
            autoFocus
            type="text"
            placeholder="Название категории"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            className="input flex-1 text-sm"
            onKeyDown={(e) => { if (e.key === 'Enter') addCatMutation.mutate() }}
          />
          <button
            onClick={() => addCatMutation.mutate()}
            disabled={!newCatName.trim() || addCatMutation.isPending}
            className="btn-success text-sm px-4 py-2"
          >
            Добавить
          </button>
          <button onClick={() => setShowCatForm(false)} className="btn-ghost text-sm px-3 py-2">
            Отмена
          </button>
        </div>
      )}

      {showForm && (
        <div className="card p-5 border border-gray-200">
          <h3 className="font-bold text-gray-900 mb-4">{editItem ? 'Редактировать блюдо' : 'Новое блюдо'}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-gray-500 mb-1 block">Название</label>
              <input
                autoFocus
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="input w-full text-sm"
                placeholder="Название блюда"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Цена (₪)</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                className="input w-full text-sm"
                placeholder="0"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Время приготовления (мин)</label>
              <input
                type="number"
                min="1"
                value={form.prep_time_min}
                onChange={(e) => setForm((f) => ({ ...f, prep_time_min: e.target.value }))}
                className="input w-full text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-gray-500 mb-1 block">Категория</label>
              <select
                value={form.category_id}
                onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value }))}
                className="input w-full text-sm"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-gray-500 mb-1 block">Описание</label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                className="input w-full text-sm"
                placeholder="Необязательно"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-gray-500 mb-1 block">URL изображения</label>
              <input
                type="text"
                value={form.image_url}
                onChange={(e) => setForm((f) => ({ ...f, image_url: e.target.value }))}
                className="input w-full text-sm"
                placeholder="https://..."
              />
            </div>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <span
                onClick={() => setForm((f) => ({ ...f, is_available: !f.is_available }))}
                className={`inline-flex shrink-0 w-11 h-6 rounded-full transition-colors duration-200 relative ${form.is_available ? 'bg-emerald-500' : 'bg-gray-200'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${form.is_available ? 'translate-x-5' : 'translate-x-0'}`} />
              </span>
              <span className="text-sm text-gray-700">В наличии</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <span
                onClick={() => setForm((f) => ({ ...f, ask_modifiers: !f.ask_modifiers }))}
                className={`inline-flex shrink-0 w-11 h-6 rounded-full transition-colors duration-200 relative ${form.ask_modifiers ? 'bg-gray-900' : 'bg-gray-200'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${form.ask_modifiers ? 'translate-x-5' : 'translate-x-0'}`} />
              </span>
              <span className="text-sm text-gray-700">Спрашивать добавки</span>
            </label>
          </div>
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => saveMutation.mutate()}
              disabled={!form.name || !form.price || !form.category_id || saveMutation.isPending}
              className="btn-success flex-1 text-sm py-2.5"
            >
              {saveMutation.isPending ? 'Сохраняем...' : 'Сохранить'}
            </button>
            <button
              onClick={() => { setShowForm(false); setEditItem(null); setForm(EMPTY_FORM) }}
              className="btn-secondary px-5 text-sm py-2.5"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {modifierEditorItem && (
        <ModifierEditor
          item={modifierEditorItem}
          onClose={() => setModifierEditorItem(null)}
        />
      )}

      {confirmDeleteItem && (
        <ConfirmDialog
          title={`Удалить «${confirmDeleteItem.name}»?`}
          message="Это действие нельзя отменить"
          confirmLabel="Удалить"
          cancelLabel="Отмена"
          onConfirm={() => { deleteMutation.mutate(confirmDeleteItem.id); setConfirmDeleteItem(null) }}
          onCancel={() => setConfirmDeleteItem(null)}
        />
      )}

      {Object.entries(byCategory).map(([cat, catItems]) => (
        <div key={cat} className="card p-4">
          <h3 className="font-bold text-gray-800 mb-3">{cat}</h3>
          <div className="flex flex-col gap-2">
            {catItems.map((item) => (
              <div key={item.id} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className="flex-1">
                  <p className={`text-sm font-medium ${item.is_available ? 'text-gray-900' : 'text-gray-400 line-through'}`}>
                    {item.name}
                  </p>
                  <p className="text-xs text-gray-500">
                    {item.price} ₪ · {item.prep_time_min} мин
                    {item.description && ` · ${item.description}`}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setModifierEditorItem(item)}
                    title="Настроить добавки"
                    className="h-8 px-2.5 rounded-xl border border-gray-200 hover:border-gray-400 hover:bg-gray-50 flex items-center gap-1.5 transition-all text-gray-400 hover:text-gray-700"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                    </svg>
                    <span className="text-xs">Добавки</span>
                  </button>
                  <ItemToggle
                    value={item.ask_modifiers}
                    label="Спрашивать"
                    color="gray"
                    onToggle={() => toggleModifiersMutation.mutate({ id: item.id, ask_modifiers: !item.ask_modifiers })}
                  />
                  <ItemToggle
                    value={item.is_available}
                    label="В наличии"
                    color="emerald"
                    onToggle={() => toggleMutation.mutate({ id: item.id, is_available: !item.is_available })}
                  />
                  <button
                    onClick={() => openEdit(item)}
                    className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-300 hover:text-gray-700 transition-colors"
                    title="Редактировать"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => {
                      setConfirmDeleteItem(item)
                    }}
                    className="w-8 h-8 rounded-lg hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-500 transition-colors"
                    title="Удалить"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TablesTab() {
  const qc = useQueryClient()
  const [editTable, setEditTable] = useState<Table | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ number: '', capacity: '4', zone: '' })
  const [confirmDeleteTable, setConfirmDeleteTable] = useState<Table | null>(null)

  const { data: tables = [] } = useQuery({
    queryKey: ['all-tables'],
    queryFn: fetchTables,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['all-tables'] })

  const saveMutation = useMutation({
    mutationFn: () => {
      const number = parseInt(form.number)
      const capacity = parseInt(form.capacity) || 4
      const zone = form.zone.trim() || null
      if (editTable) return updateTable(editTable.id, { number, capacity, zone })
      return createTable(number, capacity, zone)
    },
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['tables'] })
      setShowForm(false)
      setEditTable(null)
      setForm({ number: '', capacity: '4', zone: '' })
      toast.success(editTable ? 'Стол обновлён' : 'Стол добавлен')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTable(id),
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['tables'] })
      toast.success('Стол удалён')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const openCreate = () => {
    setEditTable(null)
    const nextNumber = tables.length > 0 ? Math.max(...tables.map((t) => t.number)) + 1 : 1
    setForm({ number: String(nextNumber), capacity: '4', zone: '' })
    setShowForm(true)
  }

  const openEdit = (t: Table) => {
    setEditTable(t)
    setForm({ number: String(t.number), capacity: String(t.capacity), zone: t.zone ?? '' })
    setShowForm(true)
  }

  const zones = [...new Set(tables.map((t) => t.zone).filter(Boolean))] as string[]

  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <div className="flex items-center gap-2">
        <button onClick={openCreate} className="btn-primary text-sm px-4 py-2">
          + Стол
        </button>
        <span className="text-sm text-gray-400">{tables.length} столов</span>
      </div>

      {showForm && (
        <div className="card p-5 border border-gray-200">
          <h3 className="font-bold text-gray-900 mb-4">
            {editTable ? `Стол №${editTable.number}` : 'Новый стол'}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Номер стола</label>
              <input
                autoFocus
                type="number"
                min="1"
                value={form.number}
                onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))}
                className="input w-full text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Мест</label>
              <input
                type="number"
                min="1"
                max="20"
                value={form.capacity}
                onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
                className="input w-full text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-gray-500 mb-1 block">Зона (необязательно)</label>
              <input
                type="text"
                value={form.zone}
                onChange={(e) => setForm((f) => ({ ...f, zone: e.target.value }))}
                className="input w-full text-sm"
                placeholder={zones.length > 0 ? `например: ${zones[0]}` : 'Терраса, Зал, Бар...'}
                list="zones-list"
              />
              {zones.length > 0 && (
                <datalist id="zones-list">
                  {zones.map((z) => <option key={z} value={z} />)}
                </datalist>
              )}
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => saveMutation.mutate()}
              disabled={!form.number || saveMutation.isPending}
              className="btn-success flex-1 text-sm py-2.5"
            >
              {saveMutation.isPending ? 'Сохраняем...' : 'Сохранить'}
            </button>
            <button
              onClick={() => { setShowForm(false); setEditTable(null) }}
              className="btn-secondary px-5 text-sm py-2.5"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        {tables.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">Нет столов</div>
        ) : (
          <>
            <div className="px-4 py-2 border-b border-gray-100 grid grid-cols-[auto_1fr_auto_auto] gap-4">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide w-10">№</span>
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Зона</span>
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide w-12 text-center">Мест</span>
              <span className="w-16" />
            </div>
            {tables.map((t, i) => (
              <div
                key={t.id}
                className={`px-4 py-3 grid grid-cols-[auto_1fr_auto_auto] gap-4 items-center ${
                  i !== tables.length - 1 ? 'border-b border-gray-50' : ''
                }`}
              >
                <span className="text-sm font-bold text-gray-900 w-10">{t.number}</span>
                <span className="text-sm text-gray-500">{t.zone ?? <span className="text-gray-300">—</span>}</span>
                <span className="text-sm text-gray-600 w-12 text-center">{t.capacity}</span>
                <div className="flex items-center gap-1 w-16 justify-end">
                  <button
                    onClick={() => openEdit(t)}
                    className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-300 hover:text-gray-700 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => {
                      setConfirmDeleteTable(t)
                    }}
                    className="w-7 h-7 rounded-lg hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-500 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {confirmDeleteTable && (
        <ConfirmDialog
          title={`Удалить стол №${confirmDeleteTable.number}?`}
          message="Это действие нельзя отменить"
          confirmLabel="Удалить"
          cancelLabel="Отмена"
          onConfirm={() => { deleteMutation.mutate(confirmDeleteTable.id); setConfirmDeleteTable(null) }}
          onCancel={() => setConfirmDeleteTable(null)}
        />
      )}
    </div>
  )
}

function CashierSettingsTab() {
  const lang = useLangStore((s) => s.lang)
  const { cartItemActions, setCartItemActions, business, setBusiness, venueType, setVenueType } = useSettingsStore()

  const isRu = lang === 'ru'

  const actions: { key: keyof typeof cartItemActions; labelRu: string; labelHe: string }[] = [
    { key: 'price',       labelRu: 'Изменение цены',      labelHe: 'שינוי מחיר' },
    { key: 'discountPct', labelRu: 'Скидка %',             labelHe: 'הנחה %'     },
    { key: 'discountAbs', labelRu: 'Скидка ₪',             labelHe: 'הנחה ₪'     },
    { key: 'modifiers',   labelRu: 'Допы (модификаторы)',  labelHe: 'תוספות'     },
  ]

  return (
    <div className="max-w-lg space-y-4">
      <div className="card p-6">
        <h2 className="font-bold text-gray-900 mb-1">
          {isRu ? 'Режим работы' : 'מצב עבודה'}
        </h2>
        <p className="text-xs text-gray-400 mb-4">
          {isRu
            ? 'Определяет, как работает касса: с залом и кухней или как магазин'
            : 'קובע כיצד הקופה עובדת: עם אולם ומטבח או כחנות'}
        </p>
        <div className="flex gap-2">
          {([
            ['restaurant', isRu ? 'Ресторан / кафе' : 'מסעדה / בית קפה'],
            ['retail',     isRu ? 'Магазин / прилавок' : 'חנות / דוכן'],
          ] as ['restaurant' | 'retail', string][]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setVenueType(v)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all ${
                venueType === v
                  ? 'bg-gray-900 text-white border-gray-900'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card p-6">
        <h2 className="font-bold text-gray-900 mb-1">
          {isRu ? 'Данные заведения для чека' : 'פרטי העסק לקבלה'}
        </h2>
        <p className="text-xs text-gray-400 mb-5">
          {isRu ? 'Печатается в шапке чека' : 'יופיע בראש הקבלה המודפסת'}
        </p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              {isRu ? 'Название заведения' : 'שם העסק'}
            </label>
            <input
              className="input text-sm"
              value={business.name}
              onChange={(e) => setBusiness({ name: e.target.value })}
              placeholder={isRu ? 'Название ресторана' : 'המסעדה שלנו'}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              {isRu ? 'Адрес' : 'כתובת'}
            </label>
            <input
              className="input text-sm"
              value={business.address}
              onChange={(e) => setBusiness({ address: e.target.value })}
              placeholder={isRu ? 'Адрес...' : 'רחוב הראשי 1, תל אביב'}
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">
                {isRu ? 'ИНН (ח.פ)' : 'ח.פ / ע.מ'}
              </label>
              <input
                className="input text-sm"
                value={business.businessId}
                onChange={(e) => setBusiness({ businessId: e.target.value })}
                placeholder="123456789"
                dir="ltr"
              />
            </div>
            <div className="w-28">
              <label className="block text-xs text-gray-500 mb-1">
                {isRu ? 'НДС %' : 'מע"מ %'}
              </label>
              <input
                className="input text-sm"
                type="number"
                min={0}
                max={100}
                value={business.vatRate}
                onChange={(e) => setBusiness({ vatRate: parseFloat(e.target.value) || 18 })}
                dir="ltr"
              />
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-4">
          {isRu ? 'Также пропишите в config.json агента печати' : 'שמור גם ב-config.json של print-agent'}
        </p>
      </div>

      <div className="card p-6">
        <h2 className="font-bold text-gray-900 mb-1">
          {isRu ? 'Кнопки редактирования позиции' : 'כפתורי עריכת פריט'}
        </h2>
        <p className="text-xs text-gray-400 mb-5">
          {isRu
            ? 'Выберите какие кнопки показывать при нажатии на позицию в заказе'
            : 'בחר אילו כפתורים יופיעו בעת לחיצה על פריט בעגלה'}
        </p>
        <div className="space-y-3">
          {actions.map(({ key, labelRu, labelHe }) => (
            <label key={key} className="flex items-center justify-between cursor-pointer">
              <span className="text-sm text-gray-700">{isRu ? labelRu : labelHe}</span>
              <button
                role="switch"
                aria-checked={cartItemActions[key]}
                onClick={() => setCartItemActions({ [key]: !cartItemActions[key] })}
                className={`relative w-10 h-6 rounded-full transition-colors ${
                  cartItemActions[key] ? 'bg-gray-900' : 'bg-gray-200'
                }`}
              >
                <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${
                  cartItemActions[key] ? 'left-5' : 'left-1'
                }`} />
              </button>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const [tab, setTab] = useState<Tab>('menu')

  const isRu = lang === 'ru'
  const isRtl = lang === 'he'

  return (
    <div className="min-h-screen bg-gray-50" dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="bg-white border-b border-gray-100 h-14 px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/hub')}
            className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-500 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
            </svg>
          </button>
          <span className="font-bold text-gray-900 text-sm">
            {isRu ? 'Настройки' : 'הגדרות'}
          </span>
        </div>
        <LangToggle />
      </header>

      <nav className="bg-white border-b border-gray-200 px-6 flex gap-1">
        {([
          ['menu',     isRu ? 'Меню'            : 'תפריט'],
          ['tables',   isRu ? 'Столы'           : 'שולחנות'],
          ['settings', isRu ? 'Настройки кассы' : 'הגדרות קופה'],
        ] as [Tab, string][]).map(([tabKey, label]) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-all ${
              tab === tabKey
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="p-6">
        {tab === 'menu' && <MenuTab />}
        {tab === 'tables' && <TablesTab />}
        {tab === 'settings' && <CashierSettingsTab />}
      </main>
    </div>
  )
}
