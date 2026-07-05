import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Staff } from '../types'

interface AuthState {
  currentStaff: Staff | null
  setStaff: (staff: Staff | null) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      currentStaff: null,
      setStaff: (staff) => set({ currentStaff: staff }),
      logout: () => set({ currentStaff: null }),
    }),
    {
      name: 'kassa-auth',
    }
  )
)
