import { useRef, useState } from 'react'

/**
 * Горизонтальный свайп строки «в сторону удаления» (влево в LTR, вправо
 * в RTL). dx нормализован: отрицательный — строка уехала к удалению.
 * Ось решается по преобладанию движения: вертикаль отдаётся скроллу,
 * обычный тап не перехватывается. Что делать при отпускании, решает
 * вызывающий через onRelease.
 */
export function useRowSwipe({
  isRtl,
  maxPull,
  disabled = false,
  onRelease,
}: {
  isRtl: boolean
  /** Дальше этого строка за пальцем не уезжает (px) */
  maxPull: number
  disabled?: boolean
  /** Свайп отпущен: вернуть, где строке остановиться (px, ≤ 0) */
  onRelease: (dx: number) => number
}) {
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  // Пока не решили, что это горизонтальный свайп — не перехватываем тап
  const locked = useRef(false)
  // В RTL логическое «влево» — это движение вправо по экрану
  const sign = isRtl ? -1 : 1

  function onPointerDown(e: React.PointerEvent) {
    if (disabled) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY }
    locked.current = false
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return
    const rawX = (e.clientX - start.current.x) * sign
    const rawY = e.clientY - start.current.y
    if (!locked.current) {
      // Определяем ось: горизонталь с явным преобладанием — это свайп
      if (Math.abs(rawX) > 8 && Math.abs(rawX) > Math.abs(rawY)) {
        locked.current = true
        setDragging(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      } else if (Math.abs(rawY) > 10) {
        // Вертикальный скролл — отпускаем строку
        start.current = null
        return
      }
    }
    if (locked.current) {
      e.preventDefault()
      // Только в сторону удаления; обратно — резинка с затуханием
      const next = rawX < 0 ? rawX : rawX * 0.25
      setDx(Math.max(next, -maxPull))
    }
  }

  function onPointerUp() {
    if (!start.current && !dragging) {
      setDx(0)
      return
    }
    start.current = null
    setDragging(false)
    setDx(onRelease(dx))
  }

  return {
    dx,
    setDx,
    dragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  }
}
