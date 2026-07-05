import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  fetchModifierGroupsForItem,
  createModifierGroup,
  updateModifierGroup,
  deleteModifierGroup,

  createModifier,
  updateModifier,
  deleteModifier,
} from './modifiers'
import type { ModifierGroup, Modifier } from './modifiers'
import type { MenuItem } from '../../types'
import ConfirmDialog from '../../components/ui/ConfirmDialog'

interface Props {
  item: MenuItem
  onClose: () => void
}

export default function ModifierEditor({ item, onClose }: Props) {
  const qc = useQueryClient()
  const qKey = ['modifier-groups', item.id]

  const { data: groups = [], isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => fetchModifierGroupsForItem(item.id),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: qKey })

  // ── Group creation ──────────────────────────────────────────
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupRequired, setNewGroupRequired] = useState(false)
  const [newGroupMulti, setNewGroupMulti] = useState(true)
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<ModifierGroup | null>(null)

  const createGroupMutation = useMutation({
    mutationFn: () => createModifierGroup(item.id, newGroupName.trim(), newGroupRequired, newGroupMulti),
    onSuccess: () => {
      invalidate()
      setShowNewGroup(false)
      setNewGroupName('')
      setNewGroupRequired(false)
      setNewGroupMulti(true)
      toast.success('Группа добавлена')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const deleteGroupMutation = useMutation({
    mutationFn: (groupId: string) => deleteModifierGroup(groupId),
    onSuccess: () => { invalidate(); toast.success('Группа удалена') },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold text-gray-900 text-base leading-tight truncate">{item.name}</h2>
            <p className="text-xs text-gray-400 mt-0.5">Группы добавок и модификаторов</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {isLoading && (
            <div className="space-y-3">
              {[1, 2].map((i) => <div key={i} className="h-24 rounded-2xl bg-gray-100 animate-pulse" />)}
            </div>
          )}

          {!isLoading && groups.length === 0 && !showNewGroup && (
            <div className="text-center py-10 text-gray-400">
              <svg className="w-10 h-10 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              <p className="text-sm">Нет групп добавок</p>
              <p className="text-xs mt-1">Добавьте первую группу — например "Добавки" или "Степень прожарки"</p>
            </div>
          )}

          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              menuItemId={item.id}
              onDeleteGroup={() => setConfirmDeleteGroup(group)}
              onUpdated={invalidate}
            />
          ))}

          {/* New group form */}
          {showNewGroup && (
            <div className="card p-4 border-2 border-dashed border-gray-200">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">Новая группа</p>
              <input
                autoFocus
                type="text"
                placeholder="Название группы (напр. «Добавки», «Соус»)"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newGroupName.trim()) createGroupMutation.mutate() }}
                className="input text-sm w-full mb-3"
              />
              <div className="flex items-center gap-4 mb-4">
                <Toggle
                  value={newGroupRequired}
                  onChange={setNewGroupRequired}
                  label="Обязательно выбрать"
                />
                <Toggle
                  value={newGroupMulti}
                  onChange={setNewGroupMulti}
                  label="Несколько вариантов"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => createGroupMutation.mutate()}
                  disabled={!newGroupName.trim() || createGroupMutation.isPending}
                  className="btn-primary text-sm py-2 px-4 flex-1"
                >
                  {createGroupMutation.isPending ? 'Создаём...' : 'Создать группу'}
                </button>
                <button
                  onClick={() => { setShowNewGroup(false); setNewGroupName('') }}
                  className="btn-ghost text-sm py-2 px-3"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 shrink-0">
          {!showNewGroup && (
            <button
              onClick={() => setShowNewGroup(true)}
              className="btn-secondary w-full text-sm py-2.5"
            >
              + Добавить группу добавок
            </button>
          )}
        </div>
      </div>

      {confirmDeleteGroup && (
        <ConfirmDialog
          title={`Удалить группу «${confirmDeleteGroup.name}»?`}
          message="Все модификаторы группы будут удалены"
          confirmLabel="Удалить"
          cancelLabel="Отмена"
          onConfirm={() => { deleteGroupMutation.mutate(confirmDeleteGroup.id); setConfirmDeleteGroup(null) }}
          onCancel={() => setConfirmDeleteGroup(null)}
        />
      )}
    </div>
  )
}

// ── GroupCard ─────────────────────────────────────────────────

interface GroupCardProps {
  group: ModifierGroup
  menuItemId: string
  onDeleteGroup: () => void
  onUpdated: () => void
}

function GroupCard({ group, menuItemId, onDeleteGroup, onUpdated }: GroupCardProps) {
  const qc = useQueryClient()
  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(group.name)
  const [showNewMod, setShowNewMod] = useState(false)
  const [newModName, setNewModName] = useState('')
  const [newModPrice, setNewModPrice] = useState('')

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['modifier-groups', menuItemId] })
    onUpdated()
  }

  const updateGroupMutation = useMutation({
    mutationFn: (updates: { name?: string; required?: boolean; multi?: boolean }) =>
      updateModifierGroup(group.id, updates),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })

  const createModMutation = useMutation({
    mutationFn: () => createModifier(group.id, newModName.trim(), parseFloat(newModPrice) || 0),
    onSuccess: () => {
      invalidate()
      setNewModName('')
      setNewModPrice('')
      setShowNewMod(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="card p-4">
      {/* Group header */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 min-w-0">
          {editingName ? (
            <input
              autoFocus
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              onBlur={() => {
                if (nameVal.trim() && nameVal !== group.name) updateGroupMutation.mutate({ name: nameVal.trim() })
                setEditingName(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { if (nameVal.trim()) updateGroupMutation.mutate({ name: nameVal.trim() }); setEditingName(false) }
                if (e.key === 'Escape') { setNameVal(group.name); setEditingName(false) }
              }}
              className="font-semibold text-gray-900 text-sm bg-transparent border-b border-gray-300 focus:border-gray-900 outline-none w-full"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="font-semibold text-gray-900 text-sm text-left hover:text-gray-600 transition-colors"
            >
              {group.name}
            </button>
          )}
        </div>

        {/* Badges */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => updateGroupMutation.mutate({ required: !group.required })}
            className={`text-[10px] px-2 py-0.5 rounded-lg font-medium border transition-all ${
              group.required
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-400 border-gray-200 hover:border-gray-400'
            }`}
          >
            Обязательно
          </button>
          <button
            onClick={() => updateGroupMutation.mutate({ multi: !group.multi })}
            className={`text-[10px] px-2 py-0.5 rounded-lg font-medium border transition-all ${
              group.multi
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-400 border-gray-200 hover:border-gray-400'
            }`}
          >
            Несколько
          </button>
        </div>

        <button
          onClick={onDeleteGroup}
          className="w-7 h-7 rounded-lg hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-400 transition-colors shrink-0"
          title="Удалить группу"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>

      {/* Modifiers list */}
      <div className="space-y-1 mb-2">
        {group.modifiers.length === 0 && !showNewMod && (
          <p className="text-xs text-gray-400 italic">Нет вариантов — добавьте ниже</p>
        )}
        {group.modifiers.map((mod) => (
          <ModifierRow
            key={mod.id}
            modifier={mod}
            menuItemId={menuItemId}
            onUpdated={invalidate}
          />
        ))}
      </div>

      {/* New modifier inline form */}
      {showNewMod ? (
        <div className="flex items-center gap-2 pt-2 border-t border-gray-50">
          <input
            autoFocus
            type="text"
            placeholder="Название (напр. «Без лука»)"
            value={newModName}
            onChange={(e) => setNewModName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && newModName.trim()) createModMutation.mutate() }}
            className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-900/10 min-w-0"
          />
          <div className="relative shrink-0 w-24">
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">₪</span>
            <input
              type="number"
              min="0"
              step="0.5"
              placeholder="0"
              value={newModPrice}
              onChange={(e) => setNewModPrice(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newModName.trim()) createModMutation.mutate() }}
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 pr-7 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
          </div>
          <button
            onClick={() => createModMutation.mutate()}
            disabled={!newModName.trim() || createModMutation.isPending}
            className="w-8 h-8 rounded-xl bg-gray-900 text-white flex items-center justify-center hover:bg-gray-700 transition-colors disabled:opacity-40 shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </button>
          <button
            onClick={() => { setShowNewMod(false); setNewModName(''); setNewModPrice('') }}
            className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowNewMod(true)}
          className="mt-1 text-xs text-gray-400 hover:text-gray-700 transition-colors flex items-center gap-1"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
          </svg>
          Добавить вариант
        </button>
      )}
    </div>
  )
}

// ── ModifierRow ───────────────────────────────────────────────

interface ModifierRowProps {
  modifier: Modifier
  menuItemId: string
  onUpdated: () => void
}

function ModifierRow({ modifier, menuItemId, onUpdated }: ModifierRowProps) {
  const qc = useQueryClient()
  const [editingName, setEditingName] = useState(false)
  const [editingPrice, setEditingPrice] = useState(false)
  const [nameVal, setNameVal] = useState(modifier.name)
  const [priceVal, setPriceVal] = useState(String(modifier.price_delta))

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['modifier-groups', menuItemId] })
    onUpdated()
  }

  const updateMutation = useMutation({
    mutationFn: (updates: { name?: string; price_delta?: number }) => updateModifier(modifier.id, updates),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteModifier(modifier.id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="flex items-center gap-2 group py-1 px-2 rounded-xl hover:bg-gray-50 transition-colors">
      <div className="w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0" />

      {/* Name */}
      <div className="flex-1 min-w-0">
        {editingName ? (
          <input
            autoFocus
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={() => {
              if (nameVal.trim() && nameVal !== modifier.name) updateMutation.mutate({ name: nameVal.trim() })
              setEditingName(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { if (nameVal.trim()) updateMutation.mutate({ name: nameVal.trim() }); setEditingName(false) }
              if (e.key === 'Escape') { setNameVal(modifier.name); setEditingName(false) }
            }}
            className="text-sm text-gray-800 bg-transparent border-b border-gray-300 focus:border-gray-900 outline-none w-full"
          />
        ) : (
          <button
            onClick={() => setEditingName(true)}
            className="text-sm text-gray-800 text-left hover:text-gray-600 transition-colors truncate block w-full"
          >
            {modifier.name}
          </button>
        )}
      </div>

      {/* Price */}
      <div className="shrink-0">
        {editingPrice ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              type="number"
              min="0"
              step="0.5"
              value={priceVal}
              onChange={(e) => setPriceVal(e.target.value)}
              onBlur={() => {
                const v = parseFloat(priceVal) || 0
                if (v !== modifier.price_delta) updateMutation.mutate({ price_delta: v })
                setEditingPrice(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { updateMutation.mutate({ price_delta: parseFloat(priceVal) || 0 }); setEditingPrice(false) }
                if (e.key === 'Escape') { setPriceVal(String(modifier.price_delta)); setEditingPrice(false) }
              }}
              className="w-16 text-sm text-right border border-gray-200 rounded-lg px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-gray-900/20"
            />
            <span className="text-xs text-gray-400">₪</span>
          </div>
        ) : (
          <button
            onClick={() => setEditingPrice(true)}
            className={`text-sm tabular-nums font-medium transition-colors ${
              modifier.price_delta > 0 ? 'text-emerald-600 hover:text-emerald-700' : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {modifier.price_delta > 0 ? `+${modifier.price_delta} ₪` : 'бесплатно'}
          </button>
        )}
      </div>

      {/* Delete */}
      <button
        onClick={() => deleteMutation.mutate()}
        disabled={deleteMutation.isPending}
        className="w-6 h-6 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-50 flex items-center justify-center text-gray-300 hover:text-red-400 transition-all shrink-0"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

// ── Toggle helper ─────────────────────────────────────────────

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative w-9 h-5 rounded-full transition-colors ${value ? 'bg-gray-900' : 'bg-gray-200'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
      <span className="text-xs text-gray-600">{label}</span>
    </label>
  )
}
