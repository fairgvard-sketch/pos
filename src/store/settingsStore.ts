import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface CartItemActions {
  price: boolean
  discountPct: boolean
  discountAbs: boolean
  modifiers: boolean
}

export interface BusinessInfo {
  name: string
  address: string
  businessId: string
  vatRate: number
}

export type VenueType = 'restaurant' | 'retail'

interface SettingsState {
  cartItemActions: CartItemActions
  setCartItemActions: (actions: Partial<CartItemActions>) => void
  business: BusinessInfo
  setBusiness: (info: Partial<BusinessInfo>) => void
  venueType: VenueType
  setVenueType: (type: VenueType) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      cartItemActions: {
        price: true,
        discountPct: true,
        discountAbs: true,
        modifiers: true,
      },
      setCartItemActions: (actions) =>
        set((state) => ({
          cartItemActions: { ...state.cartItemActions, ...actions },
        })),
      business: {
        name: '',
        address: '',
        businessId: '',
        vatRate: 18,
      },
      setBusiness: (info) =>
        set((state) => ({
          business: { ...state.business, ...info },
        })),
      venueType: 'restaurant',
      setVenueType: (type) => set({ venueType: type }),
    }),
    { name: 'kassa-settings' }
  )
)
