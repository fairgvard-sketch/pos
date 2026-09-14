import { flushSync } from 'react-dom'

export type NavDirection = 'forward' | 'back'

interface SameDocumentViewTransition {
  finished: Promise<void>
  skipTransition?: () => void
}

let activeTransition: SameDocumentViewTransition | null = null

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
    startViewTransition?: (update: () => void) => SameDocumentViewTransition
  }

  let committed = false
  const apply = () => {
    // Некоторые реализации вызывают update-callback даже после отмены
    // перехода. При аварийном fallback не даём одному тапу примениться дважды.
    if (committed) return
    committed = true
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

  // Новый тап важнее незаконченной декорации. Hero уже виден под снапшотом
  // возврата, поэтому пользователь может снова нажать «Заказать» до конца
  // 550-ms анимации. Второй document.startViewTransition в этот момент
  // нестабилен в браузерах с ранней реализацией API (особенно вокруг video):
  // отменяем старый снимок и применяем новое состояние без второй анимации.
  if (activeTransition) {
    try {
      activeTransition.skipTransition?.()
    } catch {
      // Даже ошибочная отмена анимации не имеет права блокировать навигацию.
    }
    apply()
    return
  }

  document.documentElement.dataset.nav = direction
  let transition: SameDocumentViewTransition
  try {
    transition = doc.startViewTransition(apply)
  } catch {
    // Анимация — progressive enhancement: даже при ошибке браузерного API
    // навигация обязана состояться.
    delete document.documentElement.dataset.nav
    apply()
    return
  }

  activeTransition = transition
  void transition.finished
    .catch(() => undefined)
    .finally(() => {
      // Старый transition может завершиться уже после нового. Он не должен
      // снять направление или занулить ссылку у более свежего перехода.
      if (activeTransition !== transition) return
      activeTransition = null
      delete document.documentElement.dataset.nav
    })
}
