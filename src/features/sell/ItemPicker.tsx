import { useMemo, useState } from 'react'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import type { MenuItem, ModifierGroup } from '../../types'
import type { CartLine, CartMod } from '../../store/cartStore'
import { lineUnitPrice } from '../../store/cartStore'

interface Props {
  item: MenuItem
  groups: ModifierGroup[] // только привязанные к товару, в порядке привязки
  /** Существующая строка корзины (редактирование) или null (добавление) */
  line: CartLine | null
  onConfirm: (config: { variantId: string | null; variantName: string | null; basePrice: number; mods: CartMod[]; notes: string }) => void
  onClose: () => void
}

/**
 * Быстрый выбор размера/модификаторов. Всё — крупные чипы,
 * дефолты уже выбраны, кассир меняет только отличия.
 */
export default function ItemPicker({ item, groups, line, onConfirm, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)

  const variants = useMemo(
    () => (item.item_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order),
    [item]
  )

  const [variantId, setVariantId] = useState<string | null>(
    line?.variantId ?? (variants.find((v) => v.is_default) ?? variants[0])?.id ?? null
  )
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (line) return new Set(line.mods.map((m) => m.id))
    const defaults = new Set<string>()
    for (const g of groups) {
      for (const m of g.modifiers ?? []) {
        if (m.is_default && m.is_available) defaults.add(m.id)
      }
    }
    return defaults
  })
  const [notes, setNotes] = useState(line?.notes ?? '')

  function toggleMod(g: ModifierGroup, modId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      const groupModIds = (g.modifiers ?? []).map((m) => m.id)
      if (next.has(modId)) {
        next.delete(modId)
      } else {
        // max_select=1 → радиоповедение: выбор снимает остальные в группе
        if (g.max_select === 1) {
          groupModIds.forEach((id) => next.delete(id))
        } else if (g.max_select > 1) {
          const count = groupModIds.filter((id) => next.has(id)).length
          if (count >= g.max_select) return prev
        }
        next.add(modId)
      }
      return next
    })
  }

  const currentVariant = variants.find((v) => v.id === variantId) ?? null
  const basePrice = currentVariant?.price ?? item.price
  const mods: CartMod[] = groups.flatMap((g) =>
    (g.modifiers ?? [])
      .filter((m) => selected.has(m.id))
      .map((m) => ({ id: m.id, name: m.name, priceDelta: m.price_delta }))
  )
  const preview: CartLine = {
    key: '', itemId: item.id, name: item.name,
    variantId, variantName: currentVariant?.name ?? null,
    basePrice, mods, qty: 1, notes,
  }

  function confirm() {
    onConfirm({ variantId, variantName: currentVariant?.name ?? null, basePrice, mods, notes })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="card w-full max-w-md max-h-[90vh] overflow-y-auto p-6 space-y-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-bold text-gray-900">{item.name}</h2>
          <span className="font-black text-gray-900 tabular-nums">
            {formatMoney(lineUnitPrice(preview), lang)}
          </span>
        </div>

        {/* Размеры */}
        {variants.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {variants.map((v) => (
              <button
                key={v.id}
                onClick={() => setVariantId(v.id)}
                className={`px-5 py-3 rounded-xl text-sm font-bold transition-all active:scale-[0.96] ${
                  v.id === variantId
                    ? 'bg-gray-900 text-white'
                    : 'bg-white border border-gray-200 text-gray-700 hover:border-gray-400'
                }`}
              >
                {v.name}
                <span className={`block text-xs font-medium ${v.id === variantId ? 'text-gray-400' : 'text-gray-400'}`}>
                  {formatMoney(v.price, lang)}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Модификаторы по группам */}
        {groups.map((g) => (
          <div key={g.id}>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{g.name}</div>
            <div className="flex gap-2 flex-wrap">
              {(g.modifiers ?? [])
                .filter((m) => m.is_available)
                .map((m) => {
                  const on = selected.has(m.id)
                  return (
                    <button
                      key={m.id}
                      onClick={() => toggleMod(g, m.id)}
                      className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-[0.96] ${
                        on
                          ? 'bg-gray-900 text-white'
                          : 'bg-white border border-gray-200 text-gray-700 hover:border-gray-400'
                      }`}
                    >
                      {m.name}
                      {m.price_delta !== 0 && (
                        <span className={on ? 'text-gray-400 ms-1' : 'text-gray-400 ms-1'}>
                          +{formatMoney(m.price_delta, lang)}
                        </span>
                      )}
                    </button>
                  )
                })}
            </div>
          </div>
        ))}

        <input
          className="input"
          placeholder={t(lang, 'notesPlaceholder')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div className="flex gap-2">
          <button onClick={confirm} className="btn-primary flex-1 !py-3.5 !text-base">
            {line ? t(lang, 'save') : t(lang, 'add')} · {formatMoney(lineUnitPrice(preview), lang)}
          </button>
          <button onClick={onClose} className="btn-secondary">
            {t(lang, 'cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
