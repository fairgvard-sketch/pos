import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { placeOrder, payOrder, splitOrder, type PaymentInput } from './api'
import { fetchCurrentLocation } from '../auth/api'
import { voidTableOrder, type BillLine } from '../tables/api'
import { useCartStore, cartTotal } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { playPaymentChime } from '../../lib/sound'
import { autoPrintReceipt, autoPrintLocalReceipt, printKitchenTicket } from '../receipt/printService'
import { buildLocalReceipt, billLineToReceiptLine } from '../receipt/localReceipt'
import { setOrderBuyer, type Receipt } from '../receipt/api'
import { OfflineError, withOfflineFallback } from '../../lib/offline/net'
import { enqueueOfflineSale, enqueueOfflinePayment, enqueueTablePayment } from '../../lib/offline/enqueue'
import { useOutboxStore } from '../../lib/offline/outboxStore'
import { t } from '../../lib/i18n'
import type { PayMethodId } from '../../lib/payMethods'
import type { OrderBuyer } from './PaymentSheet'
import type { TipOption } from './TipSheet'
import { tipPercentBase, buildTipOptions } from './tipMath'
import { toTicketLine } from './ticket'

/** Заказ в потоке оплаты: после place, до pay (см. комментарий у payingOrder) */
export interface PayingOrder {
  orderId: string
  dailyNumber: number
  total: number
  intent: PayMethodId | 'choose'
  fromCart?: boolean
  /** Выбранные чаевые (агороты) — сверх total, вне базы НДС */
  tip?: number
  /**
   * Офлайн (фаза 7): заказ НЕ создан на сервере — orderId = clientUuid
   * корзины, итог посчитан на кассе (зеркало 034). Подтверждение оплаты
   * ставит place+pay в офлайн-очередь одной группой.
   */
  offline?: boolean
}

/**
 * Платёжный поток экрана продажи: place → (чаевые) → pay → чек/номер.
 * Вынесен из SellPage целиком — состояние шагов, офлайн-ветки, сплиты,
 * автопечать и завершение продажи. SellPage остаётся экраном: витрина,
 * корзина и подключение sheets к этому потоку.
 */
export function usePayFlow() {
  const lang = useLangStore((s) => s.lang)
  const staff = useAuthStore((s) => s.staff)
  const lockStaff = useAuthStore((s) => s.lock)
  const lockAfterSale = useDeviceStore((s) => s.lockAfterSale)
  const paymentSound = useDeviceStore((s) => s.paymentSound)
  const printMode = useDeviceStore((s) => s.printMode)
  const autoPrintOn = useDeviceStore((s) => s.autoPrintReceipt)
  const receiptPromptOn = useDeviceStore((s) => s.receiptPrompt)
  const kitchenTicketOn = useDeviceStore((s) => s.printKitchenTicket)
  const deviceName = useDeviceStore((s) => s.deviceName)
  const collectTips = useDeviceStore((s) => s.collectTips)
  const tipAskBeforePayment = useDeviceStore((s) => s.tipAskBeforePayment)
  const tipPresets = useDeviceStore((s) => s.tipPresets)
  const tipBeforeTax = useDeviceStore((s) => s.tipBeforeTax)
  const tipRoundUp = useDeviceStore((s) => s.tipRoundUp)
  const tipSmartAmounts = useDeviceStore((s) => s.tipSmartAmounts)
  const tipSmartThreshold = useDeviceStore((s) => s.tipSmartThreshold)
  const tipSmartFixed = useDeviceStore((s) => s.tipSmartFixed)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const cart = useCartStore()

  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const vatRate = Number(location?.vat_rate ?? 18)

  // Номер к показу: серверный #42 или локальный K-3 (офлайн-продажа)
  const [placedNumber, setPlacedNumber] = useState<number | string | null>(null)
  const [paidOrderId, setPaidOrderId] = useState<string | null>(null)  // последний оплаченный — для чека
  // Офлайн: временный чек последней продажи (кнопка «Чек» без сети)
  const [paidLocalReceipt, setPaidLocalReceipt] = useState<Receipt | null>(null)
  const [showReceipt, setShowReceipt] = useState(false)
  // Окно «Как выдать чек?» (настройка receiptPrompt); after — отложенное продолжение потока
  const [receiptChoice, setReceiptChoice] = useState<{ orderId: string; receipt?: Receipt; after: () => void } | null>(null)
  const [clientUuid, setClientUuid] = useState(() => crypto.randomUUID())
  // Заказ, ожидающий оплаты (после place, до pay).
  // intent: 'card' — оплатить сразу картой; 'cash'/'choose' — открыть диалог
  // fromCart: свежий заказ из корзины (place_order) — при отмене оплаты его
  // нужно аннулировать и сменить clientUuid, иначе повторный place_order
  // по тому же UUID молча вернёт этот заказ со старой суммой
  const [payingOrder, setPayingOrder] = useState<PayingOrder | null>(null)
  // Шаг чаевых (настройка «Собирать чаевые»): показывается ПЕРЕД окном оплаты
  const [tipping, setTipping] = useState<PayingOrder | null>(null)
  // Чаевые, добавленные вручную кнопкой на экране продажи (до оформления).
  // Расходуются при входе в оплату — авто-шаг тогда не показывается
  const [cartTip, setCartTip] = useState(0)
  const [showTipSheet, setShowTipSheet] = useState(false)
  // Раздельная оплата по позициям: выбор позиций + остаток после оплаты части
  const [showSplit, setShowSplit] = useState(false)
  // Разделить поровну на N гостей (один чек, N платежей)
  const [showEqualSplit, setShowEqualSplit] = useState(false)
  const [splitRemainder, setSplitRemainder] = useState<{ orderId: string; total: number } | null>(null)
  // Режим столов: после финальной части цепочки сплита вернуться в зал
  const returnToHall = useRef(false)

  // Настройка кассы «PIN после каждой продажи» (Square: after each sale) —
  // по завершении продажи сбрасываем сотрудника и уводим на PIN
  function maybeLockAfterSale(): boolean {
    if (!lockAfterSale) return false
    lockStaff()
    navigate('/pin', { replace: true })
    return true
  }

  /** База процента чаевых: итог с НДС или без (настройка кассы) */
  function percentBase(total: number): number {
    return tipPercentBase(total, vatRate, tipBeforeTax)
  }

  /** Варианты чаевых для суммы (умные ₪ на мелких заказах или проценты) */
  function tipOptions(total: number): TipOption[] {
    return buildTipOptions(total, vatRate, {
      presets: tipPresets,
      beforeTax: tipBeforeTax,
      roundUp: tipRoundUp,
      smartAmounts: tipSmartAmounts,
      smartThreshold: tipSmartThreshold,
      smartFixed: tipSmartFixed,
    })
  }

  // Вход в оплату заказа. Чаевые с кнопки — сразу в оплату (не спрашиваем
  // второй раз, расходуем); иначе авто-шаг TipSheet, если включён
  function startPayment(o: PayingOrder) {
    setPayingOrder(null)
    if (collectTips && cartTip > 0) {
      const tip = cartTip
      setCartTip(0)
      proceedPayment(o, tip)
    } else if (collectTips && tipAskBeforePayment && o.total > 0) {
      setTipping(o)
    } else {
      proceedPayment(o, 0)
    }
  }

  // Чаевые выбраны (или шаг пропущен): безнал-intent (карта/кошелёк)
  // платит сразу одним тапом, остальное — окно оплаты с итогом total + tip
  function proceedPayment(o: PayingOrder, tip: number) {
    setTipping(null)
    if (o.intent !== 'cash' && o.intent !== 'choose') {
      pay.mutate({ orderId: o.orderId, dailyNumber: o.dailyNumber, payments: [{ method: o.intent, amount: o.total + tip }], tip, offline: o.offline })
    } else {
      setPayingOrder({ ...o, tip })
    }
  }

  // Отмена на шаге чаевых или в окне оплаты: свежий заказ из корзины
  // аннулировать (аудит цел, void не delete) и сменить UUID — корзина
  // осталась, следующий «Оформить» создаст новый заказ.
  // Офлайн-заказ ещё нигде не существует (enqueue происходит только при
  // подтверждении оплаты) — аннулировать нечего.
  function cancelPayFlow(o: PayingOrder) {
    setTipping(null)
    setPayingOrder(null)
    if (o.fromCart) {
      setClientUuid(crypto.randomUUID())
      if (!o.offline) voidTableOrder(o.orderId).catch(() => {})
    }
  }

  function finishPaid(num: number | string, orderId: string, localReceipt?: Receipt) {
    const wasTable = !!cart.tableCtx
    // Автопечать — ДО очистки корзины (тикету нужны заметки позиций).
    // Тикет печатается один раз на заказ: при сплите остаток его не дублирует
    // (корзина к тому моменту уже пуста).
    if (kitchenTicketOn && cart.lines.length > 0) {
      void printKitchenTicket(
        {
          dailyNumber: num,
          orderType: cart.orderType,
          customerName: cart.customerName,
          tableLabel: cart.tableCtx?.tableLabel ?? cart.tableLabel,
          staffName: staff?.name ?? '',
          deviceName,
          lines: cart.lines.map(toTicketLine),
        },
        printMode === 'rawbt'
      )
    }
    // «Как выдать чек?» заменяет автопечать: печать — только по выбору кассира.
    // Офлайн: временный чек уже собран на кассе — печатаем без fetchReceipt.
    if (!receiptPromptOn && autoPrintOn) {
      if (localReceipt) void autoPrintLocalReceipt(localReceipt, location, printMode === 'rawbt')
      else void autoPrintReceipt(orderId, location, printMode === 'rawbt')
    }
    setPayingOrder(null)
    setShowEqualSplit(false)
    cart.clear()
    setClientUuid(crypto.randomUUID())
    setPaidOrderId(orderId)  // для кнопки «Чек»
    setPaidLocalReceipt(localReceipt ?? null)
    if (paymentSound) playPaymentChime()
    qc.invalidateQueries({ queryKey: ['orders'] })
    qc.invalidateQueries({ queryKey: ['current_shift'] })
    qc.invalidateQueries({ queryKey: ['open_table_orders'] })
    qc.invalidateQueries({ queryKey: ['order_lines'] })
    qc.invalidateQueries({ queryKey: ['queue'] })
    const continueFlow = () => {
      // Цепочка сплита не закончена: показать номер/чек части,
      // по «Готово» откроется оплата остатка (не уходим в зал)
      if (splitRemainder) {
        if (wasTable) returnToHall.current = true
        setPlacedNumber(num)
        return
      }
      if (wasTable || returnToHall.current) {
        returnToHall.current = false
        if (maybeLockAfterSale()) return
        navigate('/hall')  // счёт стола закрыт — назад в зал
        return
      }
      setPlacedNumber(num)
      // Авто-скрытие убрано: закрывается по «Готово» или показу чека
    }
    // Сначала выбор чека (навигация/номер заказа ждут его), потом обычный поток
    if (receiptPromptOn) setReceiptChoice({ orderId, receipt: localReceipt, after: continueFlow })
    else continueFlow()
  }

  // «Готово» в модалке номера: если остался неоплаченный остаток сплита —
  // сразу открываем его оплату
  function dismissPlaced() {
    const num = typeof placedNumber === 'number' ? placedNumber : 0
    setPlacedNumber(null)
    if (splitRemainder) {
      startPayment({ orderId: splitRemainder.orderId, dailyNumber: num, total: splitRemainder.total, intent: 'choose' })
      setSplitRemainder(null)
      return
    }
    maybeLockAfterSale()
  }

  // Раздельная оплата: выбранные позиции → отдельный заказ со своим чеком
  const split = useMutation({
    mutationFn: (items: { item_id: string; qty: number }[]) =>
      splitOrder(payingOrder!.orderId, staff!.id, items),
    onSuccess: (res) => {
      setShowSplit(false)
      // Сначала платим за выделенную часть; остаток — следом
      setSplitRemainder({ orderId: payingOrder!.orderId, total: res.remaining_total })
      // Каждая часть — отдельный чек: чаевые спрашиваются заново на часть
      startPayment({ orderId: res.new_order_id, dailyNumber: res.daily_number, total: res.new_total, intent: 'choose' })
      qc.invalidateQueries({ queryKey: ['order_lines'] })
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
    onError: (e) => toast.error(e.message),
  })

  // Шаг 1: создать заказ. intent решает, что дальше:
  //   card   → сразу оплатить картой
  //   cash   → открыть диалог с расчётом сдачи
  //   choose → открыть диалог выбора способа
  // Сеть упала/зависла (>4с) → продажа продолжается ОФЛАЙН: заказ не
  // создаётся, итог считает касса (зеркало 034), place+pay встанут в
  // очередь при подтверждении оплаты. Лояльность офлайн недоступна
  // (баланс гостя валидирует сервер) — с гостем требуем сеть.
  const place = useMutation({
    mutationFn: async (intent: PayMethodId | 'choose') => {
      const c = useCartStore.getState()
      try {
        const r = await withOfflineFallback(() =>
          placeOrder(clientUuid, staff!.id, c.orderType, c.customerName, c.lines, c.discount, c.tableLabel, c.guest?.id ?? null, c.redeem)
        )
        return { ...r, intent, offline: false }
      } catch (e) {
        if (e instanceof OfflineError && !c.guest) {
          return {
            order_id: clientUuid,
            daily_number: 0,
            total: cartTotal(c.lines, c.discount, null),
            duplicate: false,
            intent,
            offline: true,
          }
        }
        throw e
      }
    },
    onSuccess: (res) => {
      startPayment({ orderId: res.order_id, dailyNumber: res.daily_number, total: res.total, intent: res.intent, fromCart: true, offline: res.offline })
    },
    onError: (e) => toast.error(e instanceof OfflineError ? t(lang, 'offlineBlockedHint') : e.message),
  })

  // Шаг 2: принять оплату → показать номер, очистить корзину.
  // Три пути:
  //   онлайн        → pay_order (с payment_uuid: ретрай не спишет дважды)
  //   офлайн-заказ  → place+pay в очередь одной группой, временный чек K-n
  //   таймаут pay   → заказ уже создан: в очередь только pay (с тем же
  //                   payment_uuid — если вызов долетел, replay вернёт его результат)
  const pay = useMutation({
    mutationFn: async (v: {
      orderId: string
      dailyNumber: number
      payments: PaymentInput[]
      tip?: number
      offline?: boolean
      buyer?: OrderBuyer | null
    }) => {
      const c = useCartStore.getState()
      const tip = v.tip ?? 0
      const paidAt = new Date().toISOString()

      // Оплата счёта СТОЛА офлайн: pay в очередь за append'ами того же счёта.
      // Чек собирается из серверного кэша строк + эха + не должен ждать сеть.
      const enqueueTablePay = (paymentUuid?: string) => {
        const key = v.orderId
        const st = useOutboxStore.getState()
        const echo = st.localOrders[key]
        const isLocal = !!echo && echo.serverOrderId === null
        const knownTotal = v.payments.reduce((s, p) => s + p.amount, 0) - tip
        const dailyNumber = echo?.serverDailyNumber ?? (v.dailyNumber || null)
        // Локальный номер K-n нужен, только если серверного ещё нет
        const prov = dailyNumber ? null : (echo?.provisionalNumber ?? st.nextProvisionalNumber())
        const cachedLines = (qc.getQueryData(['order_lines', key]) as BillLine[] | undefined) ?? []
        const receipt = buildLocalReceipt({
          lines: echo?.lines ?? [],
          extraLines: cachedLines.map(billLineToReceiptLine),
          orderType: 'here',
          customerName: c.customerName,
          tableLabel: c.tableCtx?.tableLabel ?? null,
          discount: null,
          redeem: null,
          payments: v.payments,
          tip,
          staffName: staff!.name,
          location,
          provisionalNumber: prov,
          dailyNumber,
          knownTotal,
          paidAt,
        })
        enqueueTablePayment({
          orderKey: key,
          orderId: isLocal ? null : key,
          tableId: c.tableCtx?.tableId ?? null,
          tableLabel: c.tableCtx?.tableLabel ?? null,
          payments: v.payments,
          tip,
          total: knownTotal,
          receipt,
          provisionalNumber: prov,
          dailyNumber,
          paymentUuid,
        })
        return { offlineNumber: (prov ?? dailyNumber) as number | string | null, orderId: key, receipt }
      }

      if (v.offline && c.tableCtx) {
        return enqueueTablePay()
      }

      if (v.offline) {
        const { provisionalNumber } = enqueueOfflineSale({
          clientUuid: v.orderId,
          staffId: staff!.id,
          orderType: c.orderType,
          customerName: c.customerName,
          tableLabel: c.tableLabel,
          lines: c.lines,
          discount: c.discount,
          payments: v.payments,
          tip,
          total: cartTotal(c.lines, c.discount, null),
          buildReceipt: (prov) =>
            buildLocalReceipt({
              lines: c.lines,
              orderType: c.orderType,
              customerName: c.customerName,
              tableLabel: c.tableLabel || null,
              discount: c.discount,
              redeem: null,
              payments: v.payments,
              tip,
              staffName: staff!.name,
              location,
              provisionalNumber: prov,
              paidAt,
            }),
        })
        const echo = useOutboxStore.getState().localOrders[v.orderId]
        return { offlineNumber: provisionalNumber as number | string, orderId: v.orderId, receipt: echo?.receipt ?? undefined }
      }

      const paymentUuid = crypto.randomUUID()
      try {
        await withOfflineFallback(() => payOrder(v.orderId, v.payments, tip, paymentUuid, null))
        // Чек на компанию (048): реквизиты — сразу после оплаты, ДО автопечати,
        // чтобы чек вышел с блоком לכבוד. Ошибка не валит оплату — реквизиты
        // можно добавить из окна чека.
        if (v.buyer) {
          try {
            await setOrderBuyer(v.orderId, v.buyer.name, v.buyer.taxId)
          } catch {
            toast.error(t(lang, 'bizPayFailed'))
          }
        }
        return null
      } catch (e) {
        if (e instanceof OfflineError) {
          if (v.buyer) toast.error(t(lang, 'bizPayFailed'))
          // Стол: таймаут оплаты серверного счёта → в очередь с тем же uuid
          if (c.tableCtx) return enqueueTablePay(paymentUuid)
          // Итог заказа известен серверу (place прошёл): сумма платежей − tip
          const knownTotal = v.payments.reduce((s, p) => s + p.amount, 0) - tip
          const receipt = buildLocalReceipt({
            lines: c.lines,
            orderType: c.orderType,
            customerName: c.customerName,
            tableLabel: c.tableLabel || null,
            discount: c.discount,
            redeem: c.redeem,
            payments: v.payments,
            tip,
            staffName: staff!.name,
            location,
            provisionalNumber: null,
            dailyNumber: v.dailyNumber || null,
            knownTotal,
            paidAt,
          })
          enqueueOfflinePayment({
            orderId: v.orderId,
            dailyNumber: v.dailyNumber || null,
            orderType: c.orderType,
            customerName: c.customerName,
            tableLabel: c.tableLabel || null,
            lines: c.lines,
            payments: v.payments,
            tip,
            total: receipt.total,
            receipt,
            paymentUuid,
          })
          return { offlineNumber: (v.dailyNumber || null) as number | string | null, orderId: v.orderId, receipt }
        }
        throw e
      }
    },
    onSuccess: (res, v) => {
      if (res) finishPaid(res.offlineNumber ?? v.dailyNumber, res.orderId, res.receipt)
      else finishPaid(v.dailyNumber, v.orderId)
    },
    onError: (e) => toast.error(e.message),
  })

  return {
    // шаги потока
    payingOrder, tipping, splitRemainder, placedNumber,
    showSplit, setShowSplit, showEqualSplit, setShowEqualSplit,
    // чаевые
    cartTip, setCartTip, showTipSheet, setShowTipSheet, percentBase, tipOptions,
    // чек последней продажи
    paidOrderId, paidLocalReceipt, showReceipt, setShowReceipt, receiptChoice, setReceiptChoice,
    // мутации
    place, pay, split,
    // действия
    startPayment, proceedPayment, cancelPayFlow, dismissPlaced,
  }
}
