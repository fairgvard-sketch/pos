import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCategories, fetchItems, fetchModifierGroups } from '../menu/api'
import { placeOrder, payOrder, splitOrder, type PaymentInput } from './api'
import { fetchCurrentShift } from '../shift/api'
import { fetchCurrentLocation } from '../auth/api'
import { appendToOrder, voidTableOrder, fetchOrderLines, voidOrderItem, setOrderDiscount, type BillLine } from '../tables/api'
import { useCartStore, cartSubtotal, cartTotal, discountAmount, loyaltyAmount, lineUnitPrice, type CartLine, type CartMod, type CartDiscount } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { playPaymentChime } from '../../lib/sound'
import { autoPrintReceipt, printKitchenTicket } from '../receipt/printService'
import type { KitchenTicketLine } from '../receipt/printCanvas'
import { t } from '../../lib/i18n'
import { formatMoney, formatMoneyList } from '../../lib/money'
import type { MenuItem, ModifierGroup } from '../../types'
import ItemPicker from './ItemPicker'
import PaymentSheet from './PaymentSheet'
import DiscountSheet from './DiscountSheet'
import PriceSheet from './PriceSheet'
import TableSheet from './TableSheet'
import ShiftGate from '../shift/ShiftGate'
import ReceiptSheet from '../receipt/ReceiptSheet'
import ReceiptChoiceSheet from '../receipt/ReceiptChoiceSheet'
import SplitItemsSheet from './SplitItemsSheet'
import GuestSheet from '../loyalty/GuestSheet'
import { formatPhone } from '../loyalty/api'
import AppSidebar from '../../components/AppSidebar'
import ItemImage from '../../components/ItemImage'
import Icon from '../../components/Icon'

/** Дефолтная конфигурация товара — для добавления в 1 тап */
function defaultConfig(item: MenuItem, groups: ModifierGroup[]) {
  const variants = (item.item_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
  const variant = variants.find((v) => v.is_default) ?? variants[0] ?? null
  const mods: CartMod[] = groups.flatMap((g) =>
    (g.modifiers ?? [])
      .filter((m) => m.is_default && m.is_available)
      .map((m) => ({ id: m.id, name: m.name, priceDelta: m.price_delta }))
  )
  return {
    itemId: item.id,
    name: item.name,
    variantId: variant?.id ?? null,
    variantName: variant?.name ?? null,
    basePrice: variant?.price ?? item.price,
    mods,
    notes: '',
    priceOverride: null,
  }
}

/** Строка корзины → строка кухонного тикета (с заметками) */
function toTicketLine(l: CartLine): KitchenTicketLine {
  return {
    qty: l.qty,
    name: l.name,
    variantName: l.variantName,
    modifiers: l.mods.map((m) => m.name),
    notes: l.notes,
  }
}

/** Подписи тикета на языке интерфейса кассы */
function ticketLabels(lang: 'ru' | 'he') {
  return {
    takeaway: t(lang, 'takeaway'),
    here: t(lang, 'here'),
    table: t(lang, 'tableLabel'),
    addon: t(lang, 'kitchenAddon'),
  }
}

export default function SellPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const lockStaff = useAuthStore((s) => s.lock)
  const lockAfterSale = useDeviceStore((s) => s.lockAfterSale)
  const paymentSound = useDeviceStore((s) => s.paymentSound)
  const printMode = useDeviceStore((s) => s.printMode)
  const autoPrintOn = useDeviceStore((s) => s.autoPrintReceipt)
  const receiptPromptOn = useDeviceStore((s) => s.receiptPrompt)
  const kitchenTicketOn = useDeviceStore((s) => s.printKitchenTicket)
  const qc = useQueryClient()
  const navigate = useNavigate()

  const { data: shift, isLoading: shiftLoading } = useQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  // Столы показываем, если точка не в режиме чистой стойки
  const showTable = location?.service_mode === 'counter_tables' || location?.service_mode === 'tables'
  const { data: categories = [] } = useQuery({ queryKey: ['menu_categories'], queryFn: fetchCategories })
  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
  const { data: allGroups = [] } = useQuery({ queryKey: ['modifier_groups'], queryFn: fetchModifierGroups })

  const cart = useCartStore()

  const hasFavorites = useMemo(() => items.some((i) => i.is_favorite && i.is_available), [items])
  const [activeCat, setActiveCat] = useState<string | 'all' | 'fav' | null>(null)
  const [search, setSearch] = useState('')
  const [picker, setPicker] = useState<{ item: MenuItem; line: CartLine | null } | null>(null)
  const [showDiscount, setShowDiscount] = useState(false)
  const [showGuest, setShowGuest] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [showTableSheet, setShowTableSheet] = useState(false)
  // Строка, у которой правим цену вручную (edit-режим PriceSheet)
  const [editingPrice, setEditingPrice] = useState<CartLine | null>(null)
  const [placedNumber, setPlacedNumber] = useState<number | null>(null)
  const [paidOrderId, setPaidOrderId] = useState<string | null>(null)  // последний оплаченный — для чека
  const [showReceipt, setShowReceipt] = useState(false)
  // Окно «Как выдать чек?» (настройка receiptPrompt); after — отложенное продолжение потока
  const [receiptChoice, setReceiptChoice] = useState<{ orderId: string; after: () => void } | null>(null)
  const [clientUuid, setClientUuid] = useState(() => crypto.randomUUID())
  // Заказ, ожидающий оплаты (после place, до pay).
  // intent: 'card' — оплатить сразу картой; 'cash'/'choose' — открыть диалог
  // fromCart: свежий заказ из корзины (place_order) — при отмене оплаты его
  // нужно аннулировать и сменить clientUuid, иначе повторный place_order
  // по тому же UUID молча вернёт этот заказ со старой суммой
  const [payingOrder, setPayingOrder] = useState<
    { orderId: string; dailyNumber: number; total: number; intent: 'cash' | 'card' | 'choose'; fromCart?: boolean } | null
  >(null)
  // Раздельная оплата по позициям: выбор позиций + остаток после оплаты части
  const [showSplit, setShowSplit] = useState(false)
  const [splitRemainder, setSplitRemainder] = useState<{ orderId: string; total: number } | null>(null)
  // Режим столов: после финальной части цепочки сплита вернуться в зал
  const returnToHall = useRef(false)

  // Стартовая вкладка — первая категория по списку (иначе всё)
  const firstCat = categories.find((c) => c.is_active)?.id
  const currentCat = activeCat ?? firstCat ?? 'all'

  const visibleItems = useMemo(() => {
    let list = items.filter((i) => i.is_available)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      return list.filter((i) => i.name.toLowerCase().includes(q))
    }
    if (currentCat === 'fav') list = list.filter((i) => i.is_favorite)
    else if (currentCat !== 'all') list = list.filter((i) => i.category_id === currentCat)
    return list
  }, [items, currentCat, search])

  function itemGroups(item: MenuItem): ModifierGroup[] {
    const links = (item.menu_item_modifier_groups ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
    return links
      .map((l) => allGroups.find((g) => g.id === l.group_id))
      .filter((g): g is ModifierGroup => !!g)
  }

  function handleItemTap(item: MenuItem) {
    const groups = itemGroups(item)
    if (item.ask_modifiers && (groups.length > 0 || (item.item_variants?.length ?? 0) > 0)) {
      setPicker({ item, line: null })
      return
    }
    cart.addLine(defaultConfig(item, groups))
  }

  // Настройка кассы «PIN после каждой продажи» (Square: after each sale) —
  // по завершении продажи сбрасываем сотрудника и уводим на PIN
  function maybeLockAfterSale(): boolean {
    if (!lockAfterSale) return false
    lockStaff()
    navigate('/pin', { replace: true })
    return true
  }

  function finishPaid(num: number, orderId: string) {
    const wasTable = !!cart.tableCtx
    // Автопечать — ДО очистки корзины (тикету нужны заметки позиций).
    // Тикет печатается один раз на заказ: при сплите остаток его не дублирует
    // (корзина к тому моменту уже пуста).
    if (kitchenTicketOn && cart.lines.length > 0) {
      printKitchenTicket(
        {
          dailyNumber: num,
          orderType: cart.orderType,
          customerName: cart.customerName,
          tableLabel: cart.tableCtx?.tableLabel ?? cart.tableLabel,
          lines: cart.lines.map(toTicketLine),
          labels: ticketLabels(lang),
        },
        printMode === 'rawbt'
      )
    }
    // «Как выдать чек?» заменяет автопечать: печать — только по выбору кассира
    if (!receiptPromptOn && autoPrintOn) void autoPrintReceipt(orderId, location, printMode === 'rawbt')
    setPayingOrder(null)
    cart.clear()
    setClientUuid(crypto.randomUUID())
    setPaidOrderId(orderId)  // для кнопки «Чек»
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
    if (receiptPromptOn) setReceiptChoice({ orderId, after: continueFlow })
    else continueFlow()
  }

  // «Готово» в модалке номера: если остался неоплаченный остаток сплита —
  // сразу открываем его оплату
  function dismissPlaced() {
    const num = placedNumber ?? 0
    setPlacedNumber(null)
    if (splitRemainder) {
      setPayingOrder({ orderId: splitRemainder.orderId, dailyNumber: num, total: splitRemainder.total, intent: 'choose' })
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
      setPayingOrder({ orderId: res.new_order_id, dailyNumber: res.daily_number, total: res.new_total, intent: 'choose' })
      qc.invalidateQueries({ queryKey: ['order_lines'] })
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
    onError: (e) => toast.error(e.message),
  })

  // Шаг 1: создать заказ. intent решает, что дальше:
  //   card   → сразу оплатить картой
  //   cash   → открыть диалог с расчётом сдачи
  //   choose → открыть диалог выбора способа
  const place = useMutation({
    mutationFn: (intent: 'cash' | 'card' | 'choose') =>
      placeOrder(clientUuid, staff!.id, cart.orderType, cart.customerName, cart.lines, cart.discount, cart.tableLabel, cart.guest?.id ?? null, cart.redeem).then((r) => ({ ...r, intent })),
    onSuccess: (res) => {
      if (res.intent === 'card') {
        payWithClose({ orderId: res.order_id, dailyNumber: res.daily_number, payments: [{ method: 'card', amount: res.total }] })
      } else {
        setPayingOrder({ orderId: res.order_id, dailyNumber: res.daily_number, total: res.total, intent: res.intent, fromCart: true })
      }
    },
    onError: (e) => toast.error(e.message),
  })

  // Шаг 2: принять оплату → показать номер, очистить корзину
  const pay = useMutation({
    mutationFn: (v: { orderId: string; dailyNumber: number; payments: PaymentInput[] }) =>
      payOrder(v.orderId, v.payments),
    onSuccess: (_r, v) => finishPaid(v.dailyNumber, v.orderId),
    onError: (e) => toast.error(e.message),
  })
  const payWithClose = (v: { orderId: string; dailyNumber: number; payments: PaymentInput[] }) => pay.mutate(v)

  const tableCtx = cart.tableCtx

  // Уже заказанные позиции открытого счёта стола (read-only, до дозаказа).
  // cart.lines в режиме стола = только НОВЫЕ позиции, поэтому существующие
  // тянем отдельно, чтобы бариста/кассир видел, что уже на столе.
  const { data: existingLines = [] } = useQuery({
    queryKey: ['order_lines', tableCtx?.orderId],
    queryFn: () => fetchOrderLines(tableCtx!.orderId),
    enabled: !!tableCtx,
  })
  const existingSubtotal = existingLines.reduce((s, l) => s + l.line_total, 0)

  // Скидка на счёт стола живёт на ЗАКАЗЕ (не в корзине): ставится RPC
  // set_order_discount. Локально помним последнюю применённую — для бейджа
  // и предзаполнения диалога в рамках текущего захода на стол.
  const [tableDiscount, setTableDiscount] = useState<(CartDiscount & { amount: number }) | null>(null)
  useEffect(() => setTableDiscount(null), [tableCtx?.orderId])

  const orderDiscount = useMutation({
    mutationFn: (d: CartDiscount | null) =>
      setOrderDiscount(tableCtx!.orderId, d?.type ?? null, d?.value, d?.reason),
    onSuccess: (res, d) => {
      cart.setTableCtx({ ...tableCtx!, existingTotal: res.total })
      setTableDiscount(d ? { ...d, amount: res.discount_amount } : null)
      qc.invalidateQueries({ queryKey: ['open_table_orders'] })
      setShowDiscount(false)
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

  // Режим столов: сохранить дозаказ в открытый счёт (остаётся open) → назад в зал
  const saveBill = useMutation({
    mutationFn: () => appendToOrder(tableCtx!.orderId, staff!.id, cart.lines),
    onSuccess: () => {
      toast.success(t(lang, 'billSaved'))
      // Тикет на кухню для дозаказа: только новые позиции, без номера
      if (kitchenTicketOn && cart.lines.length > 0) {
        printKitchenTicket(
          {
            dailyNumber: null,
            orderType: 'here',
            customerName: cart.customerName,
            tableLabel: tableCtx!.tableLabel,
            lines: cart.lines.map(toTicketLine),
            labels: ticketLabels(lang),
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

  // Режим столов: добавить новые позиции (если есть) и открыть оплату всего счёта
  const billToPay = useMutation({
    mutationFn: async () => {
      if (cart.lines.length > 0) {
        const r = await appendToOrder(tableCtx!.orderId, staff!.id, cart.lines)
        return r.total
      }
      return tableCtx!.existingTotal
    },
    onSuccess: (billTotal) => {
      setPayingOrder({ orderId: tableCtx!.orderId, dailyNumber: 0, total: billTotal, intent: 'choose' })
    },
    onError: (e) => toast.error(e.message),
  })

  // Режим столов: отменить пустой/ошибочный счёт
  const voidBill = useMutation({
    mutationFn: () => voidTableOrder(tableCtx!.orderId),
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

  const subtotal = cartSubtotal(cart.lines)
  const discAmount = discountAmount(subtotal, cart.discount)

  // ── Лояльность: доступна в counter-потоке, если включена на точке ──
  const loyaltyMode = location?.loyalty_mode ?? 'off'
  const loyaltyOn = loyaltyMode !== 'off' && !tableCtx
  const stampCatIds = useMemo(
    () => new Set(categories.filter((c) => c.loyalty_stamps).map((c) => c.id)),
    [categories]
  )
  // Самая дешёвая штампуемая позиция корзины — кандидат «бесплатного напитка»
  const freeItemPrice = useMemo(() => {
    let min: number | null = null
    for (const l of cart.lines) {
      if (!l.itemId) continue
      const item = items.find((i) => i.id === l.itemId)
      if (!item || !stampCatIds.has(item.category_id)) continue
      const p = lineUnitPrice(l)
      if (min === null || p < min) min = p
    }
    return min
  }, [cart.lines, items, stampCatIds])

  // Корзина изменилась → «бесплатный напиток» следует за ней (или отменяется)
  const setRedeem = cart.setRedeem
  const stampRedeemAmount = cart.redeem?.type === 'stamps' ? cart.redeem.amount : null
  useEffect(() => {
    if (stampRedeemAmount === null) return
    if (freeItemPrice === null) setRedeem(null)
    else if (stampRedeemAmount !== freeItemPrice) setRedeem({ type: 'stamps', amount: freeItemPrice })
  }, [stampRedeemAmount, freeItemPrice, setRedeem])

  const loyAmount = loyaltyAmount(subtotal, cart.discount, cart.redeem)
  const total = cartTotal(cart.lines, cart.discount, cart.redeem)
  // НДС включён в цену — показываем справочно по ставке точки (снапшот считает сервер)
  const vatRate = Number(location?.vat_rate ?? 18)
  const vatIncluded = Math.round((total * vatRate) / (100 + vatRate))

  if (!staff) return null

  // Режим столов: продажа — не самостоятельный экран, вход через зал.
  // Открыли /sell без выбранного стола → возвращаем в зал.
  if (location?.service_mode === 'tables' && !cart.tableCtx) {
    return <Navigate to="/hall" replace />
  }

  // Нет открытой смены — не пускаем к продажам
  if (!shiftLoading && !shift) {
    return <ShiftGate />
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="sell" />

      {/* ── Каталог ─────────────────────────────────── */}
      <main className="flex-1 min-w-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-5 pb-0 shrink-0">
          <input
            className="w-full rounded-2xl border border-gray-100 bg-gray-50 px-5 py-3 text-sm
                       placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900/10
                       focus:bg-white transition-all"
            placeholder={t(lang, 'searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="flex gap-2 overflow-x-auto py-4 short:py-2">
            {hasFavorites && (
              <Chip active={!search && currentCat === 'fav'} onClick={() => { setSearch(''); setActiveCat('fav') }}>
                ★ {t(lang, 'favorites')}
              </Chip>
            )}
            {categories.filter((c) => c.is_active).map((c) => (
              <Chip key={c.id} active={!search && currentCat === c.id} onClick={() => { setSearch(''); setActiveCat(c.id) }}>
                {c.name}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {visibleItems.length === 0 ? (
            <p className="text-gray-300 text-sm text-center pt-20">{t(lang, 'nothingFound')}</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleItemTap(item)}
                  className="relative rounded-2xl border border-gray-200 p-3 text-start bg-white
                             hover:border-gray-300 hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)]
                             transition-all duration-150 active:scale-[0.97]"
                >
                  {item.is_favorite && (
                    <span className="absolute top-2.5 end-2.5 text-amber-400 text-sm drop-shadow-sm">★</span>
                  )}
                  <ItemImage item={item} size="card" />
                  <div className="mt-2.5 font-semibold text-gray-900 text-sm leading-tight">{item.name}</div>
                  {(() => {
                    const priceLabel =
                      item.item_variants && item.item_variants.length > 0
                        ? formatMoneyList(
                            item.item_variants
                              .slice()
                              .sort((a, b) => a.sort_order - b.sort_order)
                              .map((v) => v.price),
                            lang
                          )
                        : formatMoney(item.price, lang)
                    return (
                      <div
                        className="mt-1 text-sm font-bold text-gray-500 tabular-nums truncate"
                        title={priceLabel}
                      >
                        {priceLabel}
                      </div>
                    )
                  })()}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Ряд действий */}
        <div className="shrink-0 border-t border-gray-100 px-5 pt-3 pb-5 short:pb-3 flex gap-2 overflow-x-auto">
          <ActionButton icon="customItem" label={t(lang, 'customItem')} onClick={() => setShowCustom(true)} />
          <ActionButton
            icon="discount"
            label={t(lang, 'discount')}
            active={tableCtx ? !!tableDiscount : !!cart.discount}
            onClick={() => setShowDiscount(true)}
          />
          <ActionButton icon="note" label={t(lang, 'note')} onClick={() => toast(`${t(lang, 'note')} — ${t(lang, 'comingSoon')}`)} />
          <ActionButton icon="refund" label={t(lang, 'refund')} onClick={() => navigate('/transactions')} />
        </div>
      </main>

      {/* ── Заказ ───────────────────────────────────── */}
      <aside className="w-[clamp(320px,28vw,400px)] shrink-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-4 pb-3 shrink-0">
          {tableCtx ? (
            /* Режим столов: работаем со счётом конкретного стола */
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-lg font-black text-gray-900">
                {t(lang, 'tableLabel')} {tableCtx.tableLabel}
                <span className="text-gray-400 font-semibold"> · {t(lang, 'openBill')}</span>
              </h2>
              {tableCtx.existingTotal > 0 && (
                <span className="text-sm font-bold text-gray-500 tabular-nums">
                  {formatMoney(tableCtx.existingTotal, lang)}
                </span>
              )}
            </div>
          ) : (
            <>
              <h2 className="text-lg font-black text-gray-900 mb-3">{t(lang, 'newOrderTitle')}</h2>
              <div className="grid grid-cols-2 gap-1 bg-gray-50 border border-gray-100 rounded-xl p-0.5 mb-2.5">
                {(['here', 'takeaway'] as const).map((tp) => (
                  <button
                    key={tp}
                    onClick={() => cart.setOrderType(tp)}
                    className={`py-2 rounded-lg text-sm font-semibold transition-all ${
                      cart.orderType === tp
                        ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                        : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    {t(lang, tp)}
                  </button>
                ))}
              </div>
              <div className={showTable ? 'grid grid-cols-2 gap-2' : ''}>
                <input
                  className="input !py-2"
                  placeholder={t(lang, 'customerNameOpt')}
                  value={cart.customerName}
                  onChange={(e) => cart.setCustomerName(e.target.value)}
                />
                {showTable && (
                  <button
                    onClick={() => setShowTableSheet(true)}
                    className={`input !py-2 text-start ${cart.tableLabel ? 'text-gray-900 font-semibold' : 'text-gray-400'}`}
                  >
                    {cart.tableLabel ? `${t(lang, 'tableLabel')} ${cart.tableLabel}` : t(lang, 'tablePlaceholder')}
                  </button>
                )}
              </div>
              {loyaltyOn && (
                <button
                  onClick={() => setShowGuest(true)}
                  className="input !py-2 mt-2.5 w-full text-start flex items-center gap-2"
                >
                  <Icon name="customers" size={16} />
                  {cart.guest ? (
                    <>
                      <span className="font-semibold text-gray-900 truncate">
                        {cart.guest.name || formatPhone(cart.guest.phone)}
                      </span>
                      <span className="ms-auto text-sm font-bold text-gray-500 tabular-nums shrink-0">
                        {loyaltyMode === 'stamps'
                          ? `${cart.guest.stamps}/${location?.loyalty_stamps_goal ?? 10}`
                          : formatMoney(cart.guest.points, lang)}
                      </span>
                    </>
                  ) : (
                    <span className="text-gray-400">{t(lang, 'guestAdd')}</span>
                  )}
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 space-y-2">
          {/* Режим стола: уже заказанные позиции. Свайп влево → снять с счёта (void). */}
          {tableCtx && existingLines.length > 0 && (
            <div className="rounded-2xl bg-gray-50 border border-gray-100 p-3 space-y-1.5">
              <div className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">{t(lang, 'alreadyInBill')}</div>
              {existingLines.map((l) => (
                <ExistingBillRow
                  key={l.id}
                  line={l}
                  lang={lang}
                  isRtl={isRtl}
                  busy={voidItem.isPending}
                  onVoid={() => {
                    if (confirm(t(lang, 'confirmVoidItem'))) voidItem.mutate(l.id)
                  }}
                />
              ))}
            </div>
          )}

          {cart.lines.length === 0 && (!tableCtx || existingLines.length === 0) && (
            <p className="text-gray-300 text-sm text-center pt-16">
              {t(lang, tableCtx ? 'addToBill' : 'cartEmptyHint')}
            </p>
          )}
          {cart.lines.map((l) => {
            const item = items.find((i) => i.id === l.itemId)
            return (
              <CartLineRow
                key={l.key}
                line={l}
                item={item}
                lang={lang}
                isRtl={isRtl}
                onOpen={() => (item ? setPicker({ item, line: l }) : setEditingPrice(l))}
                onEditPrice={() => setEditingPrice(l)}
                onRemove={() => cart.removeLine(l.key)}
                onDec={() => cart.updateQty(l.key, l.qty - 1)}
                onInc={() => cart.updateQty(l.key, l.qty + 1)}
              />
            )
          })}
        </div>

        <div className="p-4 pt-3 short:pt-2 shrink-0 border-t border-gray-100 space-y-1.5 short:space-y-1">
          {((cart.discount && discAmount > 0) || loyAmount > 0) && (
            <div className="flex justify-between text-sm text-gray-500">
              <span>{t(lang, 'subtotal')}</span>
              <span className="tabular-nums">{formatMoney(subtotal, lang)}</span>
            </div>
          )}
          {cart.discount && discAmount > 0 && (
            <button
              onClick={() => setShowDiscount(true)}
              className="flex justify-between w-full text-sm text-emerald-600 font-medium"
            >
              <span>
                {t(lang, 'discountLabel')}
                {cart.discount.type === 'percent' && ` ${cart.discount.value}%`}
                {cart.discount.reason && ` · ${cart.discount.reason}`}
              </span>
              <span className="tabular-nums">−{formatMoney(discAmount, lang)}</span>
            </button>
          )}
          {loyAmount > 0 && cart.redeem && (
            <button
              onClick={() => setShowGuest(true)}
              className="flex justify-between w-full text-sm text-emerald-600 font-medium"
            >
              <span>
                {t(lang, 'loyaltyLabel')}
                {cart.redeem.type === 'stamps' && ` · ${t(lang, 'freeDrink')}`}
              </span>
              <span className="tabular-nums">−{formatMoney(loyAmount, lang)}</span>
            </button>
          )}
          {/* Скидка на счёт стола (хранится на заказе) */}
          {tableCtx && tableDiscount && (
            <button
              onClick={() => setShowDiscount(true)}
              className="flex justify-between w-full text-sm text-emerald-600 font-medium"
            >
              <span>
                {t(lang, 'discountLabel')}
                {tableDiscount.type === 'percent' && ` ${tableDiscount.value}%`}
                {tableDiscount.reason && ` · ${tableDiscount.reason}`}
              </span>
              <span className="tabular-nums">−{formatMoney(tableDiscount.amount, lang)}</span>
            </button>
          )}
          {/* В режиме стола итог = уже в счёте + добавленное */}
          {tableCtx && cart.lines.length > 0 && (
            <div className="flex justify-between text-sm text-gray-500">
              <span>{t(lang, 'alreadyInBill')}</span>
              <span className="tabular-nums">{formatMoney(tableCtx.existingTotal, lang)}</span>
            </div>
          )}
          <div className="flex justify-between text-sm text-gray-500">
            <span>{t(lang, 'vatIncl')} {vatRate}%</span>
            <span className="tabular-nums">{formatMoney(vatIncluded, lang)}</span>
          </div>
          <div className="flex justify-between items-baseline pt-1">
            <span className="font-bold text-gray-900">{t(lang, 'total')}</span>
            {(() => {
              const shown = tableCtx ? tableCtx.existingTotal + total : total
              return (
                <span key={shown} className="text-2xl short:text-xl font-black text-gray-900 tabular-nums inline-block cart-bump">
                  {formatMoney(shown, lang)}
                </span>
              )
            })()}
          </div>
          {tableCtx ? (
            /* Столы: сохранить дозаказ ИЛИ оплатить весь счёт */
            (() => {
              const busy = saveBill.isPending || billToPay.isPending || pay.isPending
              const hasNew = cart.lines.length > 0
              const emptyBill = tableCtx.existingTotal === 0 && !hasNew
              return (
                <>
                  <button
                    onClick={() => saveBill.mutate()}
                    disabled={busy || !hasNew}
                    className="btn-primary w-full !py-4 short:!py-3 !text-base !rounded-2xl mt-2 flex items-center justify-between !px-5"
                  >
                    <span>{t(lang, 'saveBill')}</span>
                    {hasNew && <span className="tabular-nums">{formatMoney(total, lang)}</span>}
                  </button>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <button
                      onClick={() => (emptyBill ? voidBill.mutate() : billToPay.mutate())}
                      disabled={busy}
                      className="btn-secondary min-h-[52px] !rounded-2xl flex items-center justify-center gap-2"
                    >
                      {emptyBill ? t(lang, 'voidBill') : t(lang, 'payBill')}
                    </button>
                    <button
                      onClick={exitTable}
                      disabled={busy}
                      className="btn-ghost min-h-[52px] !rounded-2xl"
                    >
                      {t(lang, 'back')}
                    </button>
                  </div>
                </>
              )
            })()
          ) : (
            (() => {
              const disabled = cart.lines.length === 0 || place.isPending || pay.isPending
              return (
                <>
                  <button
                    onClick={() => place.mutate('choose')}
                    disabled={disabled}
                    className="btn-primary w-full !py-4 short:!py-3 !text-base !rounded-2xl mt-2 flex items-center justify-between !px-5"
                  >
                    <span>{place.isPending ? t(lang, 'charging') : t(lang, 'charge')}</span>
                    {cart.lines.length > 0 && <span className="tabular-nums">{formatMoney(total, lang)}</span>}
                  </button>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <button
                      onClick={() => place.mutate('cash')}
                      disabled={disabled}
                      className="btn-secondary min-h-[52px] !rounded-2xl flex items-center justify-center gap-2"
                    >
                      <Icon name="cash" size={18} /> {t(lang, 'payCash')}
                    </button>
                    <button
                      onClick={() => place.mutate('card')}
                      disabled={disabled}
                      className="btn-secondary min-h-[52px] !rounded-2xl flex items-center justify-center gap-2"
                    >
                      <Icon name="card" size={18} /> {t(lang, 'payCard')}
                    </button>
                  </div>
                </>
              )
            })()
          )}
        </div>
      </aside>

      {/* Оплата созданного заказа (наличные с расчётом сдачи или выбор способа) */}
      {payingOrder && !showSplit && (
        <PaymentSheet
          total={payingOrder.total}
          startMode={payingOrder.intent === 'cash' ? 'cash' : 'choose'}
          busy={pay.isPending}
          onCancel={() => {
            const o = payingOrder
            setPayingOrder(null)
            // Свежий заказ из корзины брошен: аннулировать (аудит цел, void не delete)
            // и сменить UUID — корзина осталась, следующий «Оформить» создаст новый заказ
            if (o.fromCart) {
              setClientUuid(crypto.randomUUID())
              voidTableOrder(o.orderId).catch(() => {})
            }
          }}
          onPay={(payments) => pay.mutate({ orderId: payingOrder.orderId, dailyNumber: payingOrder.dailyNumber, payments })}
          // split_order пересчитывает итоги без loyalty_discount — при выбранной награде сплит недоступен
          onSplitItems={cart.redeem ? undefined : () => setShowSplit(true)}
        />
      )}

      {payingOrder && showSplit && (
        <SplitItemsSheet
          orderId={payingOrder.orderId}
          hasDiscount={!!cart.discount}
          busy={split.isPending}
          onConfirm={(items) => split.mutate(items)}
          onCancel={() => setShowSplit(false)}
        />
      )}

      {picker && (
        <ItemPicker
          item={picker.item}
          groups={itemGroups(picker.item)}
          line={picker.line}
          onClose={() => setPicker(null)}
          onConfirm={(cfg) => {
            // Переконфигурация в пикере сбрасывает ручную цену — она относилась к старой сборке
            if (picker.line) {
              cart.updateLine(picker.line.key, { ...cfg, priceOverride: null })
            } else {
              cart.addLine({ itemId: picker.item.id, name: picker.item.name, ...cfg, priceOverride: null })
            }
            setPicker(null)
          }}
        />
      )}

      {showDiscount && (
        <DiscountSheet
          // Стол: скидка на ВЕСЬ счёт (уже заказанное + добавляемое)
          subtotal={tableCtx ? existingSubtotal + subtotal : subtotal}
          current={tableCtx ? tableDiscount : cart.discount}
          onApply={(d) => {
            if (tableCtx) {
              orderDiscount.mutate(d)  // диалог закроется по успеху RPC
            } else {
              cart.setDiscount(d)
              setShowDiscount(false)
            }
          }}
          onCancel={() => setShowDiscount(false)}
        />
      )}

      {showGuest && location && loyaltyMode !== 'off' && (
        <GuestSheet
          mode={loyaltyMode}
          stampsGoal={location.loyalty_stamps_goal}
          minRedeem={location.loyalty_points_min_redeem}
          freeItemPrice={freeItemPrice}
          maxRedeem={subtotal - discAmount}
          current={cart.guest}
          currentRedeem={cart.redeem}
          onApply={(g, r) => {
            cart.setGuest(g)
            cart.setRedeem(r)
            setShowGuest(false)
          }}
          onCancel={() => setShowGuest(false)}
        />
      )}

      {showTableSheet && (
        <TableSheet
          current={cart.tableLabel}
          onApply={(label) => { cart.setTableLabel(label); setShowTableSheet(false) }}
          onCancel={() => setShowTableSheet(false)}
        />
      )}

      {showCustom && (
        <PriceSheet
          mode="custom"
          onSubmit={({ name, priceOverride }) => {
            cart.addLine({
              itemId: null,
              name,
              variantId: null,
              variantName: null,
              basePrice: priceOverride,
              mods: [],
              notes: '',
              priceOverride,
            })
            setShowCustom(false)
          }}
          onCancel={() => setShowCustom(false)}
        />
      )}

      {editingPrice && (
        <PriceSheet
          mode="edit"
          line={editingPrice}
          autoPrice={editingPrice.basePrice + editingPrice.mods.reduce((s, m) => s + m.priceDelta, 0)}
          onSubmit={({ priceOverride }) => {
            cart.updateLine(editingPrice.key, { priceOverride })
            setEditingPrice(null)
          }}
          onReset={() => {
            cart.updateLine(editingPrice.key, { priceOverride: null })
            setEditingPrice(null)
          }}
          onCancel={() => setEditingPrice(null)}
        />
      )}

      {placedNumber !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
          <div className="card px-12 py-10 text-center animate-[pop-in_0.35s_cubic-bezier(0.34,1.56,0.64,1)]">
            <div className="text-sm text-gray-500 mb-2">{t(lang, 'orderPlaced')}</div>
            <div className="text-7xl font-black text-gray-900 tabular-nums mb-8">#{placedNumber}</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setShowReceipt(true)}
                disabled={!paidOrderId}
                className="btn-secondary !py-3.5 !rounded-2xl"
              >
                {t(lang, 'receipt')}
              </button>
              <button onClick={dismissPlaced} className="btn-primary !py-3.5 !rounded-2xl">
                {splitRemainder ? t(lang, 'payRemainder') : t(lang, 'done')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReceipt && paidOrderId && (
        <ReceiptSheet orderId={paidOrderId} onClose={() => setShowReceipt(false)} />
      )}

      {/* «Как выдать чек?» — после оплаты, до номера заказа/возврата в зал */}
      {receiptChoice && (
        <ReceiptChoiceSheet
          orderId={receiptChoice.orderId}
          location={location}
          onDone={() => {
            const after = receiptChoice.after
            setReceiptChoice(null)
            after()
          }}
        />
      )}
    </div>
  )
}

/** Порог свайпа (px), после которого позиция удаляется на отпускании */
const SWIPE_DELETE_THRESHOLD = 96
/** Ширина зоны удаления, до которой строка «прилипает» */
const SWIPE_REVEAL_WIDTH = 80

/** Строка счёта со свайпом на удаление (влево в LTR, вправо в RTL) */
function CartLineRow({
  line: l,
  item,
  lang,
  isRtl,
  onOpen,
  onEditPrice,
  onRemove,
  onDec,
  onInc,
}: {
  line: CartLine
  item: MenuItem | undefined
  lang: 'ru' | 'he'
  isRtl: boolean
  onOpen: () => void
  onEditPrice: () => void
  onRemove: () => void
  onDec: () => void
  onInc: () => void
}) {
  // dx < 0 — строка уехала «в сторону удаления» (нормализовано под RTL)
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [removing, setRemoving] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  // Пока не решили, что это горизонтальный свайп — не перехватываем тап
  const locked = useRef(false)

  // В RTL логическое «влево» — это движение вправо по экрану
  const sign = isRtl ? -1 : 1

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY }
    locked.current = false
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return
    const rawX = (e.clientX - start.current.x) * sign
    const rawY = e.clientY - start.current.y
    if (!locked.current) {
      // Определяем ось: горизонталь с явным преобладанием — это свайп
      if (Math.abs(rawX) > 8 && Math.abs(rawX) > Math.abs(rawY)) {
        locked.current = true
        setDragging(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      } else if (Math.abs(rawY) > 10) {
        // Вертикальный скролл — отпускаем строку
        start.current = null
        return
      }
    }
    if (locked.current) {
      e.preventDefault()
      // Только влево; вправо — резинка с затуханием
      const next = rawX < 0 ? rawX : rawX * 0.25
      setDx(Math.max(next, -160))
    }
  }

  function onPointerUp() {
    if (!start.current && !dragging) {
      setDx(0)
      return
    }
    start.current = null
    setDragging(false)
    if (-dx >= SWIPE_DELETE_THRESHOLD) {
      // Уводим за край и удаляем
      setRemoving(true)
      setDx(-window.innerWidth)
      setTimeout(onRemove, 180)
    } else if (-dx >= SWIPE_REVEAL_WIDTH / 2) {
      setDx(-SWIPE_REVEAL_WIDTH) // прилипнуть к раскрытой зоне
    } else {
      setDx(0)
    }
  }

  const revealed = dx <= -SWIPE_REVEAL_WIDTH / 2

  return (
    <div className="relative overflow-hidden rounded-2xl animate-[rise-in_0.18s_ease-out]">
      {/* Красная подложка удаления */}
      <button
        onClick={() => { setRemoving(true); setDx(-window.innerWidth); setTimeout(onRemove, 180) }}
        aria-label={t(lang, 'delete')}
        className="absolute inset-0 flex items-center justify-end bg-red-500 text-white pe-6"
        style={{ opacity: -dx > 8 ? 1 : 0 }}
      >
        <span className="text-sm font-semibold">{t(lang, 'delete')}</span>
      </button>

      {/* Сама строка — двигается поверх подложки */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative border border-gray-100 bg-white rounded-2xl p-3 touch-pan-y"
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : `transform ${removing ? 0.18 : 0.25}s ease-out`,
        }}
      >
        <div className="flex items-start gap-2.5">
          {item && <ItemImage item={item} size="line" />}
          <button
            className="text-start flex-1 min-w-0"
            // Игнорируем клик, если строка раскрыта свайпом (сначала закрываем)
            onClick={() => (revealed ? setDx(0) : onOpen())}
          >
            <span className="font-semibold text-gray-900 text-sm block leading-tight">
              {l.name}
              {l.variantName && <span className="text-gray-500 font-medium"> · {l.variantName}</span>}
            </span>
            {(l.mods.length > 0 || l.notes || l.priceOverride !== null) && (
              <span className="block text-xs text-gray-500 mt-0.5 truncate">
                {[
                  ...l.mods.map((m) => m.name),
                  l.notes,
                  l.priceOverride !== null ? t(lang, 'priceOverridden') : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </button>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <div className="flex items-center gap-1.5">
              <button
                onClick={onEditPrice}
                className={`font-bold text-sm tabular-nums ${
                  l.priceOverride !== null ? 'text-gray-900 underline decoration-dotted underline-offset-2' : 'text-gray-900'
                }`}
              >
                {formatMoney(lineUnitPrice(l) * l.qty, lang)}
              </button>
              <button onClick={onRemove} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-red-500">✕</button>
            </div>
            <div className="flex items-center gap-1">
              <Stepper onClick={onDec}>−</Stepper>
              <span className="w-6 text-center font-bold text-sm tabular-nums">{l.qty}</span>
              <Stepper onClick={onInc}>+</Stepper>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Строка уже заказанной позиции (счёт стола) со свайпом на снятие (void) */
function ExistingBillRow({
  line: l,
  lang,
  isRtl,
  busy,
  onVoid,
}: {
  line: BillLine
  lang: 'ru' | 'he'
  isRtl: boolean
  busy: boolean
  onVoid: () => void
}) {
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const locked = useRef(false)
  const sign = isRtl ? -1 : 1

  function onPointerDown(e: React.PointerEvent) {
    if (busy) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY }
    locked.current = false
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return
    const rawX = (e.clientX - start.current.x) * sign
    const rawY = e.clientY - start.current.y
    if (!locked.current) {
      if (Math.abs(rawX) > 8 && Math.abs(rawX) > Math.abs(rawY)) {
        locked.current = true
        setDragging(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      } else if (Math.abs(rawY) > 10) {
        start.current = null
        return
      }
    }
    if (locked.current) {
      e.preventDefault()
      const next = rawX < 0 ? rawX : rawX * 0.25
      setDx(Math.max(next, -140))
    }
  }
  function onPointerUp() {
    start.current = null
    setDragging(false)
    if (-dx >= 88) onVoid()
    setDx(0)
  }

  return (
    <div className="relative overflow-hidden rounded-xl">
      <div
        className="absolute inset-0 flex items-center justify-end bg-red-500 text-white pe-4 rounded-xl"
        style={{ opacity: -dx > 8 ? 1 : 0 }}
      >
        <span className="text-xs font-semibold">{t(lang, 'delete')}</span>
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative bg-gray-50 flex items-start justify-between gap-2 text-sm py-1 touch-pan-y"
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 0.22s ease-out',
        }}
      >
        <div className="min-w-0">
          <span className="font-semibold text-gray-700">
            {l.qty > 1 && <span className="text-gray-400">{l.qty}× </span>}
            {l.name}
            {l.variant_name && <span className="text-gray-500 font-medium"> · {l.variant_name}</span>}
          </span>
          {l.modifiers.length > 0 && (
            <span className="block text-xs text-gray-400 truncate">{l.modifiers.join(' · ')}</span>
          )}
        </div>
        <span className="font-bold text-gray-600 tabular-nums shrink-0">{formatMoney(l.line_total, lang)}</span>
      </div>
    </div>
  )
}

function ActionButton({
  icon,
  label,
  onClick,
  active = false,
}: {
  icon: 'customItem' | 'discount' | 'note' | 'refund'
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold
                 transition-all whitespace-nowrap active:scale-[0.97] ${
                   active
                     ? 'border-gray-900 bg-gray-900 text-white'
                     : 'border-gray-200 text-gray-900 hover:border-gray-400'
                 }`}
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-11 px-4 rounded-xl text-sm font-semibold whitespace-nowrap transition-all active:scale-[0.96] ${
        active ? 'bg-gray-200 text-gray-900' : 'text-gray-500 hover:bg-gray-100'
      }`}
    >
      {children}
    </button>
  )
}

function Stepper({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-11 h-11 rounded-xl bg-gray-50 border border-gray-200 text-base font-bold text-gray-600
                 flex items-center justify-center leading-none
                 hover:border-gray-400 active:scale-[0.9] transition-all"
    >
      {children}
    </button>
  )
}

