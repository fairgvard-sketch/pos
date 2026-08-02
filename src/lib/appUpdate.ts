import { getSwDiagnostics } from './swUpdate'

/**
 * Принудительная замена оболочки приложения.
 *
 * Обычный путь обновления — `applyUpdate()`: активировать ждущий воркер и
 * перезагрузиться. Он не поможет в одном случае: воркер по какой-то причине
 * не обновляется вовсе (сеть отдала битый `sw.js`, регистрация упала,
 * precache остался от позапрошлого деплоя), и касса залипла на старой сборке.
 * Здесь мы сносим и регистрацию, и кэши, и уходим в сеть за свежим
 * `index.html`.
 *
 * Что НЕ трогаем: `localStorage` и `IndexedDB`. Там живут офлайн-очередь
 * продаж, сессия устройства и кэш каталога — терять их ради обновления
 * фронтенда нельзя ни при каких условиях. Чистятся только Cache Storage
 * (оболочка) и регистрации SW.
 */
export async function hardReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((r) => r.unregister().catch(() => false)))
    }
  } catch {
    /* нет прав/приватный режим — идём дальше, перезагрузка всё равно нужна */
  }

  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key).catch(() => false)))
    }
  } catch {
    /* см. выше */
  }

  // Кэш-бастер в адресе: без SW документ мог бы приехать из HTTP-кэша.
  const url = new URL(window.location.href)
  url.searchParams.set('v', String(Date.now()))
  window.location.replace(url.toString())
}

/** Строка диагностики для поддержки — без токенов и персональных данных. */
export function updateDiagnosticsText(): string {
  const sw = getSwDiagnostics()
  const lines = [
    `app: ${__APP_VERSION__}`,
    `sw: ${sw.state}${sw.waiting ? ' (update ready)' : ''}`,
    `sw controlled: ${sw.controlled ? 'yes' : 'no'}`,
    `sw script: ${sw.scriptUrl ?? '—'}`,
    `sw last check: ${sw.lastCheck ? new Date(sw.lastCheck).toISOString() : '—'}`,
    `sw error: ${sw.error ?? '—'}`,
    `ua: ${navigator.userAgent}`,
    `url: ${window.location.origin}${window.location.pathname}`,
    `at: ${new Date().toISOString()}`,
  ]
  return lines.join('\n')
}
