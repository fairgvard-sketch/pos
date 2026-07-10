import type { CartDiscount, CartLine, OrderType } from '../../store/cartStore'
import type { PaymentInput } from '../../features/sell/api'
import type { Receipt } from '../../features/receipt/api'
import { useOutboxStore } from './outboxStore'
import { kickDrain } from './drain'
import type { LocalOrder, OutboxOp } from './types'

/**
 * Типизированные помощники постановки операций в офлайн-очередь.
 * Каждый помощник обновляет и локальное эхо заказа (LocalOrder) —
 * очередь бариста/операции видят офлайн-заказ сразу, до синка.
 */

function nowIso(): string {
  return new Date().toISOString()
}

function opBase(orderKey: string | null, orderId: string | null) {
  return {
    createdAt: nowIso(),
    status: 'pending' as const,
    attempts: 0,
    lastError: null,
    orderKey,
    orderId,
  }
}

/**
 * Офлайн-продажа у стойки: place + pay одной группой + эхо с временным
 * чеком. clientUuid корзины становится ключом группы (и p_client_uuid
 * place_order при replay). Возвращает локальный номер K-n для экрана.
 */
export function enqueueOfflineSale(args: {
  clientUuid: string
  staffId: string
  orderType: OrderType
  customerName: string
  tableLabel: string
  lines: CartLine[]
  discount: CartDiscount | null
  payments: PaymentInput[]
  tip: number
  total: number
  /** Временный чек строится после присвоения K-n (номер печатается в чеке) */
  buildReceipt: (provisionalNumber: string) => Receipt
}): { provisionalNumber: string } {
  const ob = useOutboxStore.getState()
  const provisionalNumber = ob.nextProvisionalNumber()
  const key = args.clientUuid

  const placeOp: OutboxOp = {
    ...opBase(key, null),
    id: key, // p_client_uuid — идемпотентность place_order
    kind: 'order.place',
    payload: {
      staffId: args.staffId,
      orderType: args.orderType,
      customerName: args.customerName,
      tableLabel: args.tableLabel,
      lines: args.lines,
      discount: args.discount,
    },
  }
  const payOp: OutboxOp = {
    ...opBase(key, null),
    id: crypto.randomUUID(), // p_payment_uuid — идемпотентность pay_order
    kind: 'order.pay',
    payload: { payments: args.payments, tip: args.tip },
  }
  const echo: LocalOrder = {
    key,
    kind: 'counter',
    provisionalNumber,
    createdAt: nowIso(),
    status: 'pending',
    orderType: args.orderType,
    customerName: args.customerName,
    tableId: null,
    tableLabel: args.tableLabel || null,
    lines: args.lines,
    receipt: args.buildReceipt(provisionalNumber),
    total: args.total,
    serverOrderId: null,
    serverDailyNumber: null,
    serverReceiptNumber: null,
    syncedAt: null,
  }

  ob.enqueue(placeOp)
  ob.enqueue(payOp)
  ob.upsertLocalOrder(echo)
  void kickDrain()
  return { provisionalNumber }
}

/**
 * Оплата заказа, УЖЕ созданного на сервере (place прошёл, сеть упала
 * на pay; либо оплата счёта стола, открытого онлайн). Эхо получает
 * серверные номера сразу — временный чек печатается с ними.
 */
export function enqueueOfflinePayment(args: {
  orderId: string
  dailyNumber: number | null
  orderType: OrderType
  customerName: string
  tableLabel: string | null
  lines: CartLine[]
  payments: PaymentInput[]
  tip: number
  total: number
  receipt: Receipt
  /**
   * UUID УЖЕ предпринятой попытки pay_order (таймаут ≠ не долетело):
   * replay с тем же ключом вернёт результат первой попытки, если она
   * успела пройти, вместо 'order not open'.
   */
  paymentUuid?: string
}): { key: string } {
  const ob = useOutboxStore.getState()
  const key = crypto.randomUUID()

  const payOp: OutboxOp = {
    ...opBase(key, args.orderId),
    id: args.paymentUuid ?? crypto.randomUUID(),
    kind: 'order.pay',
    payload: { payments: args.payments, tip: args.tip },
  }
  const echo: LocalOrder = {
    key,
    kind: args.tableLabel ? 'table' : 'counter',
    provisionalNumber: null, // серверный номер уже известен
    createdAt: nowIso(),
    status: 'pending',
    orderType: args.orderType,
    customerName: args.customerName,
    tableId: null,
    tableLabel: args.tableLabel,
    lines: args.lines,
    receipt: args.receipt,
    total: args.total,
    serverOrderId: args.orderId,
    serverDailyNumber: args.dailyNumber,
    serverReceiptNumber: null,
    syncedAt: null,
  }

  ob.enqueue(payOp)
  ob.upsertLocalOrder(echo)
  void kickDrain()
  return { key }
}

/** Офлайн-открытие стола: эхо занимает стол на карте зала до синка */
export function enqueueTableOpen(args: { key: string; tableId: string; tableLabel: string; staffId: string }): void {
  const ob = useOutboxStore.getState()
  const openOp: OutboxOp = {
    ...opBase(args.key, null),
    id: args.key, // p_client_uuid — идемпотентность open_or_get_table_order
    kind: 'table.open',
    payload: { tableId: args.tableId, staffId: args.staffId },
  }
  const echo: LocalOrder = {
    key: args.key,
    kind: 'table',
    provisionalNumber: null,
    createdAt: nowIso(),
    status: 'pending',
    orderType: 'here',
    customerName: '',
    tableId: args.tableId,
    tableLabel: args.tableLabel,
    lines: [],
    receipt: null,
    total: 0,
    serverOrderId: null,
    serverDailyNumber: null,
    serverReceiptNumber: null,
    syncedAt: null,
  }
  ob.enqueue(openOp)
  ob.upsertLocalOrder(echo)
  void kickDrain()
}

/** Офлайн-дозаказ. orderKey — локальный ключ стола; orderId — если счёт серверный */
export function enqueueTableAppend(args: {
  orderKey: string
  orderId: string | null
  staffId: string
  lines: CartLine[]
  totalAfter: number
  /** UUID уже предпринятой попытки append_to_order (таймаут ≠ не долетело) */
  opUuid?: string
  /** Для создания эха серверного счёта, если его ещё нет */
  tableId?: string | null
  tableLabel?: string | null
}): void {
  const ob = useOutboxStore.getState()
  const op: OutboxOp = {
    ...opBase(args.orderKey, args.orderId),
    id: args.opUuid ?? crypto.randomUUID(), // p_op_uuid — идемпотентность append_to_order
    kind: 'table.append',
    payload: { staffId: args.staffId, lines: args.lines },
  }
  ob.enqueue(op)
  const echo = ob.localOrders[args.orderKey]
  if (echo) {
    ob.patchLocalOrder(args.orderKey, { lines: [...echo.lines, ...args.lines], total: args.totalAfter })
  } else {
    // Серверный счёт, офлайн-дозаказ: эхо хранит добавленные строки,
    // чтобы при повторном входе в стол их было видно без сети
    ob.upsertLocalOrder({
      key: args.orderKey,
      kind: 'table',
      provisionalNumber: null,
      createdAt: nowIso(),
      status: 'pending',
      orderType: 'here',
      customerName: '',
      tableId: args.tableId ?? null,
      tableLabel: args.tableLabel ?? null,
      lines: args.lines,
      receipt: null,
      total: args.totalAfter,
      serverOrderId: args.orderId,
      serverDailyNumber: null,
      serverReceiptNumber: null,
      syncedAt: null,
    })
  }
  void kickDrain()
}

/**
 * Оплата счёта СТОЛА офлайн. Эхо стола уже существует (открыт офлайн)
 * либо создаётся здесь (серверный счёт, сеть упала на оплате).
 * После установки receipt стол на карте зала освобождается.
 */
export function enqueueTablePayment(args: {
  /** Локальный ключ эха ИЛИ серверный order_id (эхо кейсится по нему же) */
  orderKey: string
  /** Серверный order_id, если счёт существует на сервере */
  orderId: string | null
  tableId: string | null
  tableLabel: string | null
  payments: PaymentInput[]
  tip: number
  total: number
  receipt: Receipt
  provisionalNumber: string | null
  dailyNumber: number | null
  /** UUID уже предпринятой попытки pay_order (см. enqueueOfflinePayment) */
  paymentUuid?: string
}): void {
  const ob = useOutboxStore.getState()
  const payOp: OutboxOp = {
    ...opBase(args.orderKey, args.orderId),
    id: args.paymentUuid ?? crypto.randomUUID(),
    kind: 'order.pay',
    payload: { payments: args.payments, tip: args.tip },
  }
  ob.enqueue(payOp)
  const echo = ob.localOrders[args.orderKey]
  if (echo) {
    ob.patchLocalOrder(args.orderKey, {
      receipt: args.receipt,
      total: args.total,
      provisionalNumber: echo.provisionalNumber ?? args.provisionalNumber,
      serverDailyNumber: echo.serverDailyNumber ?? args.dailyNumber,
    })
  } else {
    ob.upsertLocalOrder({
      key: args.orderKey,
      kind: 'table',
      provisionalNumber: args.provisionalNumber,
      createdAt: nowIso(),
      status: 'pending',
      orderType: 'here',
      customerName: '',
      tableId: args.tableId,
      tableLabel: args.tableLabel,
      lines: [],
      receipt: args.receipt,
      total: args.total,
      serverOrderId: args.orderId,
      serverDailyNumber: args.dailyNumber,
      serverReceiptNumber: null,
      syncedAt: null,
    })
  }
  void kickDrain()
}

/** Офлайн-отмена счёта стола (эхо снимает занятость после синка void) */
export function enqueueTableVoid(args: { orderKey: string; orderId: string | null; reason?: string }): void {
  const ob = useOutboxStore.getState()
  const op: OutboxOp = {
    ...opBase(args.orderKey, args.orderId),
    id: crypto.randomUUID(),
    kind: 'table.void',
    payload: { reason: args.reason ?? null },
  }
  ob.enqueue(op)
  void kickDrain()
}

/** Скидка на счёт стола офлайн (идемпотентна на сервере — абсолютная установка) */
export function enqueueTableDiscount(args: {
  orderKey: string
  orderId: string | null
  type: 'percent' | 'fixed' | null
  value: number | null
  reason: string | null
}): void {
  const ob = useOutboxStore.getState()
  const op: OutboxOp = {
    ...opBase(args.orderKey, args.orderId),
    id: crypto.randomUUID(),
    kind: 'table.discount',
    payload: { type: args.type, value: args.value, reason: args.reason },
  }
  ob.enqueue(op)
  void kickDrain()
}

/** Снять СЕРВЕРНУЮ позицию со счёта офлайн (для локальных правится payload append) */
export function enqueueVoidItem(args: { orderKey: string | null; itemId: string; staffId: string; reason?: string }): void {
  const ob = useOutboxStore.getState()
  const op: OutboxOp = {
    ...opBase(args.orderKey, null),
    id: crypto.randomUUID(),
    kind: 'table.void_item',
    payload: { itemId: args.itemId, staffId: args.staffId, reason: args.reason ?? null },
  }
  ob.enqueue(op)
  void kickDrain()
}

/** Экран бариста офлайн: готовность СЕРВЕРНЫХ позиций/заказов — в очередь */
export function enqueueItemReady(itemId: string, ready: boolean): void {
  const ob = useOutboxStore.getState()
  ob.enqueue({
    ...opBase(null, null),
    id: crypto.randomUUID(),
    kind: 'queue.item_ready',
    payload: { itemId, ready },
  })
  void kickDrain()
}

export function enqueueOrderReady(orderId: string): void {
  const ob = useOutboxStore.getState()
  ob.enqueue({
    ...opBase(null, orderId),
    id: crypto.randomUUID(),
    kind: 'queue.order_ready',
    payload: {},
  })
  void kickDrain()
}
