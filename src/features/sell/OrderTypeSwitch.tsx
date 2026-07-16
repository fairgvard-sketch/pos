import { useRef, useState } from 'react'
import type { OrderType } from '../../store/cartStore'
import { t } from '../../lib/i18n'

/**
 * Переключатель типа заказа: одна полоса во всю ширину, показывает ТОЛЬКО
 * текущий вариант. Свайп листает (RTL-зеркально), тап — следующий по кругу.
 * Точки-индикаторы показывают, сколько вариантов и какой активен.
 *
 * Всё направление считается в ЭКРАННЫХ координатах (drag → knob едет за
 * пальцем, подпись выезжает с той же стороны). В RTL «следующий вариант»
 * физически слева — screenDir переводит экранное движение в шаг по списку.
 */
const ORDER_TYPES: OrderType[] = ['here', 'takeaway', 'delivery']
const SWIPE_THRESHOLD = 44   // px: минимальный горизонтальный сдвиг для перелистывания

export default function OrderTypeSwitch({
  value,
  onChange,
  lang,
  isRtl,
}: {
  value: OrderType
  onChange: (t: OrderType) => void
  lang: 'ru' | 'he'
  isRtl: boolean
}) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)   // был ли распознан свайп — тогда клик игнорируем
  // drag: смещение пальца во время жеста (экранные px); null — покоя
  const [drag, setDrag] = useState<number | null>(null)
  // Экранное направление последнего перехода: 1 — вправо, -1 — влево.
  // Подпись выезжает с той стороны, откуда пришёл жест/тап.
  const [screenDir, setScreenDir] = useState<1 | -1>(isRtl ? -1 : 1)
  // «Выезд»: анимируем, когда текущий value — тот, на который мы только что
  // перелистнули через slide(). Храним целевой тип (а не булев флаг), чтобы
  // выезд играл ровно на рендере со сменившимся value: как только slide меняет
  // тип, animateTo === value → анимация; при откате незавершённого свайпа value
  // не меняется, animateTo !== value → span откатывается через transition.
  // (Заменяет ref justChanged + эффект-сброс, которые читали ref в рендере.)
  const [animateTo, setAnimateTo] = useState<OrderType | null>(null)
  const justChanged = animateTo === value
  const idx = ORDER_TYPES.indexOf(value)

  // Перелистнуть по экранному направлению. sd>0 (вправо) в LTR = следующий,
  // в RTL = предыдущий (список растёт влево). Зеркалим шаг через isRtl.
  function slide(sd: 1 | -1) {
    setScreenDir(sd)
    const step = isRtl ? -sd : sd
    const next = (idx + step + ORDER_TYPES.length) % ORDER_TYPES.length
    setAnimateTo(ORDER_TYPES[next])
    onChange(ORDER_TYPES[next])
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY }
    moved.current = false
    setDrag(0)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    const dy = e.clientY - start.current.y
    // Пока горизонталь не преобладает — не перехватываем (даём вертикали скроллить)
    if (!moved.current && Math.abs(dx) < 10) return
    if (Math.abs(dx) <= Math.abs(dy)) return
    moved.current = true
    // Небольшое сопротивление у краёв жеста — тактильнее (клампим до ±ширины кнопки)
    setDrag(Math.max(-120, Math.min(120, dx)))
  }
  function finish(e: React.PointerEvent) {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    start.current = null
    setDrag(null)
    if (moved.current && Math.abs(dx) > SWIPE_THRESHOLD) {
      slide(dx > 0 ? 1 : -1)   // вправо → screenDir 1, влево → -1
    }
  }

  const dragging = drag !== null
  return (
    <div className="mb-2.5">
      <button
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={() => { start.current = null; setDrag(null) }}
        onClick={() => { if (!moved.current) slide(isRtl ? -1 : 1) }} // тап = следующий
        className="relative w-full h-11 rounded-xl bg-gray-100 border border-gray-300
                   overflow-hidden touch-pan-y select-none active:scale-[0.99]"
      >
        <span
          // key = value: перемонтаж (и анимация выезда) только при СМЕНЕ типа.
          // Незавершённый свайп value не меняет → span тот же, translateX
          // снимается с transition ниже (плавный откат к центру).
          key={value}
          className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-gray-900"
          style={
            dragging
              ? { transform: `translateX(${drag}px)`, opacity: 1 - Math.min(Math.abs(drag!) / 160, 0.5) }
              : justChanged
                ? { animation: `${screenDir === 1 ? 'ot-in-right' : 'ot-in-left'} 0.18s ease-out` }
                : { transform: 'translateX(0)', transition: 'transform 0.18s ease-out' }
          }
        >
          {t(lang, value)}
        </span>
      </button>
      {/* Точки — сколько вариантов и текущий */}
      <div className="flex justify-center gap-1.5 mt-1.5">
        {ORDER_TYPES.map((tp, i) => (
          <span
            key={tp}
            className={`h-1.5 rounded-full transition-all ${
              i === idx ? 'w-4 bg-gray-800' : 'w-1.5 bg-gray-300'
            }`}
          />
        ))}
      </div>
    </div>
  )
}
