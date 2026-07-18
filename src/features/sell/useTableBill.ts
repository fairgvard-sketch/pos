import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { appendToOrder, voidTableOrder, fetchOrderLines, voidOrderItem, setOrderDiscount, type BillLine } from '../tables/api'
import { useCartStore, cartSubtotal, lineUnitPrice, type CartDiscount } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { printKitchenTicket } from '../receipt/printService'
import { OfflineError, withOfflineFallback } from '../../lib/offline/net'
import { failedNoCache } from '../../lib/queryState'
import { enqueueTableAppend, enqueueTableVoid } from '../../lib/offline/enqueue'
import { useOutboxStore } from '../../lib/offline/outboxStore'
import { t } from '../../lib/i18n'
import { toTicketLine } from './ticket'
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
  // Строки счёта: серверные + офлайн-дозаказы из эха
  const existingLines = useMemo<BillLine[]>(() => {
    const echoLines: BillLine[] = (tableEcho?.lines ?? []).map((l) => ({
      id: l.key,
      name: l.name,
      variant_name: l.variantName,
      qty: l.qty,
      line_total: lineUnitPrice(l) * l.qty,
      modifiers: l.mods.map((m) => m.name),
      notes: l.notes.trim() || null,
    }))
    return [...fetchedLines, ...echoLines]
  }, [fetchedLines, tableEcho])
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

  // Режим столов: сохранить дозаказ в открытый счёт (остаётся open) → назад в зал.
  // Локальный стол → всегда в очередь (FIFO за open); серверный + обрыв сети →
  // в очередь с тем же op_uuid (если вызов долетел, replay не задвоит строки).
  const saveBill = useMutation({
    mutationFn: async () => {
      const c = useCartStore.getState()
      const key = tableCtx!.orderId
      if (isLocalTable) {
        enqueueTableAppend({
          orderKey: key,
          orderId: null,
          staffId: staff!.id,
          lines: c.lines,
          totalAfter: (tableEcho?.total ?? 0) + cartSubtotal(c.lines),
        })
        return
      }
      const opUuid = crypto.randomUUID()
      try {
        await withOfflineFallback(() => appendToOrder(key, staff!.id, c.lines, opUuid))
      } catch (e) {
        if (e instanceof OfflineError) {
          enqueueTableAppend({
            orderKey: key,
            orderId: key,
            staffId: staff!.id,
            lines: c.lines,
            totalAfter: tableCtx!.existingTotal + cartSubtotal(c.lines),
            opUuid,
            tableId: tableCtx!.tableId,
            tableLabel: tableCtx!.tableLabel,
          })
          return
        }
        throw e
      }
    },
    onSuccess: () => {
      toast.success(t(lang, 'billSaved'))
      // Тикет на кухню для дозаказа: только новые позиции, без номера
      if (kitchenTicketOn && cart.lines.length > 0) {
        void printKitchenTicket(
          {
            dailyNumber: null,
            orderType: 'here',
            customerName: cart.customerName,
            tableLabel: tableCtx!.tableLabel,
            staffName: staff?.name ?? '',
            deviceName,
            lines: cart.lines.map(toTicketLine),
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
      if (isLocalTable) {
        let totalAfter = tableEcho?.total ?? tableCtx!.existingTotal
        if (c.lines.length > 0) {
          totalAfter += cartSubtotal(c.lines)
          enqueueTableAppend({ orderKey: key, orderId: null, staffId: staff!.id, lines: c.lines, totalAfter })
        }
        return { total: totalAfter, offline: true }
      }
      const opUuid = crypto.randomUUID()
      try {
        if (c.lines.length > 0) {
          const r = await withOfflineFallback(() => appendToOrder(key, staff!.id, c.lines, opUuid))
          return { total: r.total, offline: false }
        }
        return { total: tableCtx!.existingTotal, offline: false }
      } catch (e) {
        if (e instanceof OfflineError) {
          const totalAfter = tableCtx!.existingTotal + cartSubtotal(c.lines)
          enqueueTableAppend({
            orderKey: key,
            orderId: key,
            staffId: staff!.id,
            lines: c.lines,
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
      })
    },
    onError: (e) => toast.error(e.message),
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
  }
}
