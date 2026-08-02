import { registerSW } from 'virtual:pwa-register'

/**
 * Жизненный цикл service worker.
 *
 * ЧТО БЫЛО СЛОМАНО. В POS-сборке этого модуля не было вообще: `setupSwUpdate`
 * вызывался только из `PublicApp`, а Rollup вырезает гостевую ветку из
 * кассовой сборки целиком. Единственным кодом про SW оставался вставленный
 * плагином `registerSW.js` — голый `navigator.serviceWorker.register('/sw.js')`
 * без единого слушателя. Касса не проверяла обновления, не замечала ждущий
 * воркер, ничего не показывала и не перезагружалась: терминал месяцами
 * отдавал старый `index.html` из precache, потому что навигация до сети
 * вообще не доходила.
 *
 * ЧТО ЗДЕСЬ. Одна регистрация на приложение и явные ответы на четыре вопроса:
 *
 *   • когда искать      — на старте, при возврате в приложение, при
 *                         появлении сети и раз в час;
 *   • что считать новым — воркер в состоянии `waiting` или `installed`,
 *                         включая тот, что уже ждал с прошлого запуска
 *                         (события этой вкладке никто не пришлёт);
 *   • когда применять   — по явной команде, и только когда касса не занята
 *                         оплатой или другой критической операцией;
 *   • сколько раз       — ровно один reload, под флагом.
 *
 * Молча не перезагружаемся никогда: на кассе это потерянный чек.
 */

/** Не бомбим сеть при частых переключениях между приложениями */
const MIN_CHECK_MS = 60_000
const PERIODIC_CHECK_MS = 60 * 60_000

export type SwState = 'unsupported' | 'none' | 'installing' | 'waiting' | 'active' | 'error'

export interface SwDiagnostics {
  state: SwState
  /** Есть готовый к активации воркер */
  waiting: boolean
  scriptUrl: string | null
  lastCheck: number | null
  error: string | null
  controlled: boolean
}

const diagnostics: SwDiagnostics = {
  state: typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? 'none' : 'unsupported',
  waiting: false,
  scriptUrl: null,
  lastCheck: null,
  error: null,
  controlled: false,
}

export function getSwDiagnostics(): SwDiagnostics {
  return {
    ...diagnostics,
    controlled: typeof navigator !== 'undefined'
      && 'serviceWorker' in navigator
      && Boolean(navigator.serviceWorker.controller),
  }
}

/** Один reload на весь жизненный цикл страницы — защита от петли. */
let reloading = false

/** Форсированная перезагрузка: последнее средство, см. applyUpdate. */
function reloadOnce(): void {
  if (reloading) return
  reloading = true
  window.location.reload()
}

let registration: ServiceWorkerRegistration | null = null
let notify: (() => void) | null = null

/** Сообщить приложению о готовой версии — идемпотентно. */
function announce(): void {
  diagnostics.waiting = true
  diagnostics.state = 'waiting'
  notify?.()
}

/**
 * Проследить за воркером, который ставится прямо сейчас. Событие `waiting`
 * от workbox приходит не всегда (например, воркер уже ждал до открытия
 * вкладки), поэтому состояние читаем и сами.
 */
function watch(worker: ServiceWorker | null): void {
  if (!worker) return
  if (worker.state === 'installed' || worker.state === 'activated') {
    // `installed` при живом контроллере = ждёт активации. Без контроллера
    // это первая установка, обновлять нечего.
    if (navigator.serviceWorker.controller) announce()
    return
  }
  diagnostics.state = 'installing'
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) announce()
  })
}

/** Прочитать регистрацию целиком: waiting важнее installing. */
function inspect(reg: ServiceWorkerRegistration): void {
  registration = reg
  diagnostics.scriptUrl = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? null
  if (reg.waiting && navigator.serviceWorker.controller) {
    announce()
    return
  }
  if (reg.installing) {
    watch(reg.installing)
    return
  }
  if (reg.active) diagnostics.state = 'active'
}

export function setupSwUpdate(onNeedRefresh: () => void): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  notify = onNeedRefresh

  /**
   * Смена контроллера = новый воркер взял управление. Перезагружаемся ОДИН
   * раз и только если сами его об этом попросили: внешняя смена контроллера
   * (другая вкладка нажала «обновить») не должна дёргать кассу под руками.
   */
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applying) reloadOnce()
  })

  registerSW({
    immediate: true,
    onNeedRefresh() {
      announce()
    },
    onRegisterError(error: unknown) {
      diagnostics.state = 'error'
      diagnostics.error = error instanceof Error ? error.message : String(error)
      notify?.()
    },
    onRegisteredSW(swUrl: string, reg: ServiceWorkerRegistration | undefined) {
      if (!reg) return
      diagnostics.scriptUrl = swUrl
      inspect(reg)

      const check = () => {
        diagnostics.lastCheck = Date.now()
        // Обновление тянет sw.js по сети — при офлайне просто ничего не будет
        void reg.update().then(() => inspect(reg)).catch(() => {})
      }

      // На старте — обязательно: воркер мог поспеть, пока касса была закрыта.
      check()
      reg.addEventListener('updatefound', () => watch(reg.installing))

      setInterval(check, PERIODIC_CHECK_MS)
      window.addEventListener('online', check)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (diagnostics.lastCheck && Date.now() - diagnostics.lastCheck < MIN_CHECK_MS) return
        check()
      })
    },
  })
}

/**
 * Проверить обновление прямо сейчас (кнопка в настройках).
 *
 * Возвращает `true`, если после проверки есть что применять. Кассиру важен
 * ответ «да/нет», а не то, была ли сеть: офлайн выглядит как «нечего
 * обновлять» и это честно — обновиться всё равно не получится.
 */
export async function checkForUpdate(): Promise<boolean> {
  if (!registration) return false
  diagnostics.lastCheck = Date.now()
  try {
    await registration.update()
  } catch {
    return false
  }
  inspect(registration)
  return diagnostics.waiting
}

/** Идёт применение — обрабатываем controllerchange и не повторяем. */
let applying = false

/**
 * Применить готовое обновление: активировать ждущий воркер и перезагрузиться
 * ровно один раз.
 *
 * Если ждущего воркера нет (плашку показала проверка версии схемы, а SW ещё
 * не докачался), просто перезагружаемся — навигация пойдёт в сеть за свежим
 * `index.html`, потому что precache к этому моменту уже мог обновиться.
 * Совсем безнадёжный случай разбирает `hardReload` (`lib/appUpdate.ts`).
 */
export function applyUpdate(): void {
  if (applying) return
  applying = true

  const waiting = registration?.waiting
  if (!waiting) {
    reloadOnce()
    return
  }

  // Страховка: если воркер по какой-то причине не сменит контроллер,
  // перезагружаемся сами, а не оставляем кассира с зависшей кнопкой.
  const failsafe = setTimeout(reloadOnce, 3000)
  navigator.serviceWorker.addEventListener('controllerchange', () => clearTimeout(failsafe), { once: true })
  waiting.postMessage({ type: 'SKIP_WAITING' })
}
