import { create } from 'zustand'

/**
 * Корзина кассы. Хранит снапшоты имён/цен для мгновенного рендера,
 * но при оформлении на сервер уходят только ID — цены пересчитывает
 * place_order() из каталога (клиент не источник цен).
 */
export interface CartMod {
  id: string
  name: string
  priceDelta: number
}

export interface CartLine {
  key: string
  itemId: string | null // null = свободная позиция (нет в каталоге)
  name: string
  variantId: string | null
  variantName: string | null
  basePrice: number // цена варианта или товара, агороты
  mods: CartMod[]
  qty: number
  notes: string
  // Ручная цена за 1 шт (агороты). Перебивает basePrice+моды. Для свободных
  // позиций обязательна; для каталожных — опциональная коррекция.
  priceOverride: number | null
}

export type OrderType = 'here' | 'takeaway' | 'delivery'

/** Скидка на весь заказ. value: для percent — целые %, для fixed — агороты. */
export interface CartDiscount {
  type: 'percent' | 'fixed'
  value: number
  reason: string
}

/** Гость лояльности, привязанный к заказу (снапшот для рендера) */
export interface CartGuest {
  id: string
  phone: string
  name: string | null
  stamps: number
  points: number // агороты
}

/**
 * Награда лояльности. amount — оценка вычета для показа в корзине
 * (штампы: цена бесплатной позиции; баллы: списываемые агороты).
 * Настоящую скидку считает сервер в apply_loyalty.
 */
export interface CartRedeem {
  type: 'stamps' | 'points'
  amount: number
}

export function lineUnitPrice(l: CartLine): number {
  if (l.priceOverride !== null) return l.priceOverride
  return l.basePrice + l.mods.reduce((s, m) => s + m.priceDelta, 0)
}

/** Сумма позиций до скидки */
export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((s, l) => s + lineUnitPrice(l) * l.qty, 0)
}

/**
 * Округление итога после вычета до ближайшего целого шекеля (по правилам
 * математики) — зеркало серверного round_order_total() (миграция 034).
 * Округление вверх не может увеличить итог выше суммы ДО вычета (иначе
 * скидка ушла бы в минус): результат ограничен потолком preCut.
 */
function roundTotalToShekel(total: number, preCut: number, hasCut: boolean): number {
  if (total <= 0) return 0
  if (!hasCut) return total
  return Math.min(Math.round(total / 100) * 100, preCut)
}

/** «Сырая» сумма скидки до подгонки под целый шекель, не больше подытога */
function rawDiscount(subtotal: number, d: CartDiscount | null): number {
  if (!d || d.value <= 0) return 0
  const raw = d.type === 'percent' ? Math.round((subtotal * d.value) / 100) : d.value
  return Math.min(raw, subtotal)
}

/** «Сырой» вычет лояльности до подгонки, не больше остатка после скидки */
function rawLoyalty(subtotal: number, discount: CartDiscount | null, redeem: CartRedeem | null): number {
  if (!redeem || redeem.amount <= 0) return 0
  return Math.min(redeem.amount, subtotal - rawDiscount(subtotal, discount))
}

/**
 * Сумма скидки к показу. По умолчанию «хвост» до целого шекеля забирает
 * скидка (как round_order_total на сервере при скидке без лояльности).
 * Когда к заказу есть и лояльность (redeem), «хвост» отдаётся ей —
 * тогда скидку показываем «сырой» (rounded=false), чтобы не задвоить.
 */
export function discountAmount(subtotal: number, d: CartDiscount | null, redeem: CartRedeem | null = null): number {
  const disc = rawDiscount(subtotal, d)
  if (!d || disc <= 0) return disc
  if (rawLoyalty(subtotal, d, redeem) > 0) return disc  // хвост берёт лояльность
  return subtotal - roundTotalToShekel(subtotal - disc, subtotal, true)
}

/**
 * Вычет лояльности к показу. Когда лояльность есть, «хвост» до целого
 * шекеля забирает она (сервер так же — приоритет за лояльностью), а
 * ручная скидка показывается «сырой» (discountAmount тоже отдаёт сырую,
 * когда есть лояльность), чтобы «хвост» не учитывался дважды.
 */
export function loyaltyAmount(subtotal: number, discount: CartDiscount | null, redeem: CartRedeem | null): number {
  const loy = rawLoyalty(subtotal, discount, redeem)
  if (loy <= 0) return 0
  const disc = rawDiscount(subtotal, discount)
  return subtotal - disc - roundTotalToShekel(subtotal - disc - loy, subtotal - disc, true)
}

/** Итог заказа с учётом скидки и лояльности (округлён до шекеля при вычете) */
export function cartTotal(lines: CartLine[], discount: CartDiscount | null = null, redeem: CartRedeem | null = null): number {
  const subtotal = cartSubtotal(lines)
  const disc = rawDiscount(subtotal, discount)
  const loy = rawLoyalty(subtotal, discount, redeem)
  const hasCut = disc > 0 || loy > 0
  return roundTotalToShekel(subtotal - disc - loy, subtotal, hasCut)
}

function makeKey() {
  return Math.random().toString(36).slice(2)
}

function sameConfig(a: CartLine, b: Omit<CartLine, 'key' | 'qty'>): boolean {
  // Позиции с ручной ценой или свободные никогда не схлопываются — их правят вручную
  if (a.priceOverride !== null || b.priceOverride !== null) return false
  if (a.itemId === null || b.itemId === null) return false
  return (
    a.itemId === b.itemId &&
    a.variantId === b.variantId &&
    a.notes === '' &&
    b.notes === '' &&
    a.mods.length === b.mods.length &&
    a.mods.every((m, i) => m.id === b.mods[i]?.id)
  )
}

/**
 * Контекст открытого счёта стола (режим tables). Когда задан — SellPage
 * работает как дозаказ: lines = НОВЫЕ позиции к добавлению, existingTotal —
 * то, что уже в счёте. «Оформить» → append_to_order, не place_order.
 */
export interface TableCtx {
  tableId: string
  orderId: string
  tableLabel: string
  existingTotal: number
}

interface CartState {
  lines: CartLine[]
  orderType: OrderType
  customerName: string
  tableLabel: string // подпись стола (режим counter_tables); '' = не указан
  discount: CartDiscount | null
  guest: CartGuest | null
  redeem: CartRedeem | null
  tableCtx: TableCtx | null
  addLine: (line: Omit<CartLine, 'key' | 'qty'>) => void
  updateQty: (key: string, qty: number) => void
  updateLine: (key: string, patch: Partial<Pick<CartLine, 'variantId' | 'variantName' | 'basePrice' | 'mods' | 'notes' | 'priceOverride'>>) => void
  removeLine: (key: string) => void
  setOrderType: (t: OrderType) => void
  setCustomerName: (name: string) => void
  setTableLabel: (label: string) => void
  setDiscount: (d: CartDiscount | null) => void
  setGuest: (g: CartGuest | null) => void
  setRedeem: (r: CartRedeem | null) => void
  setTableCtx: (ctx: TableCtx | null) => void
  clear: () => void
}

export const useCartStore = create<CartState>((set) => ({
  lines: [],
  orderType: 'here',
  customerName: '',
  tableLabel: '',
  discount: null,
  guest: null,
  redeem: null,
  tableCtx: null,

  // Одинаковые конфигурации схлопываются в qty — меньше строк, быстрее чтение
  addLine: (line) =>
    set((state) => {
      const existing = state.lines.find((l) => sameConfig(l, line))
      if (existing) {
        return {
          lines: state.lines.map((l) =>
            l.key === existing.key ? { ...l, qty: l.qty + 1 } : l
          ),
        }
      }
      return { lines: [...state.lines, { ...line, key: makeKey(), qty: 1 }] }
    }),

  updateQty: (key, qty) =>
    set((state) => ({
      lines:
        qty <= 0
          ? state.lines.filter((l) => l.key !== key)
          : state.lines.map((l) => (l.key === key ? { ...l, qty } : l)),
    })),

  updateLine: (key, patch) =>
    set((state) => ({
      lines: state.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    })),

  removeLine: (key) =>
    set((state) => ({ lines: state.lines.filter((l) => l.key !== key) })),

  setOrderType: (orderType) => set({ orderType }),
  setCustomerName: (customerName) => set({ customerName }),
  setTableLabel: (tableLabel) => set({ tableLabel }),
  setDiscount: (discount) => set({ discount }),
  // Смена/снятие гостя отменяет и выбранную награду — она была его
  setGuest: (guest) => set((s) => ({ guest, redeem: guest && guest.id === s.guest?.id ? s.redeem : null })),
  setRedeem: (redeem) => set({ redeem }),
  setTableCtx: (tableCtx) => set({ tableCtx }),
  clear: () => set({ lines: [], customerName: '', orderType: 'here', tableLabel: '', discount: null, guest: null, redeem: null, tableCtx: null }),
}))
