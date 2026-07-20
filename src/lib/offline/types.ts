import type { CartLine, CartDiscount, OrderType } from '../../store/cartStore'
import type { PaymentInput } from '../../features/sell/api'
import type { Receipt } from '../../features/receipt/api'

/**
 * Офлайн-очередь мутаций (фаза 7). Операция = отложенный вызов RPC
 * с клиентским UUID (op.id) — он же ключ идемпотентности на сервере
 * (миграция 042): replay после сбоя не дублирует деньги и строки.
 */

/**
 * pending → inflight → (удалена при успехе) | failed. На rehydrate inflight → pending.
 *
 * blocked_auth — привилегированная операция (void/скидка/void-item) ждёт
 * PIN-вход: у сотрудника нет staff-сессии (закрыл браузер → sessionStorage
 * очищен, outbox в localStorage сохранился). Это НЕ доменная ошибка — очередь
 * стоит без красного бейджа и сама продолжается после ввода PIN
 * (см. authStore-подписку в drain.ts). Отличается от failed тем, что не
 * требует ручного разбора.
 *
 * quarantined — операция другого scope (её поставили под другим аккаунтом
 * устройства/организации, P3). Её НЕЛЬЗЯ отправлять под текущей сессией
 * (чужой org_id в JWT) — держим в карантине для ручного разбора/удаления.
 */
export type OpStatus = 'pending' | 'inflight' | 'failed' | 'blocked_auth' | 'quarantined'

export interface PlacePayload {
  staffId: string
  orderType: OrderType
  customerName: string
  tableLabel: string
  lines: CartLine[]
  discount: CartDiscount | null
}

export interface PayPayload {
  payments: PaymentInput[]
  tip: number
}

export interface TableOpenPayload {
  tableId: string
  staffId: string
}

export interface TableAppendPayload {
  staffId: string
  lines: CartLine[]
}

export interface TableVoidPayload {
  reason: string | null
}

export interface TableDiscountPayload {
  type: 'percent' | 'fixed' | null
  value: number | null
  reason: string | null
}

export interface VoidItemPayload {
  itemId: string
  staffId: string
  reason: string | null
}

export interface QueueItemReadyPayload {
  itemId: string
  ready: boolean
}

export interface QueueSetUrgentPayload {
  urgent: boolean
}

interface OpBase {
  /** crypto.randomUUID() — уходит на сервер как p_client_uuid / p_payment_uuid / p_op_uuid */
  id: string
  /** Честное время операции (ISO) — уходит как p_placed_at / p_paid_at / p_opened_at */
  createdAt: string
  status: OpStatus
  attempts: number
  lastError: string | null
  /**
   * Локальный ключ заказа (= client_uuid его place/open-операции).
   * Группирует зависимые операции: pay после place, append после open.
   * После синка place/open server order_id ищется через idMap[orderKey].
   */
  orderKey: string | null
  /** Server order_id, если известен уже при постановке (заказ создан онлайн) */
  orderId: string | null
  /**
   * Scope (org:location:user), в котором операция поставлена (P3). Дренаж не
   * отправит её под другой сессией — карантин по несовпадению (scope.ts).
   * null существует только у старых persisted-записей и всегда карантинится.
   */
  scope: string | null
}

export type OutboxOp = OpBase &
  (
    | { kind: 'order.place'; payload: PlacePayload }
    | { kind: 'order.pay'; payload: PayPayload }
    | { kind: 'table.open'; payload: TableOpenPayload }
    | { kind: 'table.append'; payload: TableAppendPayload }
    | { kind: 'table.void'; payload: TableVoidPayload }
    | { kind: 'table.discount'; payload: TableDiscountPayload }
    | { kind: 'table.void_item'; payload: VoidItemPayload }
    | { kind: 'queue.item_ready'; payload: QueueItemReadyPayload }
    | { kind: 'queue.order_ready'; payload: Record<string, never> }
    | { kind: 'queue.set_urgent'; payload: QueueSetUrgentPayload }
  )

export type OpKind = OutboxOp['kind']

/**
 * Локальное эхо офлайн-заказа: пока операции не доехали до сервера,
 * заказ живёт здесь — его видно в очереди бариста, в операциях,
 * по нему печатается временный чек. После синка эхо получает
 * серверные номера и схлопывается в пользу серверных данных.
 */
export interface LocalOrder {
  /** = client_uuid place/open-операции (orderKey группы) */
  key: string
  kind: 'counter' | 'table'
  /** Локальный номер K-n — не пересекается с серверными daily_number */
  provisionalNumber: string | null
  createdAt: string
  status: 'pending' | 'synced' | 'failed'
  orderType: OrderType
  customerName: string
  tableId: string | null
  tableLabel: string | null
  /** Позиции (для эха в очереди и повторного входа в стол) */
  lines: CartLine[]
  /** Временный чек (после оплаты); null у неоплаченного счёта стола */
  receipt: Receipt | null
  /** Клиентский итог, агороты (для списков) */
  total: number
  serverOrderId: string | null
  serverDailyNumber: number | null
  serverReceiptNumber: number | null
  syncedAt: string | null
  /** Очередь бариста: ключи строк, отмеченных готовыми (до синка) */
  readyLineKeys?: string[]
  /**
   * «Всё готово» по эху: карточка уходит с экрана бариста; после синка
   * оплаты drain дошлёт mark_order_ready, чтобы заказ не вернулся в очередь.
   */
  localFulfilled?: boolean
}
