import { useState } from 'react'
import { lineUnitPrice, type CartLine } from '../../store/cartStore'
import { t, type Lang } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import type { MenuItem } from '../../types'
import ItemImage from '../../components/ItemImage'
import { useRowSwipe } from './useRowSwipe'

/** Порог свайпа (px), после которого позиция удаляется на отпускании */
const SWIPE_DELETE_THRESHOLD = 96
/** Ширина зоны удаления, до которой строка «прилипает» */
const SWIPE_REVEAL_WIDTH = 80

/** Строка счёта со свайпом на удаление (влево в LTR, вправо в RTL) */
export default function CartLineRow({
  line: l,
  item,
  lang,
  isRtl,
  onOpen,
  onEditPrice,
  onRemove,
  onQty,
  onCycleCourse,
}: {
  line: CartLine
  item: MenuItem | undefined
  lang: Lang
  isRtl: boolean
  onOpen: () => void
  onEditPrice: () => void
  onRemove: () => void
  onQty: () => void
  /** Счёт стола (179): тап по чипу меняет курс подачи строки */
  onCycleCourse?: () => void
}) {
  const [removing, setRemoving] = useState(false)
  const { dx, setDx, dragging, handlers } = useRowSwipe({
    isRtl,
    maxPull: 160,
    onRelease(dx) {
      if (-dx >= SWIPE_DELETE_THRESHOLD) {
        // Уводим за край и удаляем
        setRemoving(true)
        setTimeout(onRemove, 180)
        return -window.innerWidth
      }
      if (-dx >= SWIPE_REVEAL_WIDTH / 2) return -SWIPE_REVEAL_WIDTH // прилипнуть к раскрытой зоне
      return 0
    },
  })

  const revealed = dx <= -SWIPE_REVEAL_WIDTH / 2

  return (
    <div className="relative overflow-hidden rounded-2xl animate-[rise-in_0.18s_ease-out]">
      {/* Красная подложка удаления */}
      <button
        onClick={() => { setRemoving(true); setDx(-window.innerWidth); setTimeout(onRemove, 180) }}
        aria-label={t(lang, 'delete')}
        className="absolute inset-0 flex items-center justify-end bg-red-500 text-white pe-6"
        style={{ opacity: -dx > 8 ? 1 : 0 }}
      >
        <span className="text-sm font-semibold">{t(lang, 'delete')}</span>
      </button>

      {/* Сама строка — двигается поверх подложки */}
      <div
        {...handlers}
        className="relative border border-gray-100 bg-white rounded-2xl p-3 touch-pan-y"
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : `transform ${removing ? 0.18 : 0.25}s ease-out`,
        }}
      >
        <div className="flex items-start gap-2.5">
          {item && <ItemImage item={item} size="line" />}
          {/* div с role=button (не <button>), чтобы вложенный кликабельный
              «× N» не был interactive-in-interactive */}
          <div
            role="button"
            tabIndex={0}
            className="text-start flex-1 min-w-0 cursor-pointer"
            // Игнорируем клик, если строка раскрыта свайпом (сначала закрываем)
            onClick={() => (revealed ? setDx(0) : onOpen())}
          >
            <span className="font-semibold text-gray-900 text-sm block leading-tight">
              {l.name}
              {/* Кол-во сразу после названия, мелким серым (как в референсе).
                  Тап по нему открывает панель −/+; stopPropagation → не onOpen. */}
              <span
                onClick={(e) => { e.stopPropagation(); onQty() }}
                className="text-gray-500 font-medium tabular-nums ms-1.5"
              >
                × {l.qty}
              </span>
            </span>
            {/* Вариант (размер), модификаторы, заметка, правка цены — строкой под названием */}
            {(l.variantName || l.mods.length > 0 || l.notes || l.priceOverride !== null) && (
              <span className="block text-sm text-gray-500 mt-0.5 leading-snug">
                {[
                  l.variantName,
                  ...l.mods.map((m) => m.name),
                  l.notes,
                  l.priceOverride !== null ? t(lang, 'priceOverridden') : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </div>
          {onCycleCourse && (
            /* Курс подачи: по умолчанию из каталога, тап — следующий.
               Кнопка 44px, видимая плашка компактнее, чтобы строка не росла */
            <button
              type="button"
              onClick={onCycleCourse}
              aria-label={t(lang, 'courseChipHint')}
              className="shrink-0 h-11 -my-2 -mx-1 px-1 flex items-center active:scale-[0.97]"
            >
              <span
                className={`h-7 px-2 rounded-lg text-xs font-bold tabular-nums flex items-center ${
                  l.course ? 'bg-gray-100 text-gray-900' : 'border border-dashed border-gray-300 text-gray-500'
                }`}
              >
                {l.course ? t(lang, 'courseChip').replace('{n}', String(l.course)) : t(lang, 'courseChipNone')}
              </span>
            </button>
          )}
          <button
            onClick={onEditPrice}
            className={`font-bold text-sm tabular-nums shrink-0 ${
              l.priceOverride !== null ? 'text-gray-900 underline decoration-dotted underline-offset-2' : 'text-gray-900'
            }`}
          >
            {formatMoney(lineUnitPrice(l) * l.qty, lang)}
          </button>
        </div>
      </div>
    </div>
  )
}
