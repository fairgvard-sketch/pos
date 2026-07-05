import { create } from 'zustand'
import type { MenuItem } from '../types'

export interface CartItem {
  cartKey: string
  menu_item: MenuItem
  qty: number
  notes: string
  modifierIds: string[]
  modifierNames: string[]
  extraPrice: number
  guest: number  // 0 = unassigned, 1..N = guest number
  overridePrice: number | null  // null = use menu_item.price + extraPrice
  discountPct: number   // 0..100
  discountAbs: number   // in ₪
}

interface OrderState {
  activeTableId: string | null
  activeOrderId: string | null
  cart: CartItem[]
  guestCount: number
  setActiveTable: (tableId: string | null) => void
  setActiveOrder: (orderId: string | null) => void
  setGuestCount: (n: number) => void
  addToCart: (item: MenuItem, modifierIds?: string[], extraPrice?: number, note?: string, guest?: number, modifierNames?: string[]) => void
  removeFromCart: (cartKey: string) => void
  updateQty: (cartKey: string, qty: number) => void
  updateNotes: (cartKey: string, notes: string) => void
  updateGuest: (cartKey: string, guest: number) => void
  updateModifiers: (cartKey: string, modifierIds: string[], modifierNames: string[], extraPrice: number, notes: string) => void
  updatePrice: (cartKey: string, price: number | null) => void
  updateDiscount: (cartKey: string, pct: number, abs: number) => void
  clearCart: () => void
}

export function cartItemEffectivePrice(c: CartItem): number {
  const base = c.overridePrice ?? (c.menu_item.price + c.extraPrice)
  const afterPct = base * (1 - c.discountPct / 100)
  return Math.max(0, afterPct - c.discountAbs)
}

function makeKey() {
  return Math.random().toString(36).slice(2)
}

export const useOrderStore = create<OrderState>((set) => ({
  activeTableId: null,
  activeOrderId: null,
  cart: [],
  guestCount: 1,

  setActiveTable: (tableId) => set({ activeTableId: tableId }),
  setActiveOrder: (orderId) => set({ activeOrderId: orderId }),
  setGuestCount: (n) => set({ guestCount: n }),

  addToCart: (item, modifierIds = [], extraPrice = 0, note = '', guest = 0, modifierNames = []) =>
    set((state) => {
      // Items with modifiers, notes or guest assignment are always separate lines
      if (modifierIds.length > 0 || note || guest > 0) {
        return {
          cart: [
            ...state.cart,
            { cartKey: makeKey(), menu_item: item, qty: 1, notes: note, modifierIds, modifierNames, extraPrice, guest, overridePrice: null, discountPct: 0, discountAbs: 0 },
          ],
        }
      }
      const existing = state.cart.find(
        (c) => c.menu_item.id === item.id && c.modifierIds.length === 0 && c.guest === 0
      )
      if (existing) {
        return {
          cart: state.cart.map((c) =>
            c.cartKey === existing.cartKey ? { ...c, qty: c.qty + 1 } : c
          ),
        }
      }
      return {
        cart: [
          ...state.cart,
          { cartKey: makeKey(), menu_item: item, qty: 1, notes: '', modifierIds: [], modifierNames: [], extraPrice: 0, guest: 0, overridePrice: null, discountPct: 0, discountAbs: 0 },
        ],
      }
    }),

  removeFromCart: (cartKey) =>
    set((state) => ({ cart: state.cart.filter((c) => c.cartKey !== cartKey) })),

  updateQty: (cartKey, qty) =>
    set((state) => ({
      cart:
        qty <= 0
          ? state.cart.filter((c) => c.cartKey !== cartKey)
          : state.cart.map((c) => (c.cartKey === cartKey ? { ...c, qty } : c)),
    })),

  updateNotes: (cartKey, notes) =>
    set((state) => ({
      cart: state.cart.map((c) => (c.cartKey === cartKey ? { ...c, notes } : c)),
    })),

  updateGuest: (cartKey, guest) =>
    set((state) => ({
      cart: state.cart.map((c) => (c.cartKey === cartKey ? { ...c, guest } : c)),
    })),

  updateModifiers: (cartKey, modifierIds, modifierNames, extraPrice, notes) =>
    set((state) => ({
      cart: state.cart.map((c) =>
        c.cartKey === cartKey ? { ...c, modifierIds, modifierNames, extraPrice, notes } : c
      ),
    })),

  updatePrice: (cartKey, price) =>
    set((state) => ({
      cart: state.cart.map((c) => (c.cartKey === cartKey ? { ...c, overridePrice: price } : c)),
    })),

  updateDiscount: (cartKey, pct, abs) =>
    set((state) => ({
      cart: state.cart.map((c) => (c.cartKey === cartKey ? { ...c, discountPct: pct, discountAbs: abs } : c)),
    })),

  clearCart: () => set({ cart: [], activeTableId: null, activeOrderId: null, guestCount: 1 }),
}))
