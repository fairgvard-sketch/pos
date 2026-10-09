import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { appendToOrder, voidTableOrder, fetchOrderLines, voidOrderItem, setOrderDiscount, fireOrderItems, voidBillLine, moveBillLines, type BillLine, type BillTicketLine } from '../tables/api'
import { useCartStore, cartSubtotal, lineUnitPrice, type CartDiscount, type CartLine } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { printKitchenTicket } from '../receipt/printService'
import { OfflineError, withOfflineFallback, useNetStore } from '../../lib/offline/net'
import { failedNoCache } from '../../lib/queryState'
import { enqueueTableAppend, enqueueTableVoid, enqueueTableFire, firedPendingIds } from '../../lib/offline/enqueue'
import { useOutboxStore } from '../../lib/offline/outboxStore'
import { t } from '../../lib/i18n'
import { toTicketLine, billLineToTicketLine } from './ticket'
import { heldLineKeys, normalizeCourse } from './courses'
import type { PayingOrder } from './usePayFlow'

/**
 * Открытый счёт стола на экране продажи (cart.tableCtx задан): уже
 * заказанные строки, скидка счёта, снятие позиции, дозаказ, оплата и
 * отмена счёта — с офлайн-ветками через outbox (FIFO за table.open).
 * Оплату счёта запускает payFlow: хук получает его startPayment.
 */
export function useTableBill(startPayment: (o: PayingOrder) => void) {
  const lang = useLangStore((s) => s.lang)
  const staff = useAuthStore((s) => s.staff)
  const printMode = useDeviceStore((s) => s.printMode)
  const kitchenTicketOn = useDeviceStore((s) => s.printKitchenTicket)
  const deviceName = useDeviceStore((s) => s.deviceName)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const cart = useCartStore()
  const tableCtx = cart.tableCtx

  // Офлайн (фаза 7): эхо счёта стола. Ключ = tableCtx.orderId — локальный
  // uuid (стол открыт офлайн) либо серверный order_id (офлайн-дозаказ к
  // серверному счёту). isLocalTable = счёт существует только на кассе.
  const tableEcho = useOutboxStore((s) => (tableCtx ? s.localOrders[tableCtx.orderId] : undefined))
  const isLocalTable = !!tableEcho && tableEcho.serverOrderId === null
  const online = useNetStore((s) => s.online)
  // Fire без сети (179): серверные строки, отправленные из очереди, уже не
  // ждут — оверлей держится, пока операция не доехала (переживает рестарт)
  const ops = useOutboxStore((s) => s.ops)
  const firedPending = useMemo(() => firedPendingIds(ops), [ops])

  // Уже заказанные позиции открытого счёта стола (read-only, до дозаказа).
  // cart.lines в режиме стола = только НОВЫЕ позиции, поэтому существующие
  // тянем отдельно, чтобы бариста/кассир видел, что уже на столе.
  const linesQ = useQuery({
    queryKey: ['order_lines', tableCtx?.orderId],
    queryFn: () => fetchOrderLines(tableCtx!.orderId),
    enabled: !!tableCtx && !isLocalTable,
  })
  const { data: fetchedLines = [] } = linesQ
  // Строки счёта не загрузились и кэша нет: счёт занятого стола нельзя рисовать
  // пустым — кассир не видит, что уже заказано (P1-7). Ошибку показывает SellPage.
  const billLinesFailed = failedNoCache(linesQ)
  const retryBillLines = () => { void linesQ.refetch() }
  // Строки счёта: серверные + офлайн-дозаказы из эха. Эхо дозаказа к
  // серверному счёту переживает синк; строка с id кассы (179), уже
  // пришедшая с сервера, второй раз не рисуется.
  const existingLines = useMemo<BillLine[]>(() => {
    const serverIds = new Set(fetchedLines.map((l) => l.id))
    const echoLines: BillLine[] = (tableEcho?.lines ?? []).map((l) => ({
      // id кассы (179) — тот же, что получит строка на сервере
      id: l.lineId ?? l.key,
      name: l.name,
      variant_name: l.variantName,
      qty: l.qty,
      line_total: lineUnitPrice(l) * l.qty,
      modifiers: l.mods.map((m) => m.name),
      notes: l.notes.trim() || null,
      course: normalizeCourse(l.course),
      held: l.held === true,
    })).filter((l) => !serverIds.has(l.id))
    const server = fetchedLines.map((l) => (l.held && firedPending.has(l.id) ? { ...l, held: false } : l))
    return [...server, ...echoLines]
  }, [fetchedLines, tableEcho, firedPending])
  // Строки, которых сервер ещё не знает (офлайн-дозаказ в пути)
  const unsyncedIds = useMemo(() => {
    const serverIds = new Set(fetchedLines.map((l) => l.id))
    return new Set(existingLines.filter((l) => !serverIds.has(l.id)).map((l) => l.id))
  }, [existingLines, fetchedLines])
  const existingSubtotal = existingLines.reduce((s, l) => s + l.line_total, 0)

  // Скидка на счёт стола живёт на ЗАКАЗЕ (не в корзине): ставится RPC
  // set_order_discount. Локально помним последнюю применённую — для бейджа
  // и предзаполнения диалога в рамках текущего захода на стол.
  const [tableDiscount, setTableDiscount] = useState<(CartDiscount & { amount: number }) | null>(null)
  // Сброс при переходе на другой счёт стола (сравнение с прошлым orderId в
  // рендере вместо setState в эффекте)
  const [prevDiscOrderId, setPrevDiscOrderId] = useState(tableCtx?.orderId)
  if (tableCtx?.orderId !== prevDiscOrderId) {
    setPrevDiscOrderId(tableCtx?.orderId)
    setTableDiscount(null)
  }

  const orderDiscount = useMutation({
    mutationFn: (d: CartDiscount | null) =>
      setOrderDiscount(tableCtx!.orderId, d?.type ?? null, d?.value, d?.reason),
    onSuccess: (res, d) => {
      cart.setTableCtx({ ...tableCtx!, existingTotal: res.total })
      setTableDiscount(d ? { ...d, amount: res.discount_amount } : null)
      qc.invalidateQueries({ queryKey: ['open_table_orders'] })
    },
    onError: (e) => toast.error(e.message),
  })

  // Снять уже заказанную позицию с открытого счёта (мягкий void)
  const voidItem = useMutation({
    mutationFn: (itemId: string) => voidOrderItem(itemId, staff!.id),
    onSuccess: (res) => {
      // Обновляем локальный существующий total, чтобы итог/шапка сразу сошлись
      if (tableCtx) cart.setTableCtx({ ...tableCtx, existingTotal: res.total })
      qc.invalidateQueries({ queryKey: ['order_lines', tableCtx!.orderId] })
      qc.invalidateQueries({ queryKey: ['open_table_orders'] })
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
    onError: (e) => toast.error(e.message),
  })

  // ── Правка отправленных позиций (181) ─────────────────────
  /** Тикет кухни об отмене или переносе: придержанное кухня не видела */
  function printEditTicket(lines: BillTicketLine[], kind: 'void' | 'move', tableLabel: string, movedTo?: string) {
    const visible = lines.filter((l) => !l.held)
    if (!kitchenTicketOn || visible.length === 0) return
    void printKitchenTicket(
      {
        dailyNumber: null,
        orderType: 'here',
        customerName: '',
        tableLabel,
        staffName: staff?.name ?? '',
        deviceName,
        lines: visible.map((l) => ({ qty: l.qty, name: l.name, variantName: l.variantName, modifiers: l.modifiers, notes: l.notes })),
        kind,
        movedTo,
      },
      printMode === 'rawbt'
    )
  }

  function refreshBill() {
    qc.invalidateQueries({ queryKey: ['order_lines', tableCtx?.orderId] })
    qc.invalidateQueries({ queryKey: ['open_table_orders'] })
    qc.invalidateQueries({ queryKey: ['queue'] })
  }

  /** Убрать отправленную позицию (целиком или часть) по PIN менеджера */
  const voidLine = useMutation({
    mutationFn: (v: { lineId: string; qty: number | null; reason: string; pin: string; opUuid: string }) =>
      voidBillLine(v.lineId, v.qty, v.reason, v.pin, v.opUuid),
    onSuccess: (res) => {
      if (!res.ok) return
      if (tableCtx) cart.setTableCtx({ ...tableCtx, existingTotal: res.total })
      toast.success(t(lang, 'lineRemoved'))
      printEditTicket(res.ticket_lines, 'void', tableCtx?.tableLabel ?? res.table_label ?? '')
      refreshBill()
    },
    onError: (e) => toast.error(e.message),
  })

  /** Перенести позиции на другой стол; опустевший стол — назад в зал */
  const moveLines = useMutation({
    mutationFn: (v: { lineIds: string[]; toTableId: string; opUuid: string }) =>
      moveBillLines(v.lineIds, v.toTableId, v.opUuid),
    onSuccess: (res) => {
      toast.success(t(lang, 'lineMoved').replace('{n}', res.to_label))
      printEditTicket(res.ticket_lines, 'move', tableCtx?.tableLabel ?? res.from_label ?? '', res.to_label)
      refreshBill()
      if (res.source_empty) {
        cart.clear()
        navigate('/hall')
      } else if (tableCtx) {
        cart.setTableCtx({ ...tableCtx, existingTotal: res.source_total })
      }
    },
    onError: (e) => toast.error(e.message),
  })

  /** «Ещё одну такую же» — в новые позиции, уходит кнопкой «Отправить» */
  function addOneMore(l: BillLine) {
    const mods = (l.mods ?? []).filter((m): m is { id: string; name: string; priceDelta: number } => !!m.id)
    const modsSum = mods.reduce((s, m) => s + m.priceDelta, 0)
    const custom = !l.menu_item_id
    cart.addLine({
      itemId: l.menu_item_id ?? null,
      name: l.name,
      variantId: l.variant_id ?? null,
      variantName: l.variant_name,
      basePrice: (l.unit_price ?? 0) - modsSum,
      mods,
      notes: l.notes ?? '',
      // Свободная позиция без каталога — цена только ручная
      priceOverride: custom ? (l.unit_price ?? 0) : null,
      course: l.course,
    })
    toast.success(t(lang, 'lineAddedToDraft'))
  }

  /**
   * Строки отправки (179): id строки выдаётся ДО первой попытки (повтор
   * после таймаута несёт тот же id — офлайн-Fire ссылается на него), а
   * удержание считается тем же правилом, что на сервере.
   */
  function prepareLines(lines: CartLine[]): CartLine[] {
    const held = heldLineKeys(existingLines, lines)
    return lines.map((l) => ({ ...l, lineId: l.lineId ?? crypto.randomUUID(), held: held.has(l.key) }))
  }

  // Режим столов: сохранить дозаказ в открытый счёт (остаётся open) → назад в зал.
  // Локальный стол → всегда в очередь (FIFO за open); серверный + обрыв сети →
  // в очередь с тем же op_uuid (если вызов долетел, replay не задвоит строки).
  const saveBill = useMutation({
    mutationFn: async (): Promise<CartLine[]> => {
      const c = useCartStore.getState()
      const key = tableCtx!.orderId
      const lines = prepareLines(c.lines)
      if (isLocalTable) {
        enqueueTableAppend({
          orderKey: key,
          orderId: null,
          staffId: staff!.id,
          lines,
          totalAfter: (tableEcho?.total ?? 0) + cartSubtotal(c.lines),
        })
        return lines
      }
      const opUuid = crypto.randomUUID()
      try {
        await withOfflineFallback(() => appendToOrder(key, staff!.id, lines, opUuid))
      } catch (e) {
        if (e instanceof OfflineError) {
          enqueueTableAppend({
            orderKey: key,
            orderId: key,
            staffId: staff!.id,
            lines,
            totalAfter: tableCtx!.existingTotal + cartSubtotal(c.lines),
            opUuid,
            tableId: tableCtx!.tableId,
            tableLabel: tableCtx!.tableLabel,
          })
          return lines
        }
        throw e
      }
      return lines
    },
    onSuccess: (lines) => {
      toast.success(t(lang, 'billSaved'))
      // Тикет на кухню для дозаказа: только новые позиции, без номера.
      // Придержанные курсы кухня не видит — они уйдут тикетом FIRE.
      const now = lines.filter((l) => !l.held)
      if (kitchenTicketOn && now.length > 0) {
        void printKitchenTicket(
          {
            dailyNumber: null,
            orderType: 'here',
            customerName: cart.customerName,
            tableLabel: tableCtx!.tableLabel,
            staffName: staff?.name ?? '',
            deviceName,
            lines: now.map(toTicketLine),
          },
          printMode === 'rawbt'
        )
      }
      qc.invalidateQueries({ queryKey: ['order_lines', tableCtx!.orderId] })
      cart.clear()
      qc.invalidateQueries({ queryKey: ['open_table_orders'] })
      qc.invalidateQueries({ queryKey: ['queue'] })
      navigate('/hall')
    },
    onError: (e) => toast.error(e.message),
  })

  // Режим столов: добавить новые позиции (если есть) и открыть оплату всего счёта.
  // offline-флаг уводит последующий pay в офлайн-очередь (за append'ом, FIFO).
  const billToPay = useMutation({
    mutationFn: async (): Promise<{ total: number; offline: boolean }> => {
      const c = useCartStore.getState()
      const key = tableCtx!.orderId
      const lines = prepareLines(c.lines)
      if (isLocalTable) {
        let totalAfter = tableEcho?.total ?? tableCtx!.existingTotal
        if (lines.length > 0) {
          totalAfter += cartSubtotal(lines)
          enqueueTableAppend({ orderKey: key, orderId: null, staffId: staff!.id, lines, totalAfter })
        }
        return { total: totalAfter, offline: true }
      }
      const opUuid = crypto.randomUUID()
      try {
        if (lines.length > 0) {
          const r = await withOfflineFallback(() => appendToOrder(key, staff!.id, lines, opUuid))
          return { total: r.total, offline: false }
        }
        return { total: tableCtx!.existingTotal, offline: false }
      } catch (e) {
        if (e instanceof OfflineError) {
          const totalAfter = tableCtx!.existingTotal + cartSubtotal(lines)
          enqueueTableAppend({
            orderKey: key,
            orderId: key,
            staffId: staff!.id,
            lines,
            totalAfter,
            opUuid,
            tableId: tableCtx!.tableId,
            tableLabel: tableCtx!.tableLabel,
          })
          return { total: totalAfter, offline: true }
        }
        throw e
      }
    },
    onSuccess: ({ total: billTotal, offline }) => {
      startPayment({
        orderId: tableCtx!.orderId,
        dailyNumber: tableEcho?.serverDailyNumber ?? 0,
        total: billTotal,
        intent: 'choose',
        offline,
        // Оплата отпускает придержанное (179): кухня получит его тикетом
        // вместе с позициями, добавленными перед оплатой
        releasedLines: existingLines.filter((l) => l.held).map(billLineToTicketLine),
      })
    },
    onError: (e) => toast.error(e.message),
  })

  // ── Fire (179): придержанные курсы → кухня ──────────────────
  // Выделение живёт в рамках захода на стол
  const [selectedHeld, setSelectedHeld] = useState<Set<string>>(() => new Set())
  const [prevSelOrderId, setPrevSelOrderId] = useState(tableCtx?.orderId)
  if (tableCtx?.orderId !== prevSelOrderId) {
    setPrevSelOrderId(tableCtx?.orderId)
    setSelectedHeld(new Set())
  }
  function toggleHeld(id: string) {
    setSelectedHeld((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Optimistic-first: строки отпускаются и тикет FIRE печатается сразу,
  // сеть не ждём. Без сети, у локального стола и для строк офлайн-дозаказа —
  // в очередь (FIFO: их append доедет раньше).
  const fire = useMutation({
    mutationFn: async (targets: BillLine[]) => {
      const key = tableCtx!.orderId
      const itemIds = targets.map((l) => l.id)
      // Строки офлайн-дозаказа сервер ещё не знает: Fire по ним едет
      // очередью за их append (FIFO), а не обгоняет его
      const touchesEcho = itemIds.some((id) => unsyncedIds.has(id))
      const enqueue = () => enqueueTableFire({
        orderKey: key,
        orderId: isLocalTable ? null : key,
        itemIds,
        staffId: staff!.id,
      })
      if (isLocalTable || touchesEcho || !online) {
        enqueue()
        return
      }
      try {
        await withOfflineFallback(() => fireOrderItems(itemIds, staff!.id))
      } catch (e) {
        if (e instanceof OfflineError) {
          enqueue()
          return
        }
        throw e
      }
    },
    onMutate: async (targets) => {
      const ids = new Set(targets.map((l) => l.id))
      const linesKey = ['order_lines', tableCtx!.orderId]
      await qc.cancelQueries({ queryKey: linesKey })
      const prev = qc.getQueryData<BillLine[]>(linesKey)
      qc.setQueryData<BillLine[]>(linesKey, (old) =>
        old?.map((l) => (ids.has(l.id) ? { ...l, held: false } : l))
      )
      setSelectedHeld(new Set())
      toast.success(t(lang, 'fireSent'))
      if (kitchenTicketOn) {
        void printKitchenTicket(
          {
            dailyNumber: null,
            orderType: 'here',
            customerName: '',
            tableLabel: tableCtx!.tableLabel,
            staffName: staff?.name ?? '',
            deviceName,
            lines: targets.map(billLineToTicketLine),
            fire: true,
          },
          printMode === 'rawbt'
        )
      }
      return { prev }
    },
    onError: (e, _targets, ctx) => {
      if (ctx?.prev) qc.setQueryData(['order_lines', tableCtx?.orderId], ctx.prev)
      toast.error(e.message)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['order_lines', tableCtx?.orderId] })
      qc.invalidateQueries({ queryKey: ['open_table_orders'] })
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
  })

  // Режим столов: отменить пустой/ошибочный счёт.
  // Локальный стол: open ещё не ушёл → просто снять операции; ушёл → void в очередь.
  const voidBill = useMutation({
    mutationFn: async () => {
      const key = tableCtx!.orderId
      const st = useOutboxStore.getState()
      if (isLocalTable) {
        const openPending = st.ops.some((o) => o.orderKey === key && o.kind === 'table.open' && o.status === 'pending')
        if (openPending) {
          st.dropUnsent(key) // на сервер ничего не ушло — отменять нечего
        } else {
          enqueueTableVoid({ orderKey: key, orderId: null })
          st.removeLocalOrder(key) // стол освобождается сразу
        }
        return
      }
      try {
        await withOfflineFallback(() => voidTableOrder(key))
      } catch (e) {
        if (e instanceof OfflineError) {
          enqueueTableVoid({ orderKey: key, orderId: key })
          return
        }
        throw e
      }
    },
    onSuccess: () => {
      cart.clear()
      qc.invalidateQueries({ queryKey: ['open_table_orders'] })
      navigate('/hall')
    },
    onError: (e) => toast.error(e.message),
  })

  // Выход из стола («Назад»). Если счёт так и остался пустым (зашли по ошибке /
  // просто посмотреть, ничего не добавили) — отменяем пустышку, чтобы стол не
  // числился занятым. Иначе — просто выходим, счёт остаётся открытым.
  function exitTable() {
    const emptyOrder = existingLines.length === 0 && cart.lines.length === 0
    if (emptyOrder && tableCtx) {
      voidBill.mutate()
    } else {
      cart.clear()
      navigate('/hall')
    }
  }

  return {
    tableCtx, tableEcho, isLocalTable,
    existingLines, existingSubtotal, billLinesFailed, retryBillLines,
    tableDiscount, orderDiscount, voidItem,
    saveBill, billToPay, voidBill, exitTable,
    selectedHeld, toggleHeld, fire,
    voidLine, moveLines, addOneMore,
  }
}
