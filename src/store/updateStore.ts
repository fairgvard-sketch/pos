import { create } from 'zustand'

/**
 * Состояние обновления приложения.
 *
 * Отдельный стор, а не локальное состояние компонента: о готовой версии
 * узнаёт синглтон `setupSwUpdate` (модуль, не React), а показать её нужно
 * поверх любого экрана. Плюс сюда же стекается «касса сейчас занята» —
 * счётчик критических операций, из-за которых перезагружаться нельзя.
 */

interface UpdateState {
  /** Новая версия скачана и ждёт активации */
  ready: boolean
  /**
   * Фронтенд отстал от схемы БД: сервер уже на миграции новее той, под
   * которую собран этот бандл. Обновиться нужно обязательно, плашку
   * нельзя закрыть.
   */
  behindSchema: boolean
  /** Регистрация SW не удалась — показываем ручной выход в диагностике */
  swError: string | null
  /** Кассир закрыл необязательную плашку до следующей находки */
  dismissed: boolean
  /** Идёт применение: кнопка не должна нажиматься дважды */
  applying: boolean
  /** Счётчик незавершённых критических операций (оплата, печать чека…) */
  critical: number

  markReady: () => void
  markBehindSchema: () => void
  markSwError: (message: string | null) => void
  dismiss: () => void
  setApplying: (value: boolean) => void
  beginCritical: () => void
  endCritical: () => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  ready: false,
  behindSchema: false,
  swError: null,
  dismissed: false,
  applying: false,
  critical: 0,

  // Новая находка всегда показывается заново: «закрыл» относится к
  // конкретной версии, а не к обновлениям вообще.
  markReady: () => set({ ready: true, dismissed: false }),
  markBehindSchema: () => set({ behindSchema: true, dismissed: false }),
  markSwError: (swError) => set({ swError }),
  dismiss: () => set({ dismissed: true }),
  setApplying: (applying) => set({ applying }),
  beginCritical: () => set((s) => ({ critical: s.critical + 1 })),
  endCritical: () => set((s) => ({ critical: Math.max(0, s.critical - 1) })),
}))

/**
 * Обернуть критическую операцию: пока она идёт, кнопка обновления
 * заблокирована. Перезагрузка посреди оплаты стоит чека, а не удобства.
 */
export async function withCriticalOperation<T>(run: () => Promise<T>): Promise<T> {
  const { beginCritical, endCritical } = useUpdateStore.getState()
  beginCritical()
  try {
    return await run()
  } finally {
    endCritical()
  }
}
