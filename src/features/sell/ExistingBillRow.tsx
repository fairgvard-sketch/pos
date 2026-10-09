import { useRef } from 'react'
import { t, type Lang } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import Icon from '../../components/Icon'
import type { BillLine } from '../tables/api'
import { useRowSwipe } from './useRowSwipe'

/**
 * Строка уже отправленной позиции счёта стола. Тап открывает действия с
 * позицией (181: количество, перенос, удаление по PIN менеджера), свайп
 * влево — сразу удаление. У придержанной до Fire строки (179) кружок
 * слева отмечает её для общего Fire.
 */
export default function ExistingBillRow({
  line: l,
  lang,
  isRtl,
  busy,
  onVoid,
  onOpen,
  selected = false,
  onToggle,
}: {
  line: BillLine
  lang: Lang
  isRtl: boolean
  busy: boolean
  onVoid: () => void
  /** Тап по строке: окно действий с позицией */
  onOpen: () => void
  selected?: boolean
  /** Только у придержанной строки: выделить/снять выделение для Fire */
  onToggle?: () => void
}) {
  // Свайп не должен заодно переключить выделение строки
  const swiped = useRef(false)
  const { dx, dragging, handlers } = useRowSwipe({
    isRtl,
    maxPull: 140,
    disabled: busy,
    onRelease(dx) {
      if (dx < -8) swiped.current = true
      if (-dx >= 88) onVoid()
      return 0
    },
  })

  const selectable = l.held && !!onToggle
  const courseText = l.course !== null ? t(lang, 'courseChip').replace('{n}', String(l.course)) : null

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
        role="button"
        tabIndex={0}
        aria-label={`${t(lang, 'lineActions')}: ${l.name}`}
        onClick={() => {
          if (swiped.current) { swiped.current = false; return }
          onOpen()
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
        className={`relative flex items-start justify-between gap-2 text-sm touch-pan-y rounded-xl min-h-11 cursor-pointer ${
          selectable
            ? `py-2 px-2 ${selected ? 'bg-white ring-2 ring-gray-900' : 'bg-white'}`
            : 'bg-gray-50 py-2 px-1'
        }`}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 0.22s ease-out',
        }}
      >
        {selectable && (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={l.name}
            onClick={(e) => {
              e.stopPropagation()
              onToggle!()
            }}
            className="-m-2 p-2 shrink-0 self-start"
          >
            <span
              aria-hidden
              className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                selected ? 'bg-gray-900 border-gray-900 text-white' : 'border-gray-300'
              }`}
            >
              {selected && (
                <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
          </button>
        )}
        <div className="min-w-0 flex-1">
          <span className="font-semibold text-gray-700">
            {l.qty > 1 && <span className="text-gray-500">{l.qty}× </span>}
            {l.name}
            {l.variant_name && <span className="text-gray-500 font-medium"> · {l.variant_name}</span>}
          </span>
          {(l.modifiers.length > 0 || courseText) && (
            <span className="flex items-center gap-1 text-xs text-gray-500 leading-snug">
              {l.held && <Icon name="fire" size={12} className="shrink-0" />}
              {[courseText, ...l.modifiers].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        <span className="font-bold text-gray-600 tabular-nums shrink-0">{formatMoney(l.line_total, lang)}</span>
      </div>
    </div>
  )
}
