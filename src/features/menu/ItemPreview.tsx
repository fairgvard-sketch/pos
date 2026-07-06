import { useState } from 'react'
import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney, parseMoney } from '../../lib/money'
import type { ModifierGroup } from '../../types'
import ItemImage from '../../components/ItemImage'

interface VariantDraft {
  name: string
  priceStr: string
  is_default: boolean
}

interface Props {
  name: string
  description: string
  imageUrl: string | null
  priceStr: string
  variants: VariantDraft[]
  groups: ModifierGroup[]
}

/**
 * Живой предпросмотр карточки: интерактивный — можно потыкать размеры
 * и опции, итог пересчитывается. «В заказ» — только демонстрация.
 */
export default function ItemPreview({ name, description, imageUrl, priceStr, variants, groups }: Props) {
  const lang = useLangStore((s) => s.lang)

  const realVariants = variants.filter((v) => v.name.trim())
  const [variantIdx, setVariantIdx] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [touched, setTouched] = useState(false)

  // До первого клика следуем дефолтам из формы
  const defaultIdx = Math.max(0, realVariants.findIndex((v) => v.is_default))
  const activeIdx = variantIdx ?? (realVariants.length > 0 ? defaultIdx : null)

  const defaultMods = new Set(
    groups.flatMap((g) => (g.modifiers ?? []).filter((m) => m.is_default).map((m) => m.id))
  )
  const activeMods = touched ? selected : defaultMods

  const basePrice =
    activeIdx !== null && realVariants[activeIdx]
      ? parseMoney(realVariants[activeIdx].priceStr || '0') ?? 0
      : parseMoney(priceStr || '0') ?? 0

  const modsTotal = groups.reduce(
    (sum, g) => sum + (g.modifiers ?? []).filter((m) => activeMods.has(m.id)).reduce((s, m) => s + m.price_delta, 0),
    0
  )
  const total = basePrice + modsTotal

  function toggleMod(g: ModifierGroup, modId: string) {
    const next = new Set(touched ? selected : defaultMods)
    if (next.has(modId)) {
      next.delete(modId)
    } else {
      if (g.max_select === 1) {
        for (const m of g.modifiers ?? []) next.delete(m.id)
      }
      next.add(modId)
    }
    setSelected(next)
    setTouched(true)
  }

  return (
    <aside className="w-[280px] shrink-0 bg-white rounded-3xl flex flex-col overflow-hidden hidden xl:flex">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide p-5 pb-3 shrink-0">
        {t(lang, 'preview')}
      </div>

      <div className="flex-1 overflow-y-auto px-5 space-y-4">
        <ItemImage item={{ name: name || '?', image_url: imageUrl }} size="hero" />

        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-bold text-gray-900">{name || '—'}</div>
            {description && <div className="text-xs text-gray-400 mt-0.5 leading-snug">{description}</div>}
          </div>
          <div className="font-black text-gray-900 tabular-nums whitespace-nowrap">
            {formatMoney(basePrice, lang)}
          </div>
        </div>

        {realVariants.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
              {t(lang, 'variants')}
            </div>
            <div className="space-y-1">
              {realVariants.map((v, i) => (
                <button
                  key={i}
                  onClick={() => setVariantIdx(i)}
                  className="w-full flex items-center justify-between text-sm py-0.5"
                >
                  <span className={i === activeIdx ? 'text-gray-900 font-semibold' : 'text-gray-500'}>
                    {i === activeIdx ? '● ' : '○ '}{v.name}
                  </span>
                  <span className="text-gray-400 tabular-nums">
                    {formatMoney(parseMoney(v.priceStr || '0') ?? 0, lang)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.id}>
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">{g.name}</div>
            <div className="space-y-1">
              {(g.modifiers ?? []).map((m) => {
                const on = activeMods.has(m.id)
                return (
                  <button
                    key={m.id}
                    onClick={() => toggleMod(g, m.id)}
                    className="w-full flex items-center justify-between text-sm py-0.5"
                  >
                    <span className={on ? 'text-gray-900 font-semibold' : 'text-gray-500'}>
                      {g.max_select === 1 ? (on ? '● ' : '○ ') : (on ? '☑ ' : '☐ ')}
                      {m.name}
                    </span>
                    <span className="text-gray-400 tabular-nums">
                      {m.price_delta === 0 ? '' : `+${formatMoney(m.price_delta, lang)}`}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="p-5 pt-3 border-t border-gray-100 shrink-0">
        <div className="flex justify-between items-baseline mb-3">
          <span className="font-bold text-gray-900">{t(lang, 'total')}</span>
          <span className="text-xl font-black text-gray-900 tabular-nums">{formatMoney(total, lang)}</span>
        </div>
        <button
          onClick={() => toast(t(lang, 'previewOnlyToast'))}
          className="btn-primary w-full !rounded-2xl"
        >
          {t(lang, 'addToOrder')}
        </button>
      </div>
    </aside>
  )
}
