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
  itemId: string
  name: string
  variantId: string | null
  variantName: string | null
  basePrice: number // цена варианта или товара, агороты
  mods: CartMod[]
  qty: number
  notes: string
}

export type OrderType = 'here' | 'takeaway'

export function lineUnitPrice(l: CartLine): number {
  return l.basePrice + l.mods.reduce((s, m) => s + m.priceDelta, 0)
}

export function cartTotal(lines: CartLine[]): number {
  return lines.reduce((s, l) => s + lineUnitPrice(l) * l.qty, 0)
}

function makeKey() {
  return Math.random().toString(36).slice(2)
}

function sameConfig(a: CartLine, b: Omit<CartLine, 'key' | 'qty'>): boolean {
  return (
    a.itemId === b.itemId &&
    a.variantId === b.variantId &&
    a.notes === '' &&
    b.notes === '' &&
    a.mods.length === b.mods.length &&
    a.mods.every((m, i) => m.id === b.mods[i]?.id)
  )
}

interface CartState {
  lines: CartLine[]
  orderType: OrderType
  customerName: string
  addLine: (line: Omit<CartLine, 'key' | 'qty'>) => void
  updateQty: (key: string, qty: number) => void
  updateLine: (key: string, patch: Partial<Pick<CartLine, 'variantId' | 'variantName' | 'basePrice' | 'mods' | 'notes'>>) => void
  removeLine: (key: string) => void
  setOrderType: (t: OrderType) => void
  setCustomerName: (name: string) => void
  clear: () => void
}

export const useCartStore = create<CartState>((set) => ({
  lines: [],
  orderType: 'here',
  customerName: '',

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
  clear: () => set({ lines: [], customerName: '', orderType: 'here' }),
}))
