import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  fetchModifierGroups, createModifierGroup, updateModifierGroup, deleteModifierGroup,
  createModifier, updateModifier, deleteModifier, fetchModifierGroupUsage,
} from './api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { ModifierGroup } from '../../types'

export default function ModifierGroupsTab() {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const { data: groups = [] } = useQuery({ queryKey: ['modifier_groups'], queryFn: fetchModifierGroups })
  const { data: usage = {} } = useQuery({ queryKey: ['modifier_group_usage'], queryFn: fetchModifierGroupUsage })

  const [newGroupName, setNewGroupName] = useState('')
  // Раскрыта одна группа за раз — с большим количеством групп экран не разрастается
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['modifier_groups'] })

  const addGroup = useMutation({
    mutationFn: () => createModifierGroup(newGroupName.trim(), 0, 0),
    onSuccess: (g) => { setNewGroupName(''); setExpandedId(g.id); invalidate() },
    onError: (e) => toast.error(e.message),
  })
  const removeGroup = useMutation({
    mutationFn: deleteModifierGroup,
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['modifier_group_usage'] })
      toast.success(t(lang, 'deleted'))
    },
    onError: (e) => toast.error(e.message),
  })
  const patchGroup = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateModifierGroup>[1] }) =>
      updateModifierGroup(id, patch),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })
  const addModifier = useMutation({
    mutationFn: ({ groupId, name, delta }: { groupId: string; name: string; delta: number }) =>
      createModifier(groupId, name, delta, false),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })
  const patchModifier = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof updateModifier>[1] }) =>
      updateModifier(id, patch),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })
  const removeModifier = useMutation({
    mutationFn: deleteModifier,
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })

  /** «По умолч.» в группах с макс. выбором 1 — эксклюзивный: включаем один, гасим остальные */
  async function toggleDefault(group: ModifierGroup, modId: string, value: boolean) {
    if (value && group.max_select === 1) {
      const others = (group.modifiers ?? []).filter((m) => m.id !== modId && m.is_default)
      for (const o of others) {
        await updateModifier(o.id, { is_default: false })
      }
    }
    patchModifier.mutate({ id: modId, patch: { is_default: value } })
  }

  return (
    <div className="space-y-3 max-w-3xl">
      <form
        onSubmit={(e) => { e.preventDefault(); if (newGroupName.trim()) addGroup.mutate() }}
        className="flex gap-2"
      >
        <input
          className="input"
          placeholder={t(lang, 'groupName')}
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
        />
        <button type="submit" disabled={!newGroupName.trim() || addGroup.isPending} className="btn-primary whitespace-nowrap">
          {t(lang, 'newGroup')}
        </button>
      </form>

      {groups.map((g) => {
        const expanded = expandedId === g.id
        const usedIn = usage[g.id] ?? 0
        return (
          <div key={g.id} className="card overflow-hidden">
            {/* Строка-заголовок: всегда видна, кликом раскрывается */}
            <button
              onClick={() => setExpandedId(expanded ? null : g.id)}
              className="w-full flex items-center gap-3 px-5 py-3.5 text-start hover:bg-gray-50 transition-colors"
            >
              <span className={`text-gray-300 text-xs transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
              <span className="font-bold text-gray-900 flex-1">{g.name}</span>
              <span className="text-xs text-gray-400">
                {(g.modifiers ?? []).map((m) => m.name).slice(0, 4).join(' · ')}
                {(g.modifiers?.length ?? 0) > 4 && ` +${g.modifiers!.length - 4}`}
              </span>
              <span className={usedIn > 0 ? 'badge-blue' : 'badge-gray'}>
                {usedIn} {t(lang, 'itemsShort')}
              </span>
            </button>

            {expanded && (
              <div className="px-5 pb-5 border-t border-gray-100 pt-4">
                <div className="flex items-center justify-between mb-3">
                  <button
                    className="text-sm text-gray-500 hover:text-gray-900 hover:underline"
                    onClick={() => {
                      const name = prompt(t(lang, 'groupName'), g.name)
                      if (name?.trim()) patchGroup.mutate({ id: g.id, patch: { name: name.trim() } })
                    }}
                  >
                    ✎ {g.name}
                  </button>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-gray-400 flex items-center gap-1">
                      {t(lang, 'minSelect')}
                      <input
                        type="number" min={0} className="input !w-14 !py-1 !px-2 !text-xs"
                        defaultValue={g.min_select}
                        onBlur={(e) => patchGroup.mutate({ id: g.id, patch: { min_select: Number(e.target.value) || 0 } })}
                      />
                    </label>
                    <label className="text-xs text-gray-400 flex items-center gap-1">
                      {t(lang, 'maxSelect')}
                      <input
                        type="number" min={0} className="input !w-14 !py-1 !px-2 !text-xs"
                        defaultValue={g.max_select}
                        onBlur={(e) => patchGroup.mutate({ id: g.id, patch: { max_select: Number(e.target.value) || 0 } })}
                      />
                    </label>
                    <button
                      onClick={() => confirm(t(lang, 'confirmDelete')) && removeGroup.mutate(g.id)}
                      className="text-gray-300 hover:text-red-500"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  {(g.modifiers ?? []).map((m) => (
                    <div key={m.id} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-gray-50">
                      <span className="flex-1 text-sm text-gray-800">{m.name}</span>
                      <span className="text-sm text-gray-500 tabular-nums">
                        {m.price_delta === 0 ? '—' : `+${formatMoney(m.price_delta, lang)}`}
                      </span>
                      <button
                        onClick={() => toggleDefault(g, m.id, !m.is_default)}
                        className={`text-[10px] px-2 py-1 rounded-full font-semibold transition-all ${
                          m.is_default
                            ? 'bg-emerald-500 text-white'
                            : 'bg-white border border-gray-200 text-gray-400 hover:border-gray-400'
                        }`}
                        title={t(lang, 'defaultLabel')}
                      >
                        {m.is_default ? '✓ ' : ''}{t(lang, 'defaultLabel')}
                      </button>
                      <button onClick={() => removeModifier.mutate(m.id)} className="text-gray-300 hover:text-red-500 text-sm">✕</button>
                    </div>
                  ))}
                </div>

                <AddModifierForm onAdd={(name, delta) => addModifier.mutate({ groupId: g.id, name, delta })} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function AddModifierForm({ onAdd }: { onAdd: (name: string, delta: number) => void }) {
  const lang = useLangStore((s) => s.lang)
  const [modName, setModName] = useState('')
  const [modDelta, setModDelta] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const delta = modDelta.trim() === '' ? 0 : parseMoney(modDelta.replace('+', ''))
    if (delta === null) {
      toast.error(t(lang, 'priceDelta'))
      return
    }
    if (!modName.trim()) return
    onAdd(modName.trim(), delta)
    setModName('')
    setModDelta('')
  }

  return (
    <form onSubmit={submit} className="flex gap-2 mt-3">
      <input
        className="input !py-2 flex-1"
        placeholder={t(lang, 'modifierName')}
        value={modName}
        onChange={(e) => setModName(e.target.value)}
      />
      <input
        className="input !py-2 w-24 tabular-nums"
        inputMode="decimal"
        placeholder={t(lang, 'priceDelta')}
        value={modDelta}
        onChange={(e) => setModDelta(e.target.value)}
      />
      <button type="submit" disabled={!modName.trim()} className="btn-secondary !py-2 whitespace-nowrap">
        {t(lang, 'add')}
      </button>
    </form>
  )
}
