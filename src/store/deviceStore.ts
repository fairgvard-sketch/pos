import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Настройки КОНКРЕТНОЙ кассы (per-device) — localStorage, не БД:
 * у каждой кассы своё поведение (Square хранит так же). Синхронизация
 * per-device настроек через devices-таблицу — позже, вместе с принтером.
 */
/** Способ печати чека: браузерный диалог / RawBT (встроенный принтер Sunmi) */
export type PrintMode = 'browser' | 'rawbt'

interface DeviceState {
  /** Автоблокировка: секунд бездействия до экрана PIN. 0 = выключена */
  autoLockSec: number
  /** Требовать PIN после каждой продажи (анти-фрод для смен с несколькими сотрудниками) */
  lockAfterSale: boolean
  /** Звук успешной оплаты */
  paymentSound: boolean
  printMode: PrintMode
  setAutoLockSec: (sec: number) => void
  setLockAfterSale: (v: boolean) => void
  setPaymentSound: (v: boolean) => void
  setPrintMode: (m: PrintMode) => void
}

export const useDeviceStore = create<DeviceState>()(
  persist(
    (set) => ({
      autoLockSec: 0,
      lockAfterSale: false,
      paymentSound: true,
      printMode: 'browser',
      setAutoLockSec: (autoLockSec) => set({ autoLockSec }),
      setLockAfterSale: (lockAfterSale) => set({ lockAfterSale }),
      setPaymentSound: (paymentSound) => set({ paymentSound }),
      setPrintMode: (printMode) => set({ printMode }),
    }),
    { name: 'kassa-device-settings' }
  )
)
