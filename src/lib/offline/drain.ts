import type { QueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { placeOrder, payOrder, type PayOrderResult, type PlaceOrderResult } from '../../features/sell/api'
import {
  openTableOrder,
  appendToOrder,
  voidTableOrder,
  setOrderDiscount,
  voidOrderItem,
  type TableOrderResult,
} from '../../features/tables/api'
import { markItemReady, markOrderReady } from '../../features/queue/api'
import { supabase } from '../supabase'
import { t } from '../i18n'
import { useLangStore } from '../../store/langStore'
import { currentStaffToken, useAuthStore } from '../../store/authStore'
import { isNetworkishError, isOnline, kickProbe, markOffline, useNetStore } from './net'
import { useOutboxStore } from './outboxStore'
import { opInCurrentScope, refreshScope } from './scope'
import type { OpKind, OutboxOp } from './types'

/**
 * Движок replay офлайн-очереди. Строгий FIFO: обрабатывается всегда
 * голова очереди — операции зависят друг от друга (pay после place,
 * append после open). Ошибки:
 *   * сетевые → операция остаётся pending, attempts++, ретрай с backoff;
 *   * доменные (нет смены, не хватает оплаты...) → failed, очередь СТОИТ
 *     до ручного retry/discard (красный бейдж) — иначе потеряем зависимости.
 */

/** Таймаут одного вызова при дренаже (спокойнее боевых 4с — кассир не ждёт) */
const DRAIN_TIMEOUT_MS = 12000
const RETRY_MAX_MS = 30000
/** Страховочный тик: будим дренаж, даже если все сигналы потерялись */
const SAFETY_TICK_MS = 30000

let qc: QueryClient | null = null
let draining = false
let retryTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Операции, которым нужна staff-сессия (сервер требует p_staff_session,
 * право проверяется require_staff_perm). Их нельзя реплеить без PIN:
 * в строгом режиме (045) сервер ответит «staff session required», в мягком
 * (044) операция прошла бы с NULL-авторизацией — обе ветки нежелательны,
 * ждём реальную сессию. Остальные (place/pay/open/append/queue) сессию не
 * требуют (компромисс AGENTS.md) и не блокируются.
 */
const OPS_NEED_STAFF_TOKEN: ReadonlySet<OpKind> = new Set<OpKind>([
  'table.void',
  'table.discount',
  'table.void_item',
])

function needsStaffToken(op: OutboxOp): boolean {
  return OPS_NEED_STAFF_TOKEN.has(op.kind)
}

/** Ошибка сервера про отсутствующую/протухшую staff-сессию (не доменная) */
function isAuthSessionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /staff session (required|invalid)/i.test(msg)
}

function invalidateAfterSync() {
  if (!qc) return
  for (const key of ['orders', 'current_shift', 'open_table_orders', 'order_lines', 'queue', 'shift_orders']) {
    void qc.invalidateQueries({ queryKey: [key] })
  }
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('drain timeout')), DRAIN_TIMEOUT_MS)),
  ])
}

/** Server order_id для операции: известен сразу или через idMap после синка place/open */
function resolveOrderId(op: OutboxOp): string | null {
  if (op.orderId) return op.orderId
  if (op.orderKey) return useOutboxStore.getState().idMap[op.orderKey] ?? null
  return null
}

/** Выполнить операцию против сервера. Возвращает server order_id (если появился). */
async function runOp(op: OutboxOp): Promise<string | undefined> {
  const ob = useOutboxStore.getState()
  const lang = useLangStore.getState().lang

  switch (op.kind) {
    case 'order.place': {
      const p = op.payload
      const r: PlaceOrderResult = await withTimeout(
        placeOrder(op.id, p.staffId, p.orderType, p.customerName, p.lines, p.discount, p.tableLabel, null, null, op.createdAt)
      )
      if (op.orderKey) {
        ob.patchLocalOrder(op.orderKey, { serverOrderId: r.order_id, serverDailyNumber: r.daily_number })
      }
      return r.order_id
    }
    case 'table.open': {
      const p = op.payload
      const r: TableOrderResult = await withTimeout(openTableOrder(p.tableId, p.staffId, op.id, op.createdAt))
      if (op.orderKey) {
        ob.patchLocalOrder(op.orderKey, { serverOrderId: r.order_id, serverDailyNumber: r.daily_number })
      }
      return r.order_id
    }
    case 'order.pay': {
      const orderId = resolveOrderId(op)
      if (!orderId) throw new Error('offline order not synced') // доменная: place потерян
      const r: PayOrderResult = await withTimeout(payOrder(orderId, op.payload.payments, op.payload.tip, op.id, op.createdAt))
      if (op.orderKey) {
        const lo = useOutboxStore.getState().localOrders[op.orderKey]
        ob.patchLocalOrder(op.orderKey, {
          status: 'synced',
          syncedAt: new Date().toISOString(),
          serverReceiptNumber: r.receipt_number,
        })
        // «K-3 → #42 · чек №117» — кассир видит, во что превратился офлайн-заказ
        if (lo) {
          const daily = lo.serverDailyNumber
          toast.success(
            `${lo.provisionalNumber ?? ''}${daily ? ` → #${daily}` : ''} · ${t(lang, 'receiptNumber')} ${r.receipt_number}`,
            { duration: 5000 }
          )
          // Бариста уже отметил заказ готовым по эху — дошлём готовность,
          // чтобы оплаченный заказ не вернулся в очередь после синка
          if (lo.localFulfilled) {
            ob.enqueue({
              id: crypto.randomUUID(),
              kind: 'queue.order_ready',
              payload: {},
              orderId,
              orderKey: op.orderKey,
              createdAt: new Date().toISOString(),
              status: 'pending',
              attempts: 0,
              lastError: null,
              scope: op.scope,
            })
          }
        }
      }
      return orderId
    }
    case 'table.append': {
      const orderId = resolveOrderId(op)
      if (!orderId) throw new Error('offline order not synced')
      await withTimeout(appendToOrder(orderId, op.payload.staffId, op.payload.lines, op.id))
      return orderId
    }
    case 'table.void': {
      const orderId = resolveOrderId(op)
      if (!orderId) throw new Error('offline order not synced')
      await withTimeout(voidTableOrder(orderId, op.payload.reason ?? undefined))
      if (op.orderKey) ob.removeLocalOrder(op.orderKey)
      return orderId
    }
    case 'table.discount': {
      const orderId = resolveOrderId(op)
      if (!orderId) throw new Error('offline order not synced')
      const p = op.payload
      await withTimeout(setOrderDiscount(orderId, p.type, p.value ?? undefined, p.reason ?? undefined))
      return orderId
    }
    case 'table.void_item': {
      const p = op.payload
      await withTimeout(voidOrderItem(p.itemId, p.staffId, p.reason ?? undefined))
      return undefined
    }
    case 'queue.item_ready': {
      await withTimeout(markItemReady(op.payload.itemId, op.payload.ready))
      return undefined
    }
    case 'queue.order_ready': {
      const orderId = resolveOrderId(op)
      if (!orderId) throw new Error('offline order not synced')
      await withTimeout(markOrderReady(orderId))
      return orderId
    }
  }
}

/** Разбудить дренаж (на онлайн-переходе, после enqueue, по retry-таймеру) */
export async function kickDrain(): Promise<void> {
  if (draining) return
  if (!isOnline()) return
  if (useOutboxStore.getState().ops.length === 0) return

  draining = true
  try {
    // Токен устройства: getSession освежит его при необходимости.
    // Сбой auth = сетевая проблема, не доменная — просто ждём следующего тика.
    const { data } = await supabase.auth.getSession()
    if (!data.session) return

    // Актуализируем scope текущей сессии перед сверкой с операциями (P3)
    await refreshScope()

    for (;;) {
      if (!isOnline()) break
      const op = useOutboxStore.getState().ops[0]
      if (!op) break
      if (op.status === 'failed') break // очередь стоит до ручного разбора
      if (op.status === 'quarantined') break // чужой scope, ручной разбор
      if (op.status === 'blocked_auth') break // ждём PIN (см. подписку в initDrain)

      // Чужой scope (P3): операция поставлена под другим аккаунтом устройства/
      // организации. Отправить её под текущей сессией нельзя (чужой org_id в
      // JWT) — в карантин, очередь стоит до ручного разбора.
      if (!opInCurrentScope(op.scope)) {
        useOutboxStore.getState().markQuarantined(op.id)
        break
      }

      // Привилегированная операция без PIN-сессии: не доменная ошибка —
      // ставим на паузу до ввода PIN, очередь продолжится сама (unblockAuth).
      // Иначе сервер (045 строгий) ответил бы «staff session required» и
      // операция ушла бы в failed, застопорив весь FIFO.
      if (needsStaffToken(op) && !currentStaffToken()) {
        useOutboxStore.getState().markBlockedAuth(op.id)
        break
      }

      useOutboxStore.getState().markInflight(op.id)
      try {
        const serverOrderId = await runOp(op)
        useOutboxStore.getState().removeOp(op.id, serverOrderId)
        invalidateAfterSync()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (isNetworkishError(e)) {
          useOutboxStore.getState().markPending(op.id, msg)
          markOffline()
          void kickProbe()
          scheduleRetry(op.attempts + 1)
        } else if (isAuthSessionError(e)) {
          // Токен был, но протух/отозван между проверкой и вызовом — тоже
          // ждём свежий PIN, не считаем доменным сбоем (без красного бейджа).
          useOutboxStore.getState().markBlockedAuth(op.id)
        } else {
          useOutboxStore.getState().markFailed(op.id, msg)
          const lang = useLangStore.getState().lang
          toast.error(`${t(lang, 'offlineOpFailed')}: ${msg}`, { duration: 6000 })
        }
        break
      }
    }

    if (useOutboxStore.getState().ops.length === 0) {
      useOutboxStore.getState().pruneSynced()
    }
  } finally {
    draining = false
  }
}

function scheduleRetry(attempts: number) {
  if (retryTimer !== null) return
  const delay = Math.min(1000 * 2 ** attempts, RETRY_MAX_MS)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void kickDrain()
  }, delay)
}

let inited = false

/** Подключение движка: QueryClient для инвалидаций + сигналы пробуждения */
export function initDrain(client: QueryClient): void {
  qc = client
  if (inited) return
  inited = true
  // Переход офлайн → онлайн будит дренаж
  useNetStore.subscribe((s, prev) => {
    if (s.online && !prev.online) void kickDrain()
  })
  // PIN-вход (появилась staff-сессия) снимает блокировку blocked_auth и
  // продолжает очередь: привилегированные офлайн-операции (void/скидка/
  // void-item), отложенные из-за отсутствия сессии, реплеятся под новым PIN.
  useAuthStore.subscribe((s, prev) => {
    if (s.staff?.session_token && !prev.staff?.session_token) {
      useOutboxStore.getState().unblockAuth()
      void kickDrain()
    }
  })
  setInterval(() => void kickDrain(), SAFETY_TICK_MS)
  // Хвост с прошлой сессии
  void kickDrain()
}
