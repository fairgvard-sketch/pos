import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { StaffSession } from '../types'

/**
 * Два уровня авторизации:
 * 1. Устройство — сессия Supabase Auth (хранит сам supabase-js).
 * 2. Сотрудник — PIN-вход, живёт здесь. sessionStorage: закрыл
 *    вкладку/браузер → касса заблокирована, PIN заново.
 */
interface AuthState {
  staff: StaffSession | null
  setStaff: (staff: StaffSession) => void
  lock: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      staff: null,
      setStaff: (staff) => set({ staff }),
      lock: () => set({ staff: null }),
    }),
    {
      name: 'kassa-staff-session',
      storage: {
        getItem: (name) => {
          const v = sessionStorage.getItem(name)
          return v ? JSON.parse(v) : null
        },
        setItem: (name, value) => sessionStorage.setItem(name, JSON.stringify(value)),
        removeItem: (name) => sessionStorage.removeItem(name),
      },
    }
  )
)
