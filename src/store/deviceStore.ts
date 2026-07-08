import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Настройки КОНКРЕТНОЙ кассы (per-device) — localStorage, не БД:
 * у каждой кассы своё поведение (Square хранит так же). Синхронизация
 * per-device настроек через devices-таблицу — позже, вместе с принтером.
 */
/** Способ печати чека: браузерный диалог / RawBT (встроенный принтер Sunmi) */
export type PrintMode = 'browser' | 'rawbt'

/** Какой способ оплаты идёт первым в окне оплаты (и выбран по умолчанию) */
export type FirstPayMethod = 'cash' | 'card'

interface DeviceState {
  /** Автоблокировка: секунд бездействия до экрана PIN. 0 = выключена */
  autoLockSec: number
  /** Требовать PIN после каждой продажи (анти-фрод для смен с несколькими сотрудниками) */
  lockAfterSale: boolean
  /** Звук успешной оплаты */
  paymentSound: boolean
  printMode: PrintMode
  /** Автопечать чека сразу после оплаты (тихие пути: мост APK / RawBT) */
  autoPrintReceipt: boolean
  /** Спрашивать после оплаты, как выдать чек (печать / телефон / без чека). Приоритетнее автопечати */
  receiptPrompt: boolean
  /** Печать тикета на кухню/бар при оплате и дозаказе стола */
  printKitchenTicket: boolean
  /** Порядок способов в окне оплаты: этот — первым и выбран по умолчанию */
  firstPayMethod: FirstPayMethod
  setAutoLockSec: (sec: number) => void
  setLockAfterSale: (v: boolean) => void
  setPaymentSound: (v: boolean) => void
  setPrintMode: (m: PrintMode) => void
  setAutoPrintReceipt: (v: boolean) => void
  setReceiptPrompt: (v: boolean) => void
  setPrintKitchenTicket: (v: boolean) => void
  setFirstPayMethod: (m: FirstPayMethod) => void
}

export const useDeviceStore = create<DeviceState>()(
  persist(
    (set) => ({
      autoLockSec: 0,
      lockAfterSale: false,
      paymentSound: true,
      printMode: 'browser',
      autoPrintReceipt: false,
      receiptPrompt: false,
      printKitchenTicket: false,
      firstPayMethod: 'cash',
      setAutoLockSec: (autoLockSec) => set({ autoLockSec }),
      setLockAfterSale: (lockAfterSale) => set({ lockAfterSale }),
      setPaymentSound: (paymentSound) => set({ paymentSound }),
      setPrintMode: (printMode) => set({ printMode }),
      setAutoPrintReceipt: (autoPrintReceipt) => set({ autoPrintReceipt }),
      setReceiptPrompt: (receiptPrompt) => set({ receiptPrompt }),
      setPrintKitchenTicket: (printKitchenTicket) => set({ printKitchenTicket }),
      setFirstPayMethod: (firstPayMethod) => set({ firstPayMethod }),
    }),
    { name: 'kassa-device-settings' }
  )
)
