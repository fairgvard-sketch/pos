/**
 * Заглушка `virtual:pwa-register` для тестов.
 *
 * Виртуальный модуль создаёт только PWA-плагин, а тестовый конфиг его не
 * подключает (см. комментарий в `vitest.config.ts`). Без заглушки любой
 * тест, который тянет `lib/swUpdate`, падал бы на резолве импорта ещё до
 * `vi.mock`.
 */
export function registerSW(_options?: unknown): (reload?: boolean) => Promise<void> {
  return () => Promise.resolve()
}
