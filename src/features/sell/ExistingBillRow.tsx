import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import type { BillLine } from '../tables/api'
import { useRowSwipe } from './useRowSwipe'

/** Строка уже заказанной позиции (счёт стола) со свайпом на снятие (void) */
export default function ExistingBillRow({
  line: l,
  lang,
  isRtl,
  busy,
  onVoid,
}: {
  line: BillLine
  lang: 'ru' | 'he'
  isRtl: boolean
  busy: boolean
  onVoid: () => void
}) {
  const { dx, dragging, handlers } = useRowSwipe({
    isRtl,
    maxPull: 140,
    disabled: busy,
    onRelease(dx) {
      if (-dx >= 88) onVoid()
      return 0
    },
  })

  return (
    <div className="relative overflow-hidden rounded-xl">
      <div
        className="absolute inset-0 flex items-center justify-end bg-red-500 text-white pe-4 rounded-xl"
        style={{ opacity: -dx > 8 ? 1 : 0 }}
      >
        <span className="text-xs font-semibold">{t(lang, 'delete')}</span>
      </div>
      <div
        {...handlers}
        className="relative bg-gray-50 flex items-start justify-between gap-2 text-sm py-1 touch-pan-y"
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 0.22s ease-out',
        }}
      >
        <div className="min-w-0">
          <span className="font-semibold text-gray-700">
            {l.qty > 1 && <span className="text-gray-500">{l.qty}× </span>}
            {l.name}
            {l.variant_name && <span className="text-gray-500 font-medium"> · {l.variant_name}</span>}
          </span>
          {l.modifiers.length > 0 && (
            <span className="block text-xs text-gray-500 leading-snug">{l.modifiers.join(' · ')}</span>
          )}
        </div>
        <span className="font-bold text-gray-600 tabular-nums shrink-0">{formatMoney(l.line_total, lang)}</span>
      </div>
    </div>
  )
}
