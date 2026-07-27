import { registerSW } from 'virtual:pwa-register'

/**
 * Обновление установленного приложения.
 *
 * Почему одного `registerType: 'autoUpdate'` мало. Service worker ищет новую
 * версию только при загрузке документа. Обычную вкладку пользователь
 * закрывает, и при следующем открытии проверка происходит сама. А иконка с
 * домашнего экрана живёт в отдельном процессе: iOS держит снапшот и
 * возобновляет приложение вместо перезагрузки — событие «загрузка страницы»
 * может не наступать сутками, и гость продолжает видеть старое меню.
 *
 * Поэтому проверяем дополнительно:
 *   • при возврате в приложение (visibilitychange) — момент, когда гость
 *     реально смотрит на экран, но не чаще чем раз в MIN_CHECK_MS;
 *   • раз в час, пока приложение открыто.
 *
 * Найдя новую версию, SW активируется сразу (skipWaiting в autoUpdate), но
 * страницу мы НЕ перезагружаем молча: гость мог набрать корзину или
 * заполнять контакты. Показываем ненавязчивую плашку и обновляем по тапу.
 */

/** Не бомбим сеть при частых переключениях между приложениями */
const MIN_CHECK_MS = 60_000
const PERIODIC_CHECK_MS = 60 * 60_000

export function setupSwUpdate(onNeedRefresh: (reload: () => void) => void): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

  let lastCheck = Date.now()

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // reload перезапускает страницу уже под управлением нового SW
      onNeedRefresh(() => void updateSW(true))
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return

      const check = () => {
        // Обновление тянет sw.js по сети — при офлайне просто ничего не будет
        void registration.update().catch(() => {})
        lastCheck = Date.now()
      }

      setInterval(check, PERIODIC_CHECK_MS)

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (Date.now() - lastCheck < MIN_CHECK_MS) return
        check()
      })
    },
  })
}
