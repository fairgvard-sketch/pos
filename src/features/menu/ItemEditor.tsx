import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  createItem, updateItem, deleteItem, uploadItemImage,
  fetchModifierGroups, fetchStations, fetchCategories,
  createModifierGroup,
  type ItemInput,
} from './api'
import { fetchCurrentLocation } from '../auth/api'
import { fetchSupplyItems, costDivisor } from '../inventory/api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { MenuItem, ModifierGroup } from '../../types'
import ItemPreview from './ItemPreview'
import BackButton from '../../components/BackButton'

interface VariantDraft {
  name: string
  priceStr: string
  is_default: boolean
}

/** Строка упаковки: variantIdx — позиция в variants, null = весь товар */
interface SupplyLinkDraft {
  variantIdx: number | null
  supplyItemId: string
  qtyStr: string
  takeawayOnly: boolean
}

interface Props {
  /** null = создание нового товара */
  item: MenuItem | null
  defaultCategoryId: string
  onSaved: (id: string) => void
  onDeleted: () => void
  onBack: () => void
}

/** Полноэкранный редактор товара (родитель передаёт key={item.id} для сброса формы) */
export default function ItemEditor({ item, defaultCategoryId, onSaved, onDeleted, onBack }: Props) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: categories = [] } = useQuery({ queryKey: ['menu_categories'], queryFn: fetchCategories })
  const { data: groups = [] } = useQuery({ queryKey: ['modifier_groups'], queryFn: fetchModifierGroups })
  const { data: stations = [] } = useQuery({ queryKey: ['stations'], queryFn: fetchStations })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  // Учёт остатков выключен тумблером точки — секцию «Склад» не показываем,
  // уже сохранённые track_inventory/cost/sku при этом не трогаем
  const inventoryEnabled = location?.settings?.interface?.inventory_enabled !== false

  const [name, setName] = useState(item?.name ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [priceStr, setPriceStr] = useState(item ? (item.price / 100).toString() : '')
  const [categoryId, setCategoryId] = useState(item?.category_id ?? defaultCategoryId)
  const [stationId, setStationId] = useState(item?.station_id ?? '')
  const [imageUrl, setImageUrl] = useState<string | null>(item?.image_url ?? null)
  const [uploading, setUploading] = useState(false)
  const [isAvailable, setIsAvailable] = useState(item?.is_available ?? true)
  const [isFavorite, setIsFavorite] = useState(item?.is_favorite ?? false)
  const [askModifiers, setAskModifiers] = useState(item?.ask_modifiers ?? false)
  const [variants, setVariants] = useState<VariantDraft[]>(() =>
    (item?.item_variants ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((v) => ({ name: v.name, priceStr: (v.price / 100).toString(), is_default: v.is_default }))
  )
  const [groupIds, setGroupIds] = useState<string[]>(() =>
    (item?.menu_item_modifier_groups ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((g) => g.group_id)
  )
  const [trackInventory, setTrackInventory] = useState(item?.track_inventory ?? false)
  const [costStr, setCostStr] = useState(item?.cost != null ? (item.cost / 100).toString() : '')
  const [sku, setSku] = useState(item?.sku ?? '')
  const [stockStr, setStockStr] = useState(item?.stock != null ? String(item.stock) : '')
  const [supplyLinks, setSupplyLinks] = useState<SupplyLinkDraft[]>(() => {
    const sorted = (item?.item_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
    const idxByVariant = new Map(sorted.map((v, i) => [v.id, i]))
    return (item?.variant_supplies ?? []).flatMap((vs) => {
      const variantIdx = vs.variant_id === null ? null : idxByVariant.get(vs.variant_id)
      if (variantIdx === undefined) return [] // связка на уже несуществующий вариант
      return [{ variantIdx, supplyItemId: vs.supply_item_id, qtyStr: String(vs.qty), takeawayOnly: vs.takeaway_only }]
    })
  })
  const { data: supplyItems = [] } = useQuery({
    queryKey: ['supply_items'],
    queryFn: fetchSupplyItems,
    enabled: inventoryEnabled,
  })

  const hasVariants = variants.some((v) => v.name.trim())

  /** Удаление варианта сдвигает индексы — строки упаковки едут следом */
  function removeVariant(idx: number) {
    setVariants((vs) => vs.filter((_, i) => i !== idx))
    setSupplyLinks((ls) => ls
      .filter((l) => l.variantIdx !== idx)
      .map((l) => (l.variantIdx !== null && l.variantIdx > idx ? { ...l, variantIdx: l.variantIdx - 1 } : l)))
  }

  const save = useMutation({
    mutationFn: async (input: ItemInput) => {
      if (item) {
        await updateItem(item.id, input)
        return item.id
      }
      return createItem(input)
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ['menu_items'] })
      qc.invalidateQueries({ queryKey: ['modifier_group_usage'] })
      toast.success(t(lang, 'saved'))
      onSaved(id)
    },
    onError: (e) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: () => deleteItem(item!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu_items'] })
      toast.success(t(lang, 'deleted'))
      onDeleted()
    },
    onError: (e) => toast.error(e.message),
  })

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const url = await uploadItemImage(file)
      setImageUrl(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  function handleSave() {
    const parsedVariants = []
    // Пустые варианты пропускаются → индексы едут; map драфт → payload
    const variantPayloadIdx = new Map<number, number>()
    for (const [i, v] of variants.entries()) {
      if (!v.name.trim()) continue
      const vp = parseMoney(v.priceStr || '0')
      if (vp === null) {
        toast.error(`${t(lang, 'variantName')}: ${v.name}`)
        return
      }
      variantPayloadIdx.set(i, parsedVariants.length)
      parsedVariants.push({ name: v.name.trim(), price: vp, is_default: v.is_default })
    }

    const supplies: ItemInput['supplies'] = []
    for (const l of supplyLinks) {
      if (!l.supplyItemId) continue
      let variantIndex: number | null = null
      if (l.variantIdx !== null) {
        const mapped = variantPayloadIdx.get(l.variantIdx)
        if (mapped === undefined) continue // вариант пуст/удалён — связке не к чему крепиться
        variantIndex = mapped
      }
      supplies.push({
        variant_index: variantIndex,
        supply_item_id: l.supplyItemId,
        qty: Math.min(99999, Math.max(1, parseInt(l.qtyStr, 10) || 1)),
        takeaway_only: l.takeawayOnly,
      })
    }

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

    const cost = costStr.trim() ? parseMoney(costStr) : null
    if (costStr.trim() && cost === null) {
      toast.error(t(lang, 'costLabel'))
      return
    }

    save.mutate({
      name: name.trim(),
      description: description.trim() || null,
      category_id: categoryId,
      station_id: stationId || null,
      price,
      image_url: imageUrl,
      is_available: isAvailable,
      is_favorite: isFavorite,
      ask_modifiers: askModifiers,
      cost,
      sku: sku.trim() || null,
      track_inventory: trackInventory,
      stock: stockStr.trim() === '' ? null : Math.max(0, parseInt(stockStr, 10) || 0),
      variants: parsedVariants,
      modifier_group_ids: groupIds,
      supplies,
    })
  }

  const attachedGroups = groupIds
    .map((id) => groups.find((g) => g.id === id))
    .filter((g): g is ModifierGroup => !!g)

  /** Себестоимость рецепта варианта: Σ qty × cost, для г/мл cost — за кг/л */
  function recipeCost(variantIdx: number | null): number | null {
    let sum = 0
    let known = false
    for (const l of supplyLinks) {
      if (l.variantIdx !== null && l.variantIdx !== variantIdx) continue
      const s = supplyItems.find((x) => x.id === l.supplyItemId)
      if (!s || s.cost == null) continue
      sum += Math.round(((parseInt(l.qtyStr, 10) || 0) * s.cost) / costDivisor(s.unit))
      known = true
    }
    return known ? sum : null
  }

  const recipeCostParts = (hasVariants
    ? variants.map((v, i) => ({ name: v.name, cost: recipeCost(i) }))
        .filter((p) => p.name.trim() !== '')
    : [{ name: '', cost: recipeCost(null) }]
  ).filter((p): p is { name: string; cost: number } => p.cost != null && p.cost > 0)

  return (
    <>
      {/* ── Редактор ─────────────────────────────── */}
      <main className="flex-1 min-w-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        {/* Шапка */}
        <div className="px-8 pt-5 shrink-0">
          <div className="flex items-center justify-between">
            <BackButton onClick={onBack} />
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer">
                {t(lang, 'available')}
                <Toggle on={isAvailable} onChange={setIsAvailable} />
              </label>
              <button
                onClick={() => setIsFavorite(!isFavorite)}
                className={`text-xl transition-colors ${isFavorite ? 'text-amber-400' : 'text-gray-200 hover:text-amber-300'}`}
                title={t(lang, 'favorites')}
              >
                ★
              </button>
            </div>
          </div>
          <h1 className="text-2xl font-black text-gray-900 mt-2">
            {t(lang, item ? 'editItem' : 'newItem')}
          </h1>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6 space-y-8">
          {/* ── Основное ── */}
          <section>
            <SectionTitle>{t(lang, 'basicInfo')}</SectionTitle>
            <div className="flex gap-5">
              <div className="flex-1 grid grid-cols-3 gap-3 content-start">
                <div className="col-span-3 sm:col-span-1">
                  <FieldLabel>{t(lang, 'itemName')}</FieldLabel>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <FieldLabel>{t(lang, 'category')}</FieldLabel>
                  <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                {!hasVariants ? (
                  <div>
                    <FieldLabel>{t(lang, 'itemPrice')}</FieldLabel>
                    <input
                      className="input tabular-nums"
                      inputMode="decimal"
                      value={priceStr}
                      onChange={(e) => setPriceStr(e.target.value)}
                    />
                  </div>
                ) : (
                  <div>
                    <FieldLabel>{t(lang, 'station')}</FieldLabel>
                    <select className="input" value={stationId} onChange={(e) => setStationId(e.target.value)}>
                      <option value="">{t(lang, 'noStation')}</option>
                      {stations.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {!hasVariants && (
                  <div>
                    <FieldLabel>{t(lang, 'station')}</FieldLabel>
                    <select className="input" value={stationId} onChange={(e) => setStationId(e.target.value)}>
                      <option value="">{t(lang, 'noStation')}</option>
                      {stations.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="col-span-3 sm:col-span-2">
                  <div className="flex justify-between">
                    <FieldLabel>{t(lang, 'descriptionLabel')}</FieldLabel>
                    <span className="text-[11px] text-gray-300 tabular-nums">{description.length}/120</span>
                  </div>
                  <input
                    className="input"
                    maxLength={120}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>

              {/* Фото */}
              <div className="w-44 shrink-0">
                <FieldLabel>{t(lang, 'imageLabel')}</FieldLabel>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleUpload(f)
                    e.target.value = ''
                  }}
                />
                {imageUrl ? (
                  <div className="relative group">
                    <img src={imageUrl} alt="" className="w-full aspect-square object-cover rounded-2xl border border-gray-100" />
                    <button
                      onClick={() => setImageUrl(null)}
                      className="absolute top-2 end-2 w-7 h-7 rounded-lg bg-white/90 text-gray-500 hover:text-red-500
                                 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                      title={t(lang, 'delete')}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="w-full aspect-square rounded-2xl border-2 border-dashed border-gray-200 text-gray-300
                               hover:border-gray-400 hover:text-gray-500 transition-colors flex flex-col items-center
                               justify-center gap-1 text-xs font-semibold"
                  >
                    <span className="text-2xl">+</span>
                    {uploading ? t(lang, 'uploading') : t(lang, 'uploadImage')}
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* ── Размеры ── */}
          <section>
            <div className="flex items-center gap-3 mb-3">
              <SectionTitle noMargin>{t(lang, 'variants')}</SectionTitle>
              <button
                type="button"
                onClick={() => setVariants((v) => [...v, { name: '', priceStr: '', is_default: v.length === 0 }])}
                className="btn-ghost !py-1 !text-xs"
              >
                {t(lang, 'addVariant')}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {variants.map((v, idx) => (
                <div
                  key={idx}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${
                    v.is_default ? 'border-gray-900' : 'border-gray-200'
                  }`}
                >
                  <input
                    className="w-24 text-sm font-semibold outline-none bg-transparent"
                    placeholder={t(lang, 'variantName')}
                    value={v.name}
                    onChange={(e) => setVariants((vs) => vs.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))}
                  />
                  <input
                    className="w-16 text-sm text-gray-500 tabular-nums outline-none bg-transparent text-end"
                    inputMode="decimal"
                    placeholder="₪"
                    value={v.priceStr}
                    onChange={(e) => setVariants((vs) => vs.map((x, i) => (i === idx ? { ...x, priceStr: e.target.value } : x)))}
                  />
                  <button
                    type="button"
                    title={t(lang, 'defaultLabel')}
                    onClick={() => setVariants((vs) => vs.map((x, i) => ({ ...x, is_default: i === idx })))}
                    className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center transition-colors ${
                      v.is_default ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-300 hover:bg-gray-200'
                    }`}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeVariant(idx)}
                    className="text-gray-300 hover:text-red-500 text-sm"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* ── Опции (модификаторы) ── */}
          <section>
            <SectionTitle>{t(lang, 'modifierGroups')}</SectionTitle>

            {/* Только названия — содержимое групп видно в предпросмотре справа */}
            <div className="flex flex-wrap items-center gap-2">
              {attachedGroups.map((g) => (
                <span
                  key={g.id}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-900 text-sm font-semibold text-gray-900"
                >
                  {g.name}
                  <span className={g.min_select > 0 ? 'badge-blue !text-[10px]' : 'badge-gray !text-[10px]'}>
                    {t(lang, g.min_select > 0 ? 'requiredLabel' : 'optionalLabel')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setGroupIds((prev) => prev.filter((x) => x !== g.id))}
                    title={t(lang, 'delete')}
                    className="text-gray-300 hover:text-red-500 text-xs"
                  >
                    ✕
                  </button>
                </span>
              ))}

              {/* Добавить группу: из существующих или создать новую */}
              <AddGroupControl
                lang={lang}
                available={groups.filter((g) => !groupIds.includes(g.id))}
                onAttach={(id) => setGroupIds((prev) => [...prev, id])}
                onCreate={async (gName) => {
                  const g = await createModifierGroup(gName, 0, 0)
                  qc.invalidateQueries({ queryKey: ['modifier_groups'] })
                  setGroupIds((prev) => [...prev, g.id])
                }}
              />
            </div>

            {attachedGroups.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer mt-4">
                <input type="checkbox" checked={askModifiers} onChange={(e) => setAskModifiers(e.target.checked)} />
                {t(lang, 'askModifiers')}
              </label>
            )}
          </section>

          {/* ── Склад ── */}
          {inventoryEnabled && (
          <section>
            <div className="flex items-center gap-3 mb-3">
              <SectionTitle noMargin>{t(lang, 'inventory')}</SectionTitle>
              <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                {t(lang, 'trackInventory')}
                <Toggle on={trackInventory} onChange={setTrackInventory} small />
              </label>
            </div>
            {trackInventory && (
              <div className="grid grid-cols-3 gap-3 max-w-lg">
                <div>
                  <FieldLabel>{t(lang, 'costLabel')}</FieldLabel>
                  <input className="input tabular-nums" inputMode="decimal" value={costStr} onChange={(e) => setCostStr(e.target.value)} />
                </div>
                <div>
                  <FieldLabel>{t(lang, 'skuLabel')}</FieldLabel>
                  <input className="input" value={sku} onChange={(e) => setSku(e.target.value)} />
                </div>
                <div>
                  <FieldLabel>{t(lang, 'stockLabel')}</FieldLabel>
                  <input
                    className="input tabular-nums"
                    inputMode="numeric"
                    placeholder={t(lang, 'unlimitedLabel')}
                    value={stockStr}
                    onChange={(e) => setStockStr(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
              </div>
            )}
          </section>
          )}

          {/* ── Упаковка: расходники, списываемые продажей (075) ── */}
          {inventoryEnabled && (
          <section>
            <div className="flex items-center gap-3 mb-1">
              <SectionTitle noMargin>{t(lang, 'packagingTitle')}</SectionTitle>
              {supplyItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSupplyLinks((ls) => [
                    ...ls,
                    { variantIdx: null, supplyItemId: supplyItems[0].id, qtyStr: '1', takeawayOnly: true },
                  ])}
                  className="btn-ghost !py-1 !text-xs"
                >
                  {t(lang, 'packagingAddBtn')}
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 mb-3">
              {t(lang, supplyItems.length === 0 ? 'packagingNoSupplies' : 'packagingHint')}
            </p>
            {supplyLinks.length > 0 && (
              <div className="space-y-2 max-w-2xl">
                {supplyLinks.map((l, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    {hasVariants && (
                      <select
                        className="input !w-36 !py-2 !text-sm shrink-0"
                        value={l.variantIdx ?? ''}
                        onChange={(e) => setSupplyLinks((ls) => ls.map((x, i) =>
                          i === idx ? { ...x, variantIdx: e.target.value === '' ? null : Number(e.target.value) } : x))}
                      >
                        <option value="">{t(lang, 'packagingAllVariants')}</option>
                        {variants.map((v, vi) => (v.name.trim() ? <option key={vi} value={vi}>{v.name}</option> : null))}
                      </select>
                    )}
                    <select
                      className="input flex-1 !py-2 !text-sm"
                      value={l.supplyItemId}
                      onChange={(e) => setSupplyLinks((ls) => ls.map((x, i) =>
                        i === idx ? { ...x, supplyItemId: e.target.value } : x))}
                    >
                      {!supplyItems.some((s) => s.id === l.supplyItemId) && <option value={l.supplyItemId}>—</option>}
                      {supplyItems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <input
                      className="input !w-20 !py-2 !text-sm tabular-nums text-center shrink-0"
                      inputMode="numeric"
                      value={l.qtyStr}
                      onChange={(e) => setSupplyLinks((ls) => ls.map((x, i) =>
                        i === idx ? { ...x, qtyStr: e.target.value.replace(/\D/g, '') } : x))}
                    />
                    <span className="w-8 text-xs text-gray-500 shrink-0">
                      {supplyItems.find((s) => s.id === l.supplyItemId)?.unit ?? ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSupplyLinks((ls) => ls.map((x, i) =>
                        i === idx ? { ...x, takeawayOnly: !x.takeawayOnly } : x))}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
                        l.takeawayOnly ? 'border-gray-900 text-gray-900' : 'border-gray-200 text-gray-400'
                      }`}
                    >
                      {t(lang, 'packagingTakeawayOnly')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSupplyLinks((ls) => ls.filter((_, i) => i !== idx))}
                      className="text-gray-300 hover:text-red-500 text-sm shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {recipeCostParts.length > 0 && (
              <p className="text-xs text-gray-500 mt-3 tabular-nums">
                {t(lang, 'recipeCostLabel')}:{' '}
                {recipeCostParts
                  .map((p) => (p.name ? `${p.name} ${formatMoney(p.cost, lang)}` : formatMoney(p.cost, lang)))
                  .join(' · ')}
              </p>
            )}
          </section>
          )}
        </div>

        {/* Футер */}
        <div className="flex items-center justify-between px-8 py-4 border-t border-gray-100 shrink-0">
          {item ? (
            <button
              onClick={() => confirm(t(lang, 'confirmDelete')) && remove.mutate()}
              className="text-sm text-red-500 hover:text-red-600 font-semibold"
            >
              {t(lang, 'delete')}
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onBack} className="btn-secondary">{t(lang, 'cancel')}</button>
            <button onClick={handleSave} disabled={!name.trim() || save.isPending} className="btn-primary !px-8">
              {t(lang, 'save')}
            </button>
          </div>
        </div>
      </main>

      {/* ── Предпросмотр ─────────────────────────── */}
      <ItemPreview
        name={name}
        description={description}
        imageUrl={imageUrl}
        priceStr={priceStr}
        variants={variants}
        groups={attachedGroups}
      />
    </>
  )
}

/** Кнопка «+ Группа»: раскрывает список свободных групп + создание новой */
function AddGroupControl({
  lang, available, onAttach, onCreate,
}: {
  lang: 'ru' | 'he'
  available: ModifierGroup[]
  onAttach: (id: string) => void
  onCreate: (name: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    try {
      await onCreate(newName.trim())
      setNewName('')
      setOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-4 py-2.5 rounded-xl border border-dashed border-gray-200 text-sm font-semibold
                   text-gray-400 hover:border-gray-400 hover:text-gray-600 transition-colors"
      >
        {t(lang, 'addGroupBtn')}
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-gray-200 p-3 space-y-2 max-w-md">
      {available.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {available.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => { onAttach(g.id); setOpen(false) }}
              className="px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-sm font-semibold
                         text-gray-600 hover:border-gray-400 transition-colors"
            >
              {g.name}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="flex gap-1.5">
        <input
          autoFocus
          className="input !py-2 !text-sm"
          placeholder={t(lang, 'newGroupPlaceholder')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" disabled={!newName.trim()} className="btn-secondary !px-3 !py-2 !text-sm">✓</button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost !px-2 !py-2 !text-sm">✕</button>
      </form>
    </div>
  )
}

function SectionTitle({ children, noMargin }: { children: React.ReactNode; noMargin?: boolean }) {
  return <h3 className={`text-sm font-bold text-gray-900 ${noMargin ? '' : 'mb-3'}`}>{children}</h3>
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-medium text-gray-500 mb-1 block">{children}</label>
}

function Toggle({ on, onChange, small }: { on: boolean; onChange: (v: boolean) => void; small?: boolean }) {
  const w = small ? 'w-8 h-5' : 'w-10 h-6'
  const dot = small ? 'w-4 h-4' : 'w-5 h-5'
  const shift = small ? 'start-[14px]' : 'start-[18px]'
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`${w} rounded-full transition-colors relative ${on ? 'bg-emerald-500' : 'bg-gray-200'}`}
    >
      <span className={`absolute top-0.5 ${dot} rounded-full bg-white shadow transition-all ${on ? shift : 'start-0.5'}`} />
    </button>
  )
}
