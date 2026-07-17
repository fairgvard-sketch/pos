import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  fetchModifierGroups, createModifierGroup, updateModifierGroup, deleteModifierGroup,
  createModifier, updateModifier, deleteModifier, fetchModifierGroupUsage,
  fetchModifierSupplies, replaceModifierSupplies, type ModifierSupply,
} from './api'
import { fetchSupplyItems, type SupplyItem } from '../inventory/api'
import { useLangStore } from '../../store/langStore'
import { t, type Lang } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { ModifierGroup } from '../../types'
import InlineRename from '../../components/InlineRename'
import ConfirmDeleteButton from '../../components/ConfirmDeleteButton'

export default function ModifierGroupsTab() {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const { data: groups = [] } = useQuery({ queryKey: ['modifier_groups'], queryFn: fetchModifierGroups })
  const { data: usage = {} } = useQuery({ queryKey: ['modifier_group_usage'], queryFn: fetchModifierGroupUsage })
  const { data: supplyItems = [] } = useQuery({ queryKey: ['supply_items'], queryFn: fetchSupplyItems })
  const { data: modSupplies = [] } = useQuery({ queryKey: ['modifier_supplies'], queryFn: fetchModifierSupplies })

  const suppliesByMod = useMemo(() => {
    const map = new Map<string, ModifierSupply[]>()
    for (const ms of modSupplies) {
      const list = map.get(ms.modifier_id) ?? []
      list.push(ms)
      map.set(ms.modifier_id, list)
    }
    return map
  }, [modSupplies])

  const [newGroupName, setNewGroupName] = useState('')
  // Раскрыта одна группа за раз — с большим количеством групп экран не разрастается
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Редактор расхода открыт для одного модификатора за раз
  const [recipeModId, setRecipeModId] = useState<string | null>(null)

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
                <div className="flex items-center justify-between mb-3 gap-3">
                  <InlineRename
                    value={g.name}
                    placeholder={t(lang, 'groupName')}
                    className="text-sm font-semibold text-gray-700"
                    onSave={(name) => patchGroup.mutate({ id: g.id, patch: { name } })}
                  />
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
                    <ConfirmDeleteButton onConfirm={() => removeGroup.mutate(g.id)} />
                  </div>
                </div>

                <div className="space-y-1.5">
                  {(g.modifiers ?? []).map((m) => {
                    const links = suppliesByMod.get(m.id) ?? []
                    return (
                      <div key={m.id}>
                        <div className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-gray-50">
                          <span className="flex-1 text-sm text-gray-800">{m.name}</span>
                          <span className="text-sm text-gray-500 tabular-nums">
                            {m.price_delta === 0 ? '—' : `+${formatMoney(m.price_delta, lang)}`}
                          </span>
                          {supplyItems.length > 0 && (
                            <button
                              onClick={() => setRecipeModId(recipeModId === m.id ? null : m.id)}
                              className={`text-[10px] px-2 py-1 rounded-full font-semibold transition-all ${
                                links.length > 0
                                  ? 'bg-gray-900 text-white'
                                  : 'bg-white border border-gray-200 text-gray-400 hover:border-gray-400'
                              }`}
                              title={t(lang, 'modRecipeHint')}
                            >
                              {t(lang, 'modRecipeBtn')}{links.length > 0 ? ` · ${links.length}` : ''}
                            </button>
                          )}
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
                          <ConfirmDeleteButton onConfirm={() => removeModifier.mutate(m.id)} className="text-gray-300 hover:text-red-500 text-sm" />
                        </div>
                        {recipeModId === m.id && (
                          <ModifierRecipeEditor
                            lang={lang}
                            modifierId={m.id}
                            links={links}
                            supplyItems={supplyItems}
                            onClose={() => setRecipeModId(null)}
                          />
                        )}
                      </div>
                    )
                  })}
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

/**
 * Расход модификатора (076): что списывать со склада при продаже с этой
 * опцией — сироп 20 мл, доп. шот 9 г зерна. qty в базовых единицах
 * расходника (шт/г/мл), сохранение — полной пересинхронизацией.
 */
function ModifierRecipeEditor({
  lang, modifierId, links, supplyItems, onClose,
}: {
  lang: Lang
  modifierId: string
  links: ModifierSupply[]
  supplyItems: SupplyItem[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [drafts, setDrafts] = useState(() =>
    links.map((l) => ({ supplyItemId: l.supply_item_id, qtyStr: String(l.qty) }))
  )

  const save = useMutation({
    mutationFn: () =>
      replaceModifierSupplies(
        modifierId,
        drafts
          .filter((d) => d.supplyItemId)
          .map((d) => ({
            supply_item_id: d.supplyItemId,
            qty: Math.min(99999, Math.max(1, parseInt(d.qtyStr, 10) || 1)),
          }))
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['modifier_supplies'] })
      toast.success(t(lang, 'saved'))
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })

  function unitOf(supplyItemId: string): string {
    return supplyItems.find((s) => s.id === supplyItemId)?.unit ?? ''
  }

  return (
    <div className="mt-1.5 ms-4 p-3 rounded-lg border border-gray-200 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-gray-500">{t(lang, 'modRecipeHint')}</span>
        <button
          type="button"
          onClick={() => setDrafts((ds) => [...ds, { supplyItemId: supplyItems[0].id, qtyStr: '1' }])}
          className="text-sm font-semibold text-gray-900 hover:underline whitespace-nowrap"
        >
          {t(lang, 'packagingAddBtn')}
        </button>
      </div>
      {drafts.map((d, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <select
            className="input flex-1 !py-2 !text-sm"
            value={d.supplyItemId}
            onChange={(e) => setDrafts((ds) => ds.map((x, i) => (i === idx ? { ...x, supplyItemId: e.target.value } : x)))}
          >
            {!supplyItems.some((s) => s.id === d.supplyItemId) && <option value={d.supplyItemId}>—</option>}
            {supplyItems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input
            className="input !w-20 !py-2 !text-sm tabular-nums text-center"
            inputMode="numeric"
            value={d.qtyStr}
            onChange={(e) => setDrafts((ds) => ds.map((x, i) => (i === idx ? { ...x, qtyStr: e.target.value.replace(/\D/g, '') } : x)))}
          />
          <span className="w-8 text-xs text-gray-500 shrink-0">{unitOf(d.supplyItemId)}</span>
          <button
            type="button"
            onClick={() => setDrafts((ds) => ds.filter((_, i) => i !== idx))}
            className="text-gray-300 hover:text-red-500 text-sm shrink-0"
          >
            ✕
          </button>
        </div>
      ))}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="btn-ghost !py-1.5 !text-xs">{t(lang, 'cancel')}</button>
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="btn-primary !py-1.5 !px-4 !text-xs disabled:opacity-40"
        >
          {t(lang, 'save')}
        </button>
      </div>
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
