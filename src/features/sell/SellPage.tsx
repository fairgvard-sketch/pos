import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCategories, fetchItems, fetchModifierGroups, toggleItemAvailability, reorderItems } from '../menu/api'
// Редактор товара нужен только менеджеру в режиме правки — не грузим в горячий путь
const ItemEditor = lazy(() => import('../menu/ItemEditor'))
import { placeOrder, payOrder, splitOrder, type PaymentInput } from './api'
import { fetchCurrentShift } from '../shift/api'
import { fetchCurrentLocation } from '../auth/api'
import { appendToOrder, voidTableOrder, fetchOrderLines, voidOrderItem, setOrderDiscount, type BillLine } from '../tables/api'
import { useCartStore, cartSubtotal, cartTotal, discountAmount, loyaltyAmount, lineUnitPrice, type CartLine, type CartMod, type CartDiscount, type OrderType } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore, DEFAULT_ACTION_ORDER } from '../../store/deviceStore'
import { playPaymentChime } from '../../lib/sound'
import { autoPrintReceipt, autoPrintLocalReceipt, printKitchenTicket } from '../receipt/printService'
import { buildLocalReceipt } from '../receipt/localReceipt'
import { setOrderBuyer, type Receipt } from '../receipt/api'
import { OfflineError, withOfflineFallback, useNetStore } from '../../lib/offline/net'
import { enqueueOfflineSale, enqueueOfflinePayment, enqueueTableAppend, enqueueTablePayment, enqueueTableVoid } from '../../lib/offline/enqueue'
import { useOutboxStore } from '../../lib/offline/outboxStore'
import { billLineToReceiptLine } from '../receipt/localReceipt'
import type { KitchenTicketLine } from '../receipt/printCanvas'
import { t } from '../../lib/i18n'
import { payMethodIcon, payMethodLabel, type PayMethodId } from '../../lib/payMethods'
import { can } from '../../lib/perms'
import { formatMoney, formatMoneyList, roundTipToWholeTotal } from '../../lib/money'
import type { MenuItem, ModifierGroup } from '../../types'
import ItemPicker from './ItemPicker'
import PaymentSheet, { type OrderBuyer } from './PaymentSheet'
import TipSheet, { type TipOption } from './TipSheet'
import DiscountSheet from './DiscountSheet'
import PriceSheet from './PriceSheet'
import QtySheet from './QtySheet'
import TableSheet from './TableSheet'
import ShiftGate from '../shift/ShiftGate'
import ReceiptSheet from '../receipt/ReceiptSheet'
import ReceiptChoiceSheet from '../receipt/ReceiptChoiceSheet'
import SplitItemsSheet from './SplitItemsSheet'
import EqualSplitSheet from './EqualSplitSheet'
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

/** Заказ в потоке оплаты: после place, до pay (см. комментарий у payingOrder) */
interface PayingOrder {
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

/** Подписи тикета на языке интерфейса кассы */
function ticketLabels(lang: 'ru' | 'he') {
  return {
    takeaway: t(lang, 'takeaway'),
    here: t(lang, 'here'),
    delivery: t(lang, 'delivery'),
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
  const payMethodOrder = useDeviceStore((s) => s.payMethodOrder)
  const actionOrder = useDeviceStore((s) => s.actionOrder)
  const setActionOrder = useDeviceStore((s) => s.setActionOrder)
  const collectTips = useDeviceStore((s) => s.collectTips)
  const tipAskBeforePayment = useDeviceStore((s) => s.tipAskBeforePayment)
  const tipPresets = useDeviceStore((s) => s.tipPresets)
  const tipAllowCustom = useDeviceStore((s) => s.tipAllowCustom)
  const tipBeforeTax = useDeviceStore((s) => s.tipBeforeTax)
  const tipRoundUp = useDeviceStore((s) => s.tipRoundUp)
  const tipSmartAmounts = useDeviceStore((s) => s.tipSmartAmounts)
  const tipSmartThreshold = useDeviceStore((s) => s.tipSmartThreshold)
  const tipSmartFixed = useDeviceStore((s) => s.tipSmartFixed)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const online = useNetStore((s) => s.online)

  const { data: shift, isLoading: shiftLoading } = useQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  // Столы показываем, если точка не в режиме чистой стойки
  const showTable = location?.service_mode === 'counter_tables' || location?.service_mode === 'tables'

  // Права по ролям (настройки точки → Сотрудники → Права доступа)
  const canDiscount = can(staff?.role, 'discount', location?.settings)
  const canPriceEdit = can(staff?.role, 'price_edit', location?.settings)
  const canVoidOrder = can(staff?.role, 'void_order', location?.settings)
  /** Выполнить действие, если хватает прав; иначе — подсказка про менеджера */
  function requirePerm(allowed: boolean, fn: () => void) {
    if (!allowed) {
      toast.error(t(lang, 'permManagerToast'))
      return
    }
    fn()
  }
  const { data: categories = [] } = useQuery({ queryKey: ['menu_categories'], queryFn: fetchCategories })
  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
  const { data: allGroups = [] } = useQuery({ queryKey: ['modifier_groups'], queryFn: fetchModifierGroups })

  const cart = useCartStore()

  // null = все товары. Категории всегда остаются на экране, поэтому товар
  // доступен первым тапом без отдельного «корня» витрины.
  const [activeCat, setActiveCat] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [picker, setPicker] = useState<{ item: MenuItem; line: CartLine | null } | null>(null)
  const [showDiscount, setShowDiscount] = useState(false)
  const [showGuest, setShowGuest] = useState(false)
  const [showCustom, setShowCustom] = useState(false)
  const [showTableSheet, setShowTableSheet] = useState(false)
  // Строка, у которой правим цену вручную (edit-режим PriceSheet)
  const [editingPrice, setEditingPrice] = useState<CartLine | null>(null)
  // Строка, у которой правим количество (QtySheet)
  const [editingQty, setEditingQty] = useState<CartLine | null>(null)

  // ── Стоп-лист (047): long-press по товару → «Нет в наличии» ──
  const [stopCandidate, setStopCandidate] = useState<MenuItem | null>(null)
  const [showStopList, setShowStopList] = useState(false)
  const stoppedItems = useMemo(() => items.filter((i) => !i.is_available), [items])
  // Стоп-лист (P7): переключение доступности сразу отражается на витрине,
  // откат при ошибке. Товар мгновенно уходит/возвращается без ожидания refetch.
  const stopItemMut = useMutation<void, Error, { id: string; available: boolean }, { prev: MenuItem[] | undefined }>({
    mutationFn: (v) => toggleItemAvailability(v.id, v.available),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['menu_items'] })
      const prev = qc.getQueryData<MenuItem[]>(['menu_items'])
      qc.setQueryData<MenuItem[]>(['menu_items'], (old) =>
        old?.map((i) => (i.id === v.id ? { ...i, is_available: v.available } : i))
      )
      return { prev }
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['menu_items'], ctx.prev)
      toast.error(e.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['menu_items'] }),
  })
  // Long-press по плитке товара (порог движения — чтобы не мешать скроллу)
  const tileTimer = useRef<number | null>(null)
  const tileFired = useRef(false)
  const tileStart = useRef({ x: 0, y: 0 })
  function tilePressStart(item: MenuItem, e: React.PointerEvent) {
    tileFired.current = false
    tileStart.current = { x: e.clientX, y: e.clientY }
    tileTimer.current = window.setTimeout(() => {
      tileTimer.current = null
      tileFired.current = true
      setStopCandidate(item)
    }, 550)
  }
  function tilePressCancel() {
    if (tileTimer.current !== null) {
      clearTimeout(tileTimer.current)
      tileTimer.current = null
    }
  }
  function tilePressMove(e: React.PointerEvent) {
    if (Math.abs(e.clientX - tileStart.current.x) > 10 || Math.abs(e.clientY - tileStart.current.y) > 10) {
      tilePressCancel()
    }
  }

  // ── Правка витрины (менеджер): тап по плитке — редактор товара,
  //    long-press — перестановка (та же механика, что у ряда действий,
  //    но по 2D-сетке). Полная админка (модификаторы, станции) — Настройки→Бизнес.
  const isManager = staff?.role === 'owner' || staff?.role === 'manager'
  const [editMode, setEditMode] = useState(false)
  const [editorItem, setEditorItem] = useState<MenuItem | 'new' | null>(null)
  const [dragTile, setDragTile] = useState<string | null>(null)
  // Wiggle-режим (как на iPhone): long-press включает, плитки дрожат и
  // таскаются без повторного long-press, тап по экрану выключает
  const [wiggleMode, setWiggleMode] = useState(false)
  // Локальный порядок текущей выборки на время перетаскивания (id плиток)
  const [tileOrder, setTileOrder] = useState<string[] | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const tileDragTimer = useRef<number | null>(null)
  const tileDragStartPt = useRef<{ x: number; y: number } | null>(null)
  const suppressTileClick = useRef(false)

  const reorderMut = useMutation({
    mutationFn: reorderItems,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu_items'] }),
    onError: (e) => toast.error(e.message),
  })

  function tileDragDown(item: MenuItem, e: React.PointerEvent) {
    if (search.trim()) return // в результатах поиска порядок не правим
    if (e.pointerType === 'mouse' && e.button !== 0) return
    suppressTileClick.current = false
    tileDragStartPt.current = { x: e.clientX, y: e.clientY }
    const el = e.currentTarget as HTMLElement
    const pointerId = e.pointerId
    // Внутри wiggle-режима плитка поднимается почти сразу (короткая пауза
    // оставляет шанс быстрому свайпу остаться скроллом); вход — long-press
    tileDragTimer.current = window.setTimeout(() => {
      tileDragTimer.current = null
      setWiggleMode(true)
      setDragTile(item.id)
      suppressTileClick.current = true
      try { el.setPointerCapture(pointerId) } catch { /* старый WebView */ }
      document.addEventListener('touchmove', preventTouchScroll.current, { passive: false })
      navigator.vibrate?.(15)
    }, wiggleMode ? 120 : 450)
  }

  function tileDragMove(item: MenuItem, e: React.PointerEvent) {
    if (tileDragTimer.current !== null && tileDragStartPt.current) {
      if (Math.abs(e.clientX - tileDragStartPt.current.x) > 10 || Math.abs(e.clientY - tileDragStartPt.current.y) > 10) {
        window.clearTimeout(tileDragTimer.current)
        tileDragTimer.current = null
      }
      return
    }
    if (dragTile !== item.id || !gridRef.current) return
    // Курсор над соседней плиткой → dragged занимает её слот
    for (const child of Array.from(gridRef.current.children) as HTMLElement[]) {
      const cid = child.dataset.tileId
      if (!cid || cid === item.id) continue
      const r = child.getBoundingClientRect()
      if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) {
        const base = tileOrder ?? visibleItems.map((i) => i.id)
        const without = base.filter((x) => x !== item.id)
        const wasBefore = base.indexOf(item.id) < base.indexOf(cid)
        without.splice(without.indexOf(cid) + (wasBefore ? 1 : 0), 0, item.id)
        setTileOrder(without)
        break
      }
    }
  }

  /** Уход указателя с плитки: отменяет только ОЖИДАНИЕ long-press.
   *  Активный drag не трогаем — с pointer capture leave прилетает при
   *  каждом выходе за границы плитки, а тянуть нужно по всей сетке. */
  function tileDragLeave() {
    if (tileDragTimer.current !== null) {
      window.clearTimeout(tileDragTimer.current)
      tileDragTimer.current = null
    }
  }

  function tileDragEnd() {
    if (tileDragTimer.current !== null) {
      window.clearTimeout(tileDragTimer.current)
      tileDragTimer.current = null
    }
    if (dragTile !== null) {
      setDragTile(null)
      document.removeEventListener('touchmove', preventTouchScroll.current)
      // Персист: локальный порядок выборки вписываем в глобальный порядок каталога
      if (tileOrder) {
        const visSet = new Set(tileOrder)
        const queue = [...tileOrder]
        reorderMut.mutate(items.map((i) => (visSet.has(i.id) ? queue.shift()! : i.id)))
      }
    }
    tileDragStartPt.current = null
  }

  // ── Перестановка кнопок ряда действий long-press'ом (как на iPhone) ──
  // Долгое нажатие «поднимает» кнопку, движение по горизонтали меняет её
  // место в ряду; порядок хранится per-device (deviceStore.actionOrder).
  const [dragAction, setDragAction] = useState<string | null>(null)
  const actionsRowRef = useRef<HTMLDivElement>(null)
  const dragTimer = useRef<number | null>(null)
  const dragStartPt = useRef<{ x: number; y: number } | null>(null)
  const suppressActionClick = useRef(false)
  // Пока тянем — глушим нативный скролл (touch-action менять мид-жестом нельзя)
  const preventTouchScroll = useRef((e: TouchEvent) => e.preventDefault())

  // Сохранённый порядок + новые кнопки, которых в нём ещё нет (апгрейд версии)
  const fullActionOrder = useMemo(
    () => [
      ...actionOrder.filter((id) => DEFAULT_ACTION_ORDER.includes(id)),
      ...DEFAULT_ACTION_ORDER.filter((id) => !actionOrder.includes(id)),
    ],
    [actionOrder]
  )

  function actionDragDown(id: string, e: React.PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    suppressActionClick.current = false
    dragStartPt.current = { x: e.clientX, y: e.clientY }
    const el = e.currentTarget as HTMLElement
    const pointerId = e.pointerId
    dragTimer.current = window.setTimeout(() => {
      dragTimer.current = null
      setDragAction(id)
      suppressActionClick.current = true // после drag тап не должен «нажать» кнопку
      try { el.setPointerCapture(pointerId) } catch { /* старый WebView */ }
      document.addEventListener('touchmove', preventTouchScroll.current, { passive: false })
      navigator.vibrate?.(15)
    }, 450)
  }

  function actionDragMove(id: string, e: React.PointerEvent) {
    // Таймер ещё тикает: заметное движение = обычный тап/скролл ряда, отменяем long-press
    if (dragTimer.current !== null && dragStartPt.current) {
      if (Math.abs(e.clientX - dragStartPt.current.x) > 10 || Math.abs(e.clientY - dragStartPt.current.y) > 10) {
        window.clearTimeout(dragTimer.current)
        dragTimer.current = null
      }
      return
    }
    if (dragAction !== id || !actionsRowRef.current) return
    // Курсор над соседней кнопкой → dragged занимает её слот
    for (const child of Array.from(actionsRowRef.current.children) as HTMLElement[]) {
      const cid = child.dataset.actionId
      if (!cid || cid === id) continue
      const r = child.getBoundingClientRect()
      if (e.clientX > r.left && e.clientX < r.right) {
        const without = fullActionOrder.filter((x) => x !== id)
        const wasBefore = fullActionOrder.indexOf(id) < fullActionOrder.indexOf(cid)
        without.splice(without.indexOf(cid) + (wasBefore ? 1 : 0), 0, id)
        setActionOrder(without)
        break
      }
    }
  }

  function actionDragEnd() {
    if (dragTimer.current !== null) {
      window.clearTimeout(dragTimer.current)
      dragTimer.current = null
    }
    if (dragAction !== null) {
      setDragAction(null)
      document.removeEventListener('touchmove', preventTouchScroll.current)
    }
    dragStartPt.current = null
  }
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

  // Одноуровневая витрина: товары видны сразу, категории — постоянный фильтр.
  // Поиск работает по всему каталогу независимо от выбранной категории.
  const activeCats = useMemo(() => categories.filter((c) => c.is_active), [categories])

  // Чип «Все товары» скрываем настройкой точки (069, settings.interface).
  // Без него витрина всегда в конкретной категории: как только категории
  // загрузились, выбираем первую (setState в рендере — паттерн tileCtxKey ниже).
  const showAllTab = location?.settings.interface?.show_all_items_tab !== false
  if (!showAllTab && activeCat === null && activeCats.length > 0) {
    setActiveCat(activeCats[0].id)
  }

  // Смена контекста (категория/поиск/выход из правки) сбрасывает локальный
  // порядок и wiggle-режим. Сброс по смене ключа прямо в рендере (не setState
  // в эффекте): React перерисует с обнулёнными значениями до отрисовки. Стоит
  // ДО visibleItems, чтобы актуальный tileOrder уже участвовал в мемоизации.
  const tileCtxKey = `${editMode}|${activeCat ?? ''}|${search}`
  const [prevTileCtx, setPrevTileCtx] = useState(tileCtxKey)
  if (tileCtxKey !== prevTileCtx) {
    setPrevTileCtx(tileCtxKey)
    setTileOrder(null)
    setWiggleMode(false)
  }

  const visibleItems = useMemo(() => {
    // В режиме правки показываем и снятые с продажи (приглушёнными)
    let list = editMode ? items : items.filter((i) => i.is_available)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      return list.filter((i) => i.name.toLowerCase().includes(q))
    }
    if (activeCat) list = list.filter((i) => i.category_id === activeCat)
    if (tileOrder) {
      // Перетаскивание: локальный порядок поверх серверного (до инвалидации)
      const pos = new Map(tileOrder.map((id, i) => [id, i]))
      list = list.slice().sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity))
    }
    return list
  }, [items, activeCat, search, editMode, tileOrder])

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

  // База процента чаевых: итог с НДС или без (настройка кассы)
  function tipPercentBase(total: number): number {
    return tipBeforeTax ? total - Math.round((total * vatRate) / (100 + vatRate)) : total
  }

  // Варианты чаевых для суммы: умный режим на мелких заказах — фиксированные ₪,
  // иначе проценты от базы. Каждый вариант подгоняется так, чтобы итог
  // к оплате (total + tip) был целым числом шекелей.
  function tipOptions(total: number): TipOption[] {
    if (tipSmartAmounts && total <= tipSmartThreshold) {
      return tipSmartFixed
        .filter((a) => a > 0)
        .map((a) => ({ amount: roundTipToWholeTotal(total, a, tipRoundUp) }))
    }
    const base = tipPercentBase(total)
    return tipPresets
      .filter((p) => p > 0)
      .map((p) => ({ percent: p, amount: roundTipToWholeTotal(total, Math.round((base * p) / 100), tipRoundUp) }))
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
          lines: cart.lines.map(toTicketLine),
          labels: ticketLabels(lang),
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

  const tableCtx = cart.tableCtx

  // Офлайн (фаза 7): эхо счёта стола. Ключ = tableCtx.orderId — локальный
  // uuid (стол открыт офлайн) либо серверный order_id (офлайн-дозаказ к
  // серверному счёту). isLocalTable = счёт существует только на кассе.
  const tableEcho = useOutboxStore((s) => (tableCtx ? s.localOrders[tableCtx.orderId] : undefined))
  const isLocalTable = !!tableEcho && tableEcho.serverOrderId === null

  // Уже заказанные позиции открытого счёта стола (read-only, до дозаказа).
  // cart.lines в режиме стола = только НОВЫЕ позиции, поэтому существующие
  // тянем отдельно, чтобы бариста/кассир видел, что уже на столе.
  const { data: fetchedLines = [] } = useQuery({
    queryKey: ['order_lines', tableCtx?.orderId],
    queryFn: () => fetchOrderLines(tableCtx!.orderId),
    enabled: !!tableCtx && !isLocalTable,
  })
  // Строки счёта: серверные + офлайн-дозаказы из эха
  const existingLines = useMemo<BillLine[]>(() => {
    const echoLines: BillLine[] = (tableEcho?.lines ?? []).map((l) => ({
      id: l.key,
      name: l.name,
      variant_name: l.variantName,
      qty: l.qty,
      line_total: lineUnitPrice(l) * l.qty,
      modifiers: l.mods.map((m) => m.name),
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

  const subtotal = cartSubtotal(cart.lines)
  const discAmount = discountAmount(subtotal, cart.discount, cart.redeem)

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

  // Корзина изменилась → «бесплатный напиток» следует за ней (или отменяется).
  // setRedeem меняет стор корзины — держим его в эффекте, но сам эффект
  // реагирует на согласованный флаг рассинхрона, а не зовёт setState «в лоб».
  const setRedeem = cart.setRedeem
  const stampRedeemAmount = cart.redeem?.type === 'stamps' ? cart.redeem.amount : null
  const stampRedeemStale =
    stampRedeemAmount !== null && stampRedeemAmount !== (freeItemPrice ?? null)
  useEffect(() => {
    if (!stampRedeemStale) return
    if (freeItemPrice === null) setRedeem(null)
    else setRedeem({ type: 'stamps', amount: freeItemPrice })
  }, [stampRedeemStale, freeItemPrice, setRedeem])

  const loyAmount = loyaltyAmount(subtotal, cart.discount, cart.redeem)
  const total = cartTotal(cart.lines, cart.discount, cart.redeem)
  // НДС включён в цену — показываем справочно по ставке точки (снапшот считает сервер)
  const vatRate = Number(location?.vat_rate ?? 18)
  const vatIncluded = Math.round((total * vatRate) / (100 + vatRate))
  // Итог панели заказа: в режиме стола — уже в счёте + добавленное
  const shownTotal = tableCtx ? tableCtx.existingTotal + total : total

  // Корзина опустела (сняли позиции) — ручные чаевые больше не к чему.
  // Обнуляем во время рендера (не setState в эффекте): после сброса условие
  // сразу перестаёт выполняться, каскада нет.
  if (shownTotal === 0 && cartTip > 0) setCartTip(0)

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
      <AppSidebar active={location?.service_mode === 'tables' && tableCtx ? 'hall' : 'sell'} />

      {/* ── Каталог ─────────────────────────────────── */}
      <main className="flex-1 min-w-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-5 pb-0 shrink-0">
          {/* Поиск и действия: поиск ФИЗИЧЕСКИ слева в обоих направлениях.
              В LTR обычный порядок кладёт input влево; в RTL зеркалит вправо —
              поэтому для RTL разворачиваем строку обратно (input снова у левого края). */}
          <div className="flex items-center gap-3 py-4 short:py-2 rtl:flex-row-reverse">
            <input
              className="w-64 max-w-[40%] shrink-0 h-11 rounded-2xl border border-gray-100 bg-gray-50 px-4 text-sm
                         placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900/10
                         focus:bg-white transition-all"
              placeholder={t(lang, 'searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {/* Правка витрины: тумблер-карандаш (только менеджер) — рядом с поиском */}
            {isManager && (
              <button
                onClick={() => setEditMode((v) => !v)}
                aria-label={t(lang, 'menuEditMode')}
                title={t(lang, 'menuEditMode')}
                className={`shrink-0 w-11 h-11 rounded-2xl border flex items-center justify-center transition-all active:scale-[0.94] ${
                  editMode
                    ? 'bg-gray-900 border-gray-900 text-white'
                    : 'border-gray-100 bg-gray-50 text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
            {/* Середина строки: стоп-лист прижат к правому физическому краю
                (auto-margin с RTL-разворотом, как раньше у чипов). */}
            <div className="flex-1 flex items-center gap-3 min-w-0 rtl:flex-row-reverse">
              {/* Стоп-лист: виден только когда есть снятые товары */}
              {stoppedItems.length > 0 && (
                <span className="ms-auto rtl:ms-0 rtl:me-auto shrink-0">
                  <Chip active={false} onClick={() => setShowStopList(true)}>
                    {t(lang, 'stopListTitle')} · {stoppedItems.length}
                  </Chip>
                </span>
              )}
            </div>
          </div>
          {/* Категории не открывают отдельный уровень: это постоянный быстрый
              фильтр над товарами. «Избранного» здесь намеренно нет. */}
          {activeCats.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-3 select-none">
              {showAllTab && (
                <Chip
                  active={activeCat === null}
                  onClick={() => { setActiveCat(null); setSearch('') }}
                >
                  {t(lang, 'allItems')}
                </Chip>
              )}
              {activeCats.map((category) => (
                <Chip
                  key={category.id}
                  active={activeCat === category.id}
                  onClick={() => { setActiveCat(category.id); setSearch('') }}
                >
                  {category.name}
                </Chip>
              ))}
            </div>
          )}
          {editMode && (
            <p className="text-xs text-gray-500 pb-2">
              {t(lang, wiggleMode ? 'menuWiggleHint' : 'menuEditHint')}
            </p>
          )}
        </div>

        <div
          className="flex-1 overflow-y-auto px-5 pb-5"
          onClickCapture={(e) => {
            // Wiggle-режим: любой тап по экрану (не перенос) завершает его,
            // ничего под пальцем не срабатывает — как выход из режима на iOS
            if (!wiggleMode) return
            e.preventDefault()
            e.stopPropagation()
            if (suppressTileClick.current) { suppressTileClick.current = false; return } // клик-эхо после переноса
            setWiggleMode(false)
          }}
        >
          {visibleItems.length === 0 && !editMode ? (
            <p className="text-gray-500 text-sm text-center pt-20">{t(lang, 'nothingFound')}</p>
          ) : (
            <div ref={gridRef} className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  data-tile-id={item.id}
                  onClick={() => {
                    if (editMode) {
                      // Клик после drag-перестановки — не открывать редактор
                      if (suppressTileClick.current) { suppressTileClick.current = false; return }
                      setEditorItem(item)
                      return
                    }
                    // Клик после long-press (стоп-лист) — не добавлять в корзину
                    if (tileFired.current) { tileFired.current = false; return }
                    handleItemTap(item)
                  }}
                  onPointerDown={(e) => (editMode ? tileDragDown(item, e) : tilePressStart(item, e))}
                  onPointerUp={() => (editMode ? tileDragEnd() : tilePressCancel())}
                  onPointerLeave={() => (editMode ? tileDragLeave() : tilePressCancel())}
                  onPointerCancel={() => (editMode ? tileDragEnd() : tilePressCancel())}
                  onPointerMove={(e) => (editMode ? tileDragMove(item, e) : tilePressMove(e))}
                  onContextMenu={(e) => e.preventDefault()}
                  className={`relative overflow-hidden rounded-2xl border text-start bg-white transition-all duration-150 ${
                    dragTile === item.id
                      ? 'border-gray-900 shadow-[0_12px_32px_rgba(0,0,0,0.18)] scale-105 z-10'
                      : wiggleMode
                        ? 'border-gray-300 animate-[btn-wiggle_0.3s_ease-in-out_infinite]'
                        : 'border-gray-300 hover:border-gray-400 hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)] active:scale-[0.97]'
                  } ${editMode && !item.is_available ? 'opacity-40' : ''}`}
                >
                  {editMode ? (
                    <span className="absolute top-2 end-2 z-10 w-6 h-6 rounded-full bg-gray-900 text-white flex items-center justify-center shadow-sm">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  ) : item.is_favorite && (
                    <span className="absolute top-2.5 end-2.5 z-10 text-amber-400 text-sm drop-shadow-sm">★</span>
                  )}
                  <ItemImage item={item} size="tile" />
                  <div className="p-3">
                    <div className="font-semibold text-gray-900 text-sm leading-tight">{item.name}</div>
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
                  </div>
                </button>
              ))}
              {/* Режим правки: плитка «+ Товар» в конце сетки */}
              {editMode && !search.trim() && (
                <button
                  onClick={() => setEditorItem('new')}
                  className="rounded-2xl border-2 border-dashed border-gray-200 min-h-[140px] p-3
                             flex flex-col items-center justify-center text-gray-400
                             hover:text-gray-600 hover:border-gray-300 transition-all active:scale-[0.97]"
                >
                  <span className="text-3xl leading-none font-light">+</span>
                  <span className="mt-1.5 text-sm font-semibold">{t(lang, 'newItem')}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Ряд действий. Long-press на кнопке → режим перестановки (как iOS):
            кнопка поднимается, тянешь по горизонтали — меняются местами. */}
        <div
          ref={actionsRowRef}
          className="shrink-0 border-t border-gray-100 px-5 pt-3 pb-5 short:pb-3 flex gap-2 overflow-x-auto select-none"
        >
          {fullActionOrder.map((id) => {
            const def = {
              customItem: {
                icon: 'customItem' as const,
                label: t(lang, 'customItem'),
                visible: true,
                active: false,
                dimmed: false,
                onClick: () => setShowCustom(true),
              },
              discount: {
                icon: 'discount' as const,
                label: t(lang, 'discount'),
                visible: true,
                active: tableCtx ? !!tableDiscount : !!cart.discount,
                dimmed: !canDiscount,
                onClick: () => requirePerm(canDiscount, () => setShowDiscount(true)),
              },
              loyalty: {
                icon: 'customers' as const,
                // Выбранный гость виден прямо на кнопке: имя/телефон вместо «Лояльность»
                label: cart.guest ? cart.guest.name || formatPhone(cart.guest.phone) : t(lang, 'loyaltyLabel'),
                visible: loyaltyOn,
                active: !!cart.guest,
                dimmed: false,
                // Лояльность требует сети: балансы гостя валидирует сервер
                onClick: () => (online ? setShowGuest(true) : toast.error(t(lang, 'offlineBlockedHint'))),
              },
              refund: {
                icon: 'refund' as const,
                label: t(lang, 'refund'),
                visible: true,
                active: false,
                dimmed: false,
                onClick: () => navigate('/transactions'),
              },
              tip: {
                icon: 'cash' as const,
                label: t(lang, 'tipTitle'),
                visible: collectTips,
                active: cartTip > 0,
                dimmed: false,
                onClick: () => { if (shownTotal > 0) setShowTipSheet(true) },
              },
            }[id]
            if (!def || !def.visible) return null
            return (
              <div
                key={id}
                data-action-id={id}
                onPointerDown={(e) => actionDragDown(id, e)}
                onPointerMove={(e) => actionDragMove(id, e)}
                onPointerUp={actionDragEnd}
                onPointerCancel={actionDragEnd}
                onContextMenu={(e) => dragAction && e.preventDefault()}
                onClickCapture={(e) => {
                  // Гасим клик, который браузер шлёт после long-press/перетаскивания
                  if (suppressActionClick.current) {
                    e.preventDefault()
                    e.stopPropagation()
                    suppressActionClick.current = false
                  }
                }}
                className={`shrink-0 transition-transform ${
                  dragAction === id
                    ? 'scale-110 opacity-90 drop-shadow-lg z-10'
                    : dragAction
                      ? 'animate-[btn-wiggle_0.3s_ease-in-out_infinite]'
                      : ''
                }`}
              >
                <ActionButton
                  icon={def.icon}
                  label={def.label}
                  active={def.active}
                  dimmed={def.dimmed}
                  onClick={def.onClick}
                />
              </div>
            )
          })}
        </div>
      </main>

      {/* ── Заказ ───────────────────────────────────── */}
      <aside className="w-[clamp(300px,25vw,360px)] shrink-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-4 pb-3 shrink-0">
          {tableCtx ? (
            /* Режим столов: работаем со счётом конкретного стола */
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-lg font-bold text-gray-900">
                {t(lang, 'tableLabel')} {tableCtx.tableLabel}
                <span className="text-gray-500 font-semibold"> · {t(lang, 'openBill')}</span>
              </h2>
              {tableCtx.existingTotal > 0 && (
                <span className="text-sm font-bold text-gray-500 tabular-nums">
                  {formatMoney(tableCtx.existingTotal, lang)}
                </span>
              )}
            </div>
          ) : (
            <>
              <h2 className="text-lg font-bold text-gray-900 mb-3">{t(lang, 'newOrderTitle')}</h2>
              <OrderTypeSwitch
                value={cart.orderType}
                onChange={cart.setOrderType}
                lang={lang}
                isRtl={isRtl}
              />
              {showTable && (
                <button
                  onClick={() => setShowTableSheet(true)}
                  className={`input w-full text-start ${cart.tableLabel ? 'text-gray-900 font-semibold' : 'text-gray-500'}`}
                >
                  {cart.tableLabel ? `${t(lang, 'tableLabel')} ${cart.tableLabel}` : t(lang, 'tablePlaceholder')}
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 space-y-2">
          {/* Режим стола: уже заказанные позиции. Свайп влево → снять с счёта (void). */}
          {tableCtx && existingLines.length > 0 && (
            <div className="rounded-2xl bg-gray-50 border border-gray-100 p-3 space-y-1.5">
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">{t(lang, 'alreadyInBill')}</div>
              {existingLines.map((l) => (
                <ExistingBillRow
                  key={l.id}
                  line={l}
                  lang={lang}
                  isRtl={isRtl}
                  busy={voidItem.isPending}
                  onVoid={() => requirePerm(canVoidOrder, () => {
                    // Офлайн-строки (эхо) и работа без сети: снятие позиции
                    // требует сервера — упрощение v1, см. план фазы 7
                    const isEchoLine = (tableEcho?.lines ?? []).some((el) => el.key === l.id)
                    if (isEchoLine || !online) {
                      toast.error(t(lang, 'offlineBlockedHint'))
                      return
                    }
                    if (confirm(t(lang, 'confirmVoidItem'))) voidItem.mutate(l.id)
                  })}
                />
              ))}
            </div>
          )}

          {cart.lines.length === 0 && (!tableCtx || existingLines.length === 0) && (
            <div className="min-h-[240px] h-full flex flex-col items-center justify-center text-center px-6 pb-8">
              <div className="w-12 h-12 rounded-2xl bg-gray-100 text-gray-600 flex items-center justify-center mb-3">
                <Icon name="orders" size={22} />
              </div>
              <p className="font-bold text-gray-900">
                {t(lang, tableCtx ? 'addToBill' : 'newOrderTitle')}
              </p>
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'cartEmptyHint')}</p>
              {tableCtx && (
                <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-gray-100 px-3 h-9 text-xs font-semibold text-gray-700">
                  <span className="w-6 h-6 rounded-full bg-gray-900 text-white flex items-center justify-center font-bold">
                    {staff.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="max-w-[160px] truncate">{staff.name}</span>
                </div>
              )}
            </div>
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
                onOpen={() => (item ? setPicker({ item, line: l }) : requirePerm(canPriceEdit, () => setEditingPrice(l)))}
                onEditPrice={() => requirePerm(canPriceEdit, () => setEditingPrice(l))}
                onRemove={() => cart.removeLine(l.key)}
                onQty={() => setEditingQty(l)}
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
              onClick={() => requirePerm(canDiscount, () => setShowDiscount(true))}
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
              onClick={() => requirePerm(canDiscount, () => setShowDiscount(true))}
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
          {/* Чаевые с кнопки — тап по строке меняет сумму */}
          {cartTip > 0 && (
            <button
              onClick={() => setShowTipSheet(true)}
              className="flex justify-between w-full text-sm text-emerald-600 font-medium"
            >
              <span>{t(lang, 'tipTitle')}</span>
              <span className="tabular-nums">+{formatMoney(cartTip, lang)}</span>
            </button>
          )}
          <div className="flex justify-between items-baseline pt-1">
            <span className="font-bold text-gray-900">{t(lang, 'total')}</span>
            {(() => {
              const shown = shownTotal + cartTip
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
                    {cart.lines.length > 0 && <span className="tabular-nums">{formatMoney(total + cartTip, lang)}</span>}
                  </button>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {/* Порядок кнопок = порядок способов оплаты этой кассы */}
                    {payMethodOrder.map((m) => (
                      <button
                        key={m}
                        onClick={() => place.mutate(m)}
                        disabled={disabled}
                        className="btn-secondary min-h-[52px] !rounded-2xl flex items-center justify-center gap-2"
                      >
                        <Icon name={payMethodIcon(m)} size={18} /> {payMethodLabel(lang, m)}
                      </button>
                    ))}
                  </div>
                </>
              )
            })()
          )}
        </div>
      </aside>

      {/* Шаг чаевых (настройка «Собирать чаевые») — перед окном оплаты */}
      {tipping && (
        <TipSheet
          total={tipping.total}
          percentBase={tipPercentBase(tipping.total)}
          options={tipOptions(tipping.total)}
          allowCustom={tipAllowCustom}
          roundUp={tipRoundUp}
          busy={pay.isPending}
          onCancel={() => cancelPayFlow(tipping)}
          onDone={(tip) => proceedPayment(tipping, tip)}
        />
      )}

      {/* Чаевые с кнопки на экране продажи — до оформления заказа */}
      {showTipSheet && (
        <TipSheet
          total={shownTotal}
          percentBase={tipPercentBase(shownTotal)}
          options={tipOptions(shownTotal)}
          allowCustom={tipAllowCustom}
          roundUp={tipRoundUp}
          busy={false}
          onCancel={() => setShowTipSheet(false)}
          onDone={(tip) => { setCartTip(tip); setShowTipSheet(false) }}
        />
      )}

      {/* Оплата созданного заказа (наличные с расчётом сдачи или выбор способа) */}
      {payingOrder && !showSplit && !showEqualSplit && (
        <PaymentSheet
          total={payingOrder.total + (payingOrder.tip ?? 0)}
          tip={payingOrder.tip ?? 0}
          startMode={payingOrder.intent === 'cash' ? 'cash' : 'choose'}
          busy={pay.isPending}
          onCancel={() => cancelPayFlow(payingOrder)}
          onPay={(payments, buyer) => pay.mutate({ orderId: payingOrder.orderId, dailyNumber: payingOrder.dailyNumber, payments, tip: payingOrder.tip ?? 0, offline: payingOrder.offline, buyer })}
          // split_order пересчитывает итоги без loyalty_discount — при выбранной
          // награде сплит недоступен; офлайн — тоже (split_order не идемпотентен)
          onSplitItems={cart.redeem || payingOrder.offline || !online ? undefined : () => setShowSplit(true)}
          onSplitEqually={() => setShowEqualSplit(true)}
          // set_order_buyer требует сеть и серверный заказ — офлайн скрываем
          allowBuyer={!payingOrder.offline && online}
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

      {/* Разделить поровну на N гостей: один чек, N платежей (тот же pay_order) */}
      {payingOrder && showEqualSplit && (
        <EqualSplitSheet
          total={payingOrder.total + (payingOrder.tip ?? 0)}
          busy={pay.isPending}
          onBack={() => setShowEqualSplit(false)}
          onCancel={() => { setShowEqualSplit(false); cancelPayFlow(payingOrder) }}
          onPay={(payments) => pay.mutate({ orderId: payingOrder.orderId, dailyNumber: payingOrder.dailyNumber, payments, tip: payingOrder.tip ?? 0, offline: payingOrder.offline })}
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
              // Скидка стола живёт на заказе (RPC) — без сети недоступна (v1)
              if (isLocalTable || !online) {
                toast.error(t(lang, 'offlineBlockedHint'))
                return
              }
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

      {editingQty && (
        <QtySheet
          name={editingQty.name}
          qty={editingQty.qty}
          onSubmit={(qty) => {
            cart.updateQty(editingQty.key, qty) // qty ≤ 0 удаляет строку
            setEditingQty(null)
          }}
          onCancel={() => setEditingQty(null)}
        />
      )}

      {/* Редактор товара из режима правки витрины (переиспользуем админку меню) */}
      {editorItem !== null && (
        <div className="fixed inset-0 z-50 bg-[#eceef1] p-3 flex">
          <Suspense fallback={null}>
            <ItemEditor
              key={editorItem === 'new' ? 'new' : editorItem.id}
              item={editorItem === 'new' ? null : editorItem}
              defaultCategoryId={activeCat ?? (activeCats[0]?.id ?? '')}
              onSaved={() => setEditorItem(null)}
              onDeleted={() => setEditorItem(null)}
              onBack={() => setEditorItem(null)}
            />
          </Suspense>
        </div>
      )}

      {/* Подтверждение стоп-листа: long-press по товару */}
      {stopCandidate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setStopCandidate(null)}>
          <div className="card w-full max-w-sm p-6 animate-[rise-in_0.2s_ease-out]" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-black text-gray-900 mb-1">{stopCandidate.name}</h2>
            <p className="text-sm text-gray-500 mb-5">
              {t(lang, 'itemOutOfStock')}?
              {stopCandidate.track_inventory && stopCandidate.stock != null && (
                <span className="tabular-nums"> · {t(lang, 'stockLeft')}: {stopCandidate.stock}</span>
              )}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  stopItemMut.mutate({ id: stopCandidate.id, available: false })
                  setStopCandidate(null)
                }}
                className="btn-primary !py-3 !rounded-2xl"
              >
                {t(lang, 'stopItemBtn')}
              </button>
              <button onClick={() => setStopCandidate(null)} className="btn-secondary !py-3 !rounded-2xl">
                {t(lang, 'cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Стоп-лист: снятые товары, возврат в продажу одним тапом */}
      {showStopList && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowStopList(false)}>
          <div className="card w-full max-w-md p-6 max-h-[80vh] overflow-y-auto animate-[rise-in_0.2s_ease-out]" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-black text-gray-900 mb-4">{t(lang, 'stopListTitle')}</h2>
            {stoppedItems.length === 0 ? (
              <p className="text-sm text-gray-500 py-8 text-center">{t(lang, 'stopListEmpty')}</p>
            ) : (
              <div className="space-y-1">
                {stoppedItems.map((i) => (
                  <div key={i.id} className="flex items-center gap-3 min-h-[52px] px-2 border-b border-gray-100">
                    <span className="flex-1 min-w-0 truncate font-semibold text-gray-900">
                      {i.name}
                      {i.track_inventory && i.stock != null && (
                        <span className="font-normal text-gray-500 text-sm tabular-nums"> · {t(lang, 'stockLeft')}: {i.stock}</span>
                      )}
                    </span>
                    <button
                      onClick={() => stopItemMut.mutate({ id: i.id, available: true })}
                      disabled={stopItemMut.isPending}
                      className="btn-secondary !py-2 !px-4 !text-sm shrink-0"
                    >
                      {t(lang, 'returnToSale')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setShowStopList(false)} className="btn-ghost w-full !py-3 !rounded-2xl mt-4">
              {t(lang, 'close')}
            </button>
          </div>
        </div>
      )}

      {placedNumber !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
          <div className="card px-12 py-10 text-center animate-[pop-in_0.35s_cubic-bezier(0.34,1.56,0.64,1)]">
            <div className="text-sm text-gray-500 mb-2">{t(lang, 'orderPlaced')}</div>
            {/* Офлайн-заказ показывает локальный номер K-n (уже с префиксом) */}
            <div className="text-7xl font-black text-gray-900 tabular-nums mb-8">
              {typeof placedNumber === 'string' ? placedNumber : `#${placedNumber}`}
            </div>
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
        <ReceiptSheet orderId={paidOrderId} receipt={paidLocalReceipt ?? undefined} onClose={() => setShowReceipt(false)} />
      )}

      {/* «Как выдать чек?» — после оплаты, до номера заказа/возврата в зал */}
      {receiptChoice && (
        <ReceiptChoiceSheet
          orderId={receiptChoice.orderId}
          receipt={receiptChoice.receipt}
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
  onQty,
}: {
  line: CartLine
  item: MenuItem | undefined
  lang: 'ru' | 'he'
  isRtl: boolean
  onOpen: () => void
  onEditPrice: () => void
  onRemove: () => void
  onQty: () => void
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
          {/* div с role=button (не <button>), чтобы вложенный кликабельный
              «× N» не был interactive-in-interactive */}
          <div
            role="button"
            tabIndex={0}
            className="text-start flex-1 min-w-0 cursor-pointer"
            // Игнорируем клик, если строка раскрыта свайпом (сначала закрываем)
            onClick={() => (revealed ? setDx(0) : onOpen())}
          >
            <span className="font-semibold text-gray-900 text-sm block leading-tight">
              {l.name}
              {/* Кол-во сразу после названия, мелким серым (как в референсе).
                  Тап по нему открывает панель −/+; stopPropagation → не onOpen. */}
              <span
                onClick={(e) => { e.stopPropagation(); onQty() }}
                className="text-gray-500 font-medium tabular-nums ms-1.5"
              >
                × {l.qty}
              </span>
            </span>
            {/* Вариант (размер), модификаторы, заметка, правка цены — строкой под названием */}
            {(l.variantName || l.mods.length > 0 || l.notes || l.priceOverride !== null) && (
              <span className="block text-sm text-gray-500 mt-0.5 leading-snug">
                {[
                  l.variantName,
                  ...l.mods.map((m) => m.name),
                  l.notes,
                  l.priceOverride !== null ? t(lang, 'priceOverridden') : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </div>
          <button
            onClick={onEditPrice}
            className={`font-bold text-sm tabular-nums shrink-0 ${
              l.priceOverride !== null ? 'text-gray-900 underline decoration-dotted underline-offset-2' : 'text-gray-900'
            }`}
          >
            {formatMoney(lineUnitPrice(l) * l.qty, lang)}
          </button>
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
            {l.qty > 1 && <span className="text-gray-500">{l.qty}× </span>}
            {l.name}
            {l.variant_name && <span className="text-gray-500 font-medium"> · {l.variant_name}</span>}
          </span>
          {l.modifiers.length > 0 && (
            <span className="block text-xs text-gray-500 leading-snug">{l.modifiers.join(' · ')}</span>
          )}
        </div>
        <span className="font-bold text-gray-600 tabular-nums shrink-0">{formatMoney(l.line_total, lang)}</span>
      </div>
    </div>
  )
}

/**
 * Переключатель типа заказа: одна полоса во всю ширину, показывает ТОЛЬКО
 * текущий вариант. Свайп листает (RTL-зеркально), тап — следующий по кругу.
 * Точки-индикаторы показывают, сколько вариантов и какой активен.
 *
 * Всё направление считается в ЭКРАННЫХ координатах (drag → knob едет за
 * пальцем, подпись выезжает с той же стороны). В RTL «следующий вариант»
 * физически слева — screenDir переводит экранное движение в шаг по списку.
 */
const ORDER_TYPES: OrderType[] = ['here', 'takeaway', 'delivery']
const SWIPE_THRESHOLD = 44   // px: минимальный горизонтальный сдвиг для перелистывания

function OrderTypeSwitch({
  value,
  onChange,
  lang,
  isRtl,
}: {
  value: OrderType
  onChange: (t: OrderType) => void
  lang: 'ru' | 'he'
  isRtl: boolean
}) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)   // был ли распознан свайп — тогда клик игнорируем
  // drag: смещение пальца во время жеста (экранные px); null — покоя
  const [drag, setDrag] = useState<number | null>(null)
  // Экранное направление последнего перехода: 1 — вправо, -1 — влево.
  // Подпись выезжает с той стороны, откуда пришёл жест/тап.
  const [screenDir, setScreenDir] = useState<1 | -1>(isRtl ? -1 : 1)
  // «Выезд»: анимируем, когда текущий value — тот, на который мы только что
  // перелистнули через slide(). Храним целевой тип (а не булев флаг), чтобы
  // выезд играл ровно на рендере со сменившимся value: как только slide меняет
  // тип, animateTo === value → анимация; при откате незавершённого свайпа value
  // не меняется, animateTo !== value → span откатывается через transition.
  // (Заменяет ref justChanged + эффект-сброс, которые читали ref в рендере.)
  const [animateTo, setAnimateTo] = useState<OrderType | null>(null)
  const justChanged = animateTo === value
  const idx = ORDER_TYPES.indexOf(value)

  // Перелистнуть по экранному направлению. sd>0 (вправо) в LTR = следующий,
  // в RTL = предыдущий (список растёт влево). Зеркалим шаг через isRtl.
  function slide(sd: 1 | -1) {
    setScreenDir(sd)
    const step = isRtl ? -sd : sd
    const next = (idx + step + ORDER_TYPES.length) % ORDER_TYPES.length
    setAnimateTo(ORDER_TYPES[next])
    onChange(ORDER_TYPES[next])
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY }
    moved.current = false
    setDrag(0)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    const dy = e.clientY - start.current.y
    // Пока горизонталь не преобладает — не перехватываем (даём вертикали скроллить)
    if (!moved.current && Math.abs(dx) < 10) return
    if (Math.abs(dx) <= Math.abs(dy)) return
    moved.current = true
    // Небольшое сопротивление у краёв жеста — тактильнее (клампим до ±ширины кнопки)
    setDrag(Math.max(-120, Math.min(120, dx)))
  }
  function finish(e: React.PointerEvent) {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    start.current = null
    setDrag(null)
    if (moved.current && Math.abs(dx) > SWIPE_THRESHOLD) {
      slide(dx > 0 ? 1 : -1)   // вправо → screenDir 1, влево → -1
    }
  }

  const dragging = drag !== null
  return (
    <div className="mb-2.5">
      <button
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={() => { start.current = null; setDrag(null) }}
        onClick={() => { if (!moved.current) slide(isRtl ? -1 : 1) }} // тап = следующий
        className="relative w-full h-11 rounded-xl bg-gray-100 border border-gray-300
                   overflow-hidden touch-pan-y select-none active:scale-[0.99]"
      >
        <span
          // key = value: перемонтаж (и анимация выезда) только при СМЕНЕ типа.
          // Незавершённый свайп value не меняет → span тот же, translateX
          // снимается с transition ниже (плавный откат к центру).
          key={value}
          className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-gray-900"
          style={
            dragging
              ? { transform: `translateX(${drag}px)`, opacity: 1 - Math.min(Math.abs(drag!) / 160, 0.5) }
              : justChanged
                ? { animation: `${screenDir === 1 ? 'ot-in-right' : 'ot-in-left'} 0.18s ease-out` }
                : { transform: 'translateX(0)', transition: 'transform 0.18s ease-out' }
          }
        >
          {t(lang, value)}
        </span>
      </button>
      {/* Точки — сколько вариантов и текущий */}
      <div className="flex justify-center gap-1.5 mt-1.5">
        {ORDER_TYPES.map((tp, i) => (
          <span
            key={tp}
            className={`h-1.5 rounded-full transition-all ${
              i === idx ? 'w-4 bg-gray-800' : 'w-1.5 bg-gray-300'
            }`}
          />
        ))}
      </div>
    </div>
  )
}

function ActionButton({
  icon,
  label,
  onClick,
  active = false,
  dimmed = false,
}: {
  icon: 'customItem' | 'discount' | 'customers' | 'refund' | 'cash'
  label: string
  onClick: () => void
  active?: boolean
  /** Не хватает прав: кнопка приглушена, тап объясняет почему (см. requirePerm) */
  dimmed?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 h-11 rounded-xl border text-sm font-semibold
                 transition-all whitespace-nowrap active:scale-[0.97] ${
                   active
                     ? 'border-gray-900 bg-gray-900 text-white shadow-sm'
                     : dimmed
                       ? 'border-gray-200 bg-white text-gray-400'
                       : 'border-gray-300 bg-white text-gray-900 shadow-sm hover:border-gray-400'
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
