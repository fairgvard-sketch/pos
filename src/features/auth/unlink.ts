import type { QueryClient } from '@tanstack/react-query'
import { signOutDevice } from './api'
import { useAuthStore } from '../../store/authStore'
import { useCartStore } from '../../store/cartStore'
import { useOutboxStore } from '../../lib/offline/outboxStore'
import { SCOPED_STORAGE_KEYS } from '../../lib/offline/scope'

/**
 * Безопасная отвязка устройства (P3).
 *
 * Раньше unlink просто звал signOut и уходил на /setup — staff-сессия, корзина,
 * QueryClient и локальные данные оставались. Если следом входил другой аккаунт
 * (другая точка/организация), он видел кэш и очередь предыдущего устройства.
 *
 * Порядок:
 *  1. Непустой финансовый outbox — стоп: неотправленные деньги нельзя молча
 *     потерять (вызывающий сначала показывает предупреждение и требует явного
 *     подтверждения; сюда доходим только с force=true).
 *  2. Гасим staff-сессию, чистим корзину.
 *  3. signOut устройства (Supabase).
 *  4. Чистим QueryClient и scoped-данные localStorage (кэш каталога, per-device
 *     настройки). kassa-outbox НЕ трогаем — если в нём что-то осталось, оно
 *     карантинится по scope (см. scope.ts) и не уйдёт под чужой сессией.
 */

/** Сколько неотправленных операций в очереди (для предупреждения перед отвязкой) */
export function pendingOutboxCount(): number {
  return useOutboxStore.getState().ops.filter(
    (o) => o.status === 'pending' || o.status === 'inflight' || o.status === 'blocked_auth'
  ).length
}

export interface UnlinkResult {
  ok: boolean
  /** true — заблокировано непустой очередью (нужно явное подтверждение) */
  blockedByOutbox?: boolean
  pending?: number
}

export async function safeUnlinkDevice(
  queryClient: QueryClient,
  opts: { force?: boolean } = {}
): Promise<UnlinkResult> {
  const pending = pendingOutboxCount()
  if (pending > 0 && !opts.force) {
    return { ok: false, blockedByOutbox: true, pending }
  }

  // Гасим сессию сотрудника и корзину до signOut — интерфейс не должен
  // остаться с чужим PIN/корзиной, если signOut подвиснет.
  useAuthStore.getState().lock()
  useCartStore.getState().clear()

  await signOutDevice()

  // Read-кэш и per-device настройки предыдущего устройства — прочь.
  queryClient.clear()
  for (const key of SCOPED_STORAGE_KEYS) {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  }

  return { ok: true }
}
