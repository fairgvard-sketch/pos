import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LocalOrder, OutboxOp } from './types'

/**
 * Outbox офлайн-очереди — localStorage ('kassa-outbox'), переживает
 * перезагрузку/краш. Строгий FIFO: операции зависят друг от друга
 * (pay после place, append после open), поэтому обрабатывается всегда
 * ГОЛОВА очереди; failed-голова останавливает дренаж до ручного
 * retry/discard (см. drain.ts).
 */

/** Сколько синхронизированных эхо-заказов держим для журнала операций */
const SYNCED_KEEP = 50

function localDay(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

interface OutboxState {
  ops: OutboxOp[]
  /** localKey (client_uuid) → server order_id, заполняется при синке place/open */
  idMap: Record<string, string>
  /** Эхо офлайн-заказов по ключу (см. LocalOrder) */
  localOrders: Record<string, LocalOrder>
  /** Счётчик локальных номеров K-n, сбрасывается по дню */
  provisionalDay: string
  provisionalN: number

  enqueue: (op: OutboxOp) => void
  markInflight: (id: string) => void
  /** Сетевой сбой: вернуть в pending, attempts++ (никогда не failed) */
  markPending: (id: string, err: string) => void
  /** Доменная ошибка сервера: остановить очередь до ручного разбора */
  markFailed: (id: string, err: string) => void
  /** Нужен PIN: операция ждёт staff-сессию, очередь стоит без ручного разбора */
  markBlockedAuth: (id: string) => void
  /** PIN введён: вернуть все blocked_auth в pending и разбудить дренаж */
  unblockAuth: () => void
  /** Чужой scope (P3): операция другого аккаунта — в карантин, не отправлять */
  markQuarantined: (id: string) => void
  retryFailed: (id: string) => void
  /** Успех: убрать операцию; place/open — записать idMap */
  removeOp: (id: string, serverOrderId?: string) => void
  /**
   * Ручное удаление. place/open удаляются КАСКАДОМ со всеми операциями
   * своего orderKey и эхом заказа (они без родителя бессмысленны).
   */
  discardOp: (id: string) => void
  /** Отмена до отправки: снять ещё не ушедшие pending-операции группы */
  dropUnsent: (orderKey: string) => void
  nextProvisionalNumber: () => string
  upsertLocalOrder: (o: LocalOrder) => void
  patchLocalOrder: (key: string, patch: Partial<LocalOrder>) => void
  removeLocalOrder: (key: string) => void
  /** Подрезать хвост синхронизированных эхо (журнал не растёт бесконечно) */
  pruneSynced: () => void
}

export const useOutboxStore = create<OutboxState>()(
  persist(
    (set, get) => ({
      ops: [],
      idMap: {},
      localOrders: {},
      provisionalDay: localDay(),
      provisionalN: 0,

      enqueue: (op) => set((s) => ({ ops: [...s.ops, op] })),

      markInflight: (id) =>
        set((s) => ({
          ops: s.ops.map((o) => (o.id === id ? { ...o, status: 'inflight' as const } : o)),
        })),

      markPending: (id, err) =>
        set((s) => ({
          ops: s.ops.map((o) =>
            o.id === id ? { ...o, status: 'pending' as const, attempts: o.attempts + 1, lastError: err } : o
          ),
        })),

      markFailed: (id, err) =>
        set((s) => {
          const op = s.ops.find((o) => o.id === id)
          const orders = { ...s.localOrders }
          // Эхо заказа подсвечиваем как проблемное
          if (op?.orderKey && orders[op.orderKey]) {
            orders[op.orderKey] = { ...orders[op.orderKey], status: 'failed' }
          }
          return {
            ops: s.ops.map((o) =>
              o.id === id ? { ...o, status: 'failed' as const, attempts: o.attempts + 1, lastError: err } : o
            ),
            localOrders: orders,
          }
        }),

      markBlockedAuth: (id) =>
        set((s) => ({
          ops: s.ops.map((o) =>
            o.id === id ? { ...o, status: 'blocked_auth' as const } : o
          ),
        })),

      unblockAuth: () =>
        set((s) => ({
          ops: s.ops.map((o) =>
            o.status === 'blocked_auth' ? { ...o, status: 'pending' as const } : o
          ),
        })),

      markQuarantined: (id) =>
        set((s) => {
          const op = s.ops.find((o) => o.id === id)
          const orders = { ...s.localOrders }
          if (op?.orderKey && orders[op.orderKey]) {
            orders[op.orderKey] = { ...orders[op.orderKey], status: 'failed' }
          }
          return {
            ops: s.ops.map((o) => (o.id === id ? { ...o, status: 'quarantined' as const } : o)),
            localOrders: orders,
          }
        }),

      retryFailed: (id) =>
        set((s) => {
          const op = s.ops.find((o) => o.id === id)
          const orders = { ...s.localOrders }
          if (op?.orderKey && orders[op.orderKey]?.status === 'failed') {
            orders[op.orderKey] = { ...orders[op.orderKey], status: 'pending' }
          }
          return {
            ops: s.ops.map((o) => (o.id === id ? { ...o, status: 'pending' as const, lastError: null } : o)),
            localOrders: orders,
          }
        }),

      removeOp: (id, serverOrderId) =>
        set((s) => {
          const op = s.ops.find((o) => o.id === id)
          const idMap = serverOrderId && op ? { ...s.idMap, [op.id]: serverOrderId } : s.idMap
          return { ops: s.ops.filter((o) => o.id !== id), idMap }
        }),

      discardOp: (id) =>
        set((s) => {
          const op = s.ops.find((o) => o.id === id)
          if (!op) return s
          const isParent = op.kind === 'order.place' || op.kind === 'table.open'
          if (isParent && op.orderKey) {
            const key = op.orderKey
            const orders = { ...s.localOrders }
            delete orders[key]
            return { ops: s.ops.filter((o) => o.orderKey !== key), localOrders: orders, idMap: s.idMap }
          }
          return { ops: s.ops.filter((o) => o.id !== id), localOrders: s.localOrders, idMap: s.idMap }
        }),

      dropUnsent: (orderKey) =>
        set((s) => {
          const rest = s.ops.filter((o) => !(o.orderKey === orderKey && o.status === 'pending'))
          const orders = { ...s.localOrders }
          // Группа опустела и заказ не долетал до сервера → эхо не нужно
          if (!rest.some((o) => o.orderKey === orderKey) && !s.idMap[orderKey]) {
            delete orders[orderKey]
          }
          return { ops: rest, localOrders: orders }
        }),

      nextProvisionalNumber: () => {
        const day = localDay()
        const n = get().provisionalDay === day ? get().provisionalN + 1 : 1
        set({ provisionalDay: day, provisionalN: n })
        return `K-${n}`
      },

      upsertLocalOrder: (o) => set((s) => ({ localOrders: { ...s.localOrders, [o.key]: o } })),

      patchLocalOrder: (key, patch) =>
        set((s) => {
          const cur = s.localOrders[key]
          if (!cur) return s
          return { localOrders: { ...s.localOrders, [key]: { ...cur, ...patch } } }
        }),

      removeLocalOrder: (key) =>
        set((s) => {
          const orders = { ...s.localOrders }
          delete orders[key]
          return { localOrders: orders }
        }),

      pruneSynced: () =>
        set((s) => {
          const synced = Object.values(s.localOrders)
            .filter((o) => o.status === 'synced')
            .sort((a, b) => (b.syncedAt ?? '').localeCompare(a.syncedAt ?? ''))
          if (synced.length <= SYNCED_KEEP) return s
          const orders = { ...s.localOrders }
          for (const o of synced.slice(SYNCED_KEEP)) delete orders[o.key]
          return { localOrders: orders }
        }),
    }),
    {
      name: 'kassa-outbox',
      // Краш между markInflight и ответом сервера: операция могла и долететь,
      // и нет. Возвращаем в pending — replay безопасен (идемпотентность 042).
      // Legacy-операции без scope не пытаемся угадать: сразу карантин.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const quarantinedOrderKeys = new Set(
          state.ops.filter((o) => !o.scope).map((o) => o.orderKey).filter((key): key is string => Boolean(key))
        )
        const localOrders = { ...state.localOrders }
        for (const key of quarantinedOrderKeys) {
          if (localOrders[key]) localOrders[key] = { ...localOrders[key], status: 'failed' }
        }
        useOutboxStore.setState({
          ops: state.ops.map((o) => {
            if (!o.scope) {
              return {
                ...o,
                status: 'quarantined' as const,
                lastError: 'legacy operation without device scope',
              }
            }
            return o.status === 'inflight' ? { ...o, status: 'pending' as const } : o
          }),
          localOrders,
        })
      },
    }
  )
)

/** Операций ждёт отправки (для бейджа). blocked_auth — тоже в очереди (ждёт PIN) */
export function pendingOpsCount(s: { ops: OutboxOp[] }): number {
  return s.ops.filter(
    (o) => o.status === 'pending' || o.status === 'inflight' || o.status === 'blocked_auth'
  ).length
}

/** Есть операция, требующая ручного разбора: доменный сбой или чужой scope
 *  (blocked_auth сюда НЕ входит — решается PIN-ом, не разбором) */
export function hasFailedOps(s: { ops: OutboxOp[] }): boolean {
  return s.ops.some((o) => o.status === 'failed' || o.status === 'quarantined')
}

/** Очередь стоит и ждёт PIN-вход (голова — привилегированная операция без сессии) */
export function hasBlockedAuthOps(s: { ops: OutboxOp[] }): boolean {
  return s.ops.some((o) => o.status === 'blocked_auth')
}
