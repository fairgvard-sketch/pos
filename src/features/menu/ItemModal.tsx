import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { createItem, updateItem, fetchModifierGroups, fetchStations, fetchCategories, type ItemInput } from './api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { parseMoney } from '../../lib/money'
import type { MenuItem } from '../../types'

interface VariantDraft {
  name: string
  priceStr: string
  is_default: boolean
}

interface Props {
  item: MenuItem | null
  defaultCategoryId: string
  onClose: () => void
}

export default function ItemModal({ item, defaultCategoryId, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const { data: categories = [] } = useQuery({ queryKey: ['menu_categories'], queryFn: fetchCategories })
  const { data: groups = [] } = useQuery({ queryKey: ['modifier_groups'], queryFn: fetchModifierGroups })
  const { data: stations = [] } = useQuery({ queryKey: ['stations'], queryFn: fetchStations })

  const [name, setName] = useState(item?.name ?? '')
  const [priceStr, setPriceStr] = useState(item ? (item.price / 100).toString() : '')
  const [categoryId, setCategoryId] = useState(item?.category_id ?? defaultCategoryId)
  const [stationId, setStationId] = useState<string>(item?.station_id ?? '')
  const [isAvailable, setIsAvailable] = useState(item?.is_available ?? true)
  const [askModifiers, setAskModifiers] = useState(item?.ask_modifiers ?? false)
  const [variants, setVariants] = useState<VariantDraft[]>(
    (item?.item_variants ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((v) => ({ name: v.name, priceStr: (v.price / 100).toString(), is_default: v.is_default }))
  )
  const [groupIds, setGroupIds] = useState<string[]>(
    (item?.menu_item_modifier_groups ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((g) => g.group_id)
  )

  const save = useMutation({
    mutationFn: async (input: ItemInput) => {
      if (item) await updateItem(item.id, input)
      else await createItem(input)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu_items'] })
      toast.success(t(lang, 'saved'))
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })

  const hasVariants = variants.some((v) => v.name.trim())

  function handleSave() {
    const parsedVariants = []
    for (const v of variants) {
      if (!v.name.trim()) continue
      const vp = parseMoney(v.priceStr || '0')
      if (vp === null) {
        toast.error(`${t(lang, 'variantName')}: ${v.name}`)
        return
      }
      parsedVariants.push({ name: v.name.trim(), price: vp, is_default: v.is_default })
    }

    // Есть размеры → цена товара берётся из размера по умолчанию,
    // отдельное поле «Цена» не используется
    let price: number | null
    if (parsedVariants.length > 0) {
      price = (parsedVariants.find((v) => v.is_default) ?? parsedVariants[0]).price
    } else {
      price = parseMoney(priceStr || '0')
      if (price === null) {
        toast.error(t(lang, 'itemPrice'))
        return
      }
    }

    save.mutate({
      name: name.trim(),
      category_id: categoryId,
      station_id: stationId || null,
      price,
      is_available: isAvailable,
      ask_modifiers: askModifiers,
      variants: parsedVariants,
      modifier_group_ids: groupIds,
    })
  }

  function toggleGroup(id: string) {
    setGroupIds((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]))
  }

  return (
    // Клик по фону НЕ закрывает окно — защита от потери введённых данных
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="card w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4">
        <h2 className="text-lg font-bold text-gray-900">
          {t(lang, item ? 'editItem' : 'newItem')}
        </h2>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'itemName')}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'category')}</label>
            <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'station')}</label>
            <select className="input" value={stationId} onChange={(e) => setStationId(e.target.value)}>
              <option value="">{t(lang, 'noStation')}</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Цена товара — только если нет размеров; с размерами цена у каждого размера */}
          {!hasVariants && (
            <div>
              <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'itemPrice')}</label>
              <input
                className="input tabular-nums"
                inputMode="decimal"
                value={priceStr}
                onChange={(e) => setPriceStr(e.target.value)}
              />
            </div>
          )}

          <div className="flex items-end gap-4 pb-1">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={isAvailable} onChange={(e) => setIsAvailable(e.target.checked)} />
              {t(lang, 'available')}
            </label>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={askModifiers} onChange={(e) => setAskModifiers(e.target.checked)} />
          {t(lang, 'askModifiers')}
        </label>

        {/* Варианты (размеры) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-500">{t(lang, 'variants')}</span>
            <button
              type="button"
              onClick={() => setVariants((v) => [...v, { name: '', priceStr: '', is_default: v.length === 0 }])}
              className="btn-ghost !py-1 !text-xs"
            >
              {t(lang, 'addVariant')}
            </button>
          </div>
          {variants.map((v, idx) => (
            <div key={idx} className="flex items-center gap-2 mb-2">
              <input
                className="input !py-2 flex-1"
                placeholder={t(lang, 'variantName')}
                value={v.name}
                onChange={(e) => setVariants((vs) => vs.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))}
              />
              <input
                className="input !py-2 w-24 tabular-nums"
                inputMode="decimal"
                placeholder="₪"
                value={v.priceStr}
                onChange={(e) => setVariants((vs) => vs.map((x, i) => (i === idx ? { ...x, priceStr: e.target.value } : x)))}
              />
              <label className="flex items-center gap-1 text-xs text-gray-500 whitespace-nowrap">
                <input
                  type="radio"
                  name="default-variant"
                  checked={v.is_default}
                  onChange={() => setVariants((vs) => vs.map((x, i) => ({ ...x, is_default: i === idx })))}
                />
                {t(lang, 'defaultLabel')}
              </label>
              <button
                type="button"
                onClick={() => setVariants((vs) => vs.filter((_, i) => i !== idx))}
                className="text-gray-300 hover:text-red-500"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Группы модификаторов */}
        {groups.length > 0 && (
          <div>
            <span className="text-xs font-medium text-gray-500 mb-2 block">{t(lang, 'modifierGroups')}</span>
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => toggleGroup(g.id)}
                  className={groupIds.includes(g.id) ? 'badge-blue !py-1.5 !px-3' : 'badge-gray !py-1.5 !px-3'}
                >
                  {g.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button onClick={handleSave} disabled={!name.trim() || save.isPending} className="btn-primary flex-1">
            {t(lang, 'save')}
          </button>
          <button onClick={onClose} className="btn-secondary">
            {t(lang, 'cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
