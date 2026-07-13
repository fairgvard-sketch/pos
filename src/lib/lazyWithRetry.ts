import { lazy, type ComponentType } from 'react'

/**
 * lazy() с авто-восстановлением после деплоя.
 *
 * Проблема: после пуша в main Vercel собирает новую версию — хеши чанков
 * меняются, старые файлы `Page-<хеш>.js` удаляются. Вкладка, открытая ДО
 * деплоя, при переходе на lazy-роут просит старый хеш → Vercel отдаёт
 * `index.html` (404 SPA-fallback) с MIME text/html → `import()` реджектится
 * ("Failed to fetch dynamically imported module"). Без ErrorBoundary это
 * рушит всё дерево до корня — белый экран (наблюдалось на /reservations).
 *
 * Решение: при провале импорта один раз перезагружаем страницу — браузер
 * заберёт свежий index.html с актуальными хешами и чанк подхватится.
 * Флаг в sessionStorage (на каждый чанк свой) страхует от цикла: если и
 * после перезагрузки импорт падает (реальная сеть/битый деплой) — пробрасываем
 * ошибку в ErrorBoundary, а не крутим reload бесконечно.
 */
export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
  chunkName: string,
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    const flagKey = `chunk-reload:${chunkName}`
    try {
      const mod = await factory()
      // Успех — снимаем флаг, чтобы будущий провал снова мог перезагрузить
      sessionStorage.removeItem(flagKey)
      return mod
    } catch (err) {
      const alreadyReloaded = sessionStorage.getItem(flagKey)
      if (!alreadyReloaded) {
        sessionStorage.setItem(flagKey, '1')
        window.location.reload()
        // Возвращаем вечно-pending промис: страница уже перезагружается,
        // рендерить что-либо не нужно
        return new Promise<{ default: T }>(() => {})
      }
      // Перезагрузка не помогла — пусть ловит ErrorBoundary
      throw err
    }
  })
}
