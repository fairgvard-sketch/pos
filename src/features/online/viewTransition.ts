import { flushSync } from 'react-dom'

export type NavDirection = 'forward' | 'back'

/**
 * Переход между экранами гостевого сценария через View Transitions API.
 *
 * Почему не свои слои: прежняя система анимировала ЖИВОЙ DOM — контейнер
 * на время перехода становился fixed с overflow:hidden, старый экран
 * пере-монтировался в слой-клон, его скролл компенсировался отрицательным
 * margin. Внутри слоёв живут sticky-чипы и fixed-панели, а transform на
 * предке меняет их систему координат — отсюда прыжки строки категорий,
 * белые кадры и «уезжающий» интерфейс, которые не лечились точечно.
 *
 * View Transitions снимает «до» и «после» как снапшоты и анимирует
 * картинки: sticky/fixed физически не могут дёрнуться, белый кадр
 * невозможен (старый снапшот живёт, пока новый не готов), сброс скролла
 * происходит под снапшотом и не виден. Живой DOM в анимации не участвует.
 *
 * Направление кладём в <html data-nav>: CSS выбирает, с какой стороны
 * въезжает новый экран. Без поддержки API (старые браузеры) и при
 * prefers-reduced-motion — мгновенное переключение без анимации.
 */
export function navigateWithTransition(direction: NavDirection, commit: () => void): void {
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => { finished: Promise<void> }
  }

  const apply = () => {
    // flushSync: снапшот «после» снимается сразу по завершении колбэка,
    // обычный асинхронный рендер React в него бы не успел.
    flushSync(() => commit())
    // Сброс скролла внутри перехода: новый экран снимается уже наверху,
    // сам прыжок скрыт под анимацией.
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!doc.startViewTransition || reduced) {
    apply()
    return
  }

  document.documentElement.dataset.nav = direction
  const transition = doc.startViewTransition(apply)
  void transition.finished.finally(() => {
    delete document.documentElement.dataset.nav
  })
}
