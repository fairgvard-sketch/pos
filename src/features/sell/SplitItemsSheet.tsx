import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchOrderLines } from '../tables/api'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'

interface Props {
  orderId: string
  /** Есть ли скидка на заказе — предупреждаем, что она останется на остатке */
  hasDiscount: boolean
  busy: boolean
  onConfirm: (items: { item_id: string; qty: number }[]) => void
  onCancel: () => void
}

/**
 * Выбор позиций для раздельной оплаты: что оплачивает первый гость.
 * Частичное qty поддерживается («1 из 2 капучино»). Выбранное уедет
 * в отдельный заказ со своим чеком.
 */
export default function SplitItemsSheet({ orderId, hasDiscount, busy, onConfirm, onCancel }: Props) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const { data: lines = [], isLoading } = useQuery({
    queryKey: ['order_lines', orderId],
    queryFn: () => fetchOrderLines(orderId),
  })

  // Сколько единиц каждой строки уходит первому гостю (item_id → qty)
  const [picked, setPicked] = useState<Record<string, number>>({})

  const totalUnits = lines.reduce((s, l) => s + l.qty, 0)
  const pickedUnits = Object.values(picked).reduce((s, n) => s + n, 0)
  // Нельзя забрать всё — остаток не может быть пустым
  const allPicked = pickedUnits >= totalUnits && totalUnits > 0

  const pickedAmount = lines.reduce((s, l) => {
    const n = picked[l.id] ?? 0
    return s + Math.round((l.line_total / l.qty) * n)
  }, 0)

  function setQty(id: string, qty: number, max: number) {
    const clamped = Math.max(0, Math.min(max, qty))
    setPicked((p) => {
      const next = { ...p }
      if (clamped === 0) delete next[id]
      else next[id] = clamped
      return next
    })
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="card w-full max-w-md p-6 animate-[rise-in_0.2s_ease-out] max-h-[85vh] flex flex-col">
        <h2 className="text-lg font-black text-gray-900 mb-1">{t(lang, 'splitByItems')}</h2>
        <p className="text-sm text-gray-500 mb-4">{t(lang, 'splitPickHint')}</p>
        {hasDiscount && <p className="text-xs text-amber-600 mb-3">{t(lang, 'splitDiscountWarning')}</p>}

        <div className="flex-1 overflow-y-auto space-y-2 -mx-1 px-1">
          {isLoading ? (
            <p className="text-center text-gray-400 py-8">…</p>
          ) : (
            lines.map((l) => {
              const n = picked[l.id] ?? 0
              return (
                <div
                  key={l.id}
                  className={`rounded-2xl border p-3 flex items-center gap-3 transition-colors ${
                    n > 0 ? 'border-gray-900 bg-gray-900/[0.03]' : 'border-gray-200'
                  }`}
                >
                  <button
                    className="text-start flex-1 min-w-0"
                    onClick={() => setQty(l.id, n > 0 ? 0 : l.qty, l.qty)}
                  >
                    <span className="font-semibold text-gray-900 text-sm block leading-tight">
                      {l.name}
                      {l.variant_name && <span className="text-gray-500 font-medium"> · {l.variant_name}</span>}
                    </span>
                    <span className="block text-xs text-gray-500 mt-0.5">
                      {formatMoney(Math.round(l.line_total / l.qty), lang)}
                      {l.qty > 1 && ` × ${l.qty}`}
                    </span>
                  </button>

                  {l.qty > 1 ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <MiniStep onClick={() => setQty(l.id, n - 1, l.qty)}>−</MiniStep>
                      <span className="w-8 text-center font-bold text-sm tabular-nums">
                        {n}/{l.qty}
                      </span>
                      <MiniStep onClick={() => setQty(l.id, n + 1, l.qty)}>+</MiniStep>
                    </div>
                  ) : (
                    <span
                      className={`w-6 h-6 rounded-full border-2 shrink-0 flex items-center justify-center ${
                        n > 0 ? 'border-gray-900 bg-gray-900 text-white text-xs' : 'border-gray-300'
                      }`}
                    >
                      {n > 0 && '✓'}
                    </span>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="pt-4 shrink-0">
          <div className="flex justify-between items-baseline mb-3 px-1">
            <span className="text-sm text-gray-500">{t(lang, 'splitFirstGuest')}</span>
            <span className="text-2xl font-black text-gray-900 tabular-nums">{formatMoney(pickedAmount, lang)}</span>
          </div>
          {allPicked && <p className="text-xs text-red-500 mb-2">{t(lang, 'splitCantTakeAll')}</p>}
          <button
            onClick={() =>
              onConfirm(Object.entries(picked).map(([item_id, qty]) => ({ item_id, qty })))
            }
            disabled={busy || pickedUnits === 0 || allPicked}
            className="btn-primary w-full !py-3.5 !rounded-2xl"
          >
            {t(lang, 'splitConfirm')}
          </button>
          <button onClick={onCancel} disabled={busy} className="btn-ghost w-full mt-2">
            {t(lang, 'cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

function MiniStep({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-9 h-9 rounded-lg bg-gray-50 border border-gray-200 text-sm font-bold text-gray-600
                 flex items-center justify-center hover:border-gray-400 active:scale-[0.92] transition-all"
    >
      {children}
    </button>
  )
}
