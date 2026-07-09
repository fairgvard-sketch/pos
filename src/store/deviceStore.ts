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
  /** Чаевые включены на этой кассе (Square: Collect Tips) */
  collectTips: boolean
  /** Автоматический шаг чаевых перед оплатой; выкл — только кнопкой на экране продажи */
  tipAskBeforePayment: boolean
  /** Пресеты чаевых, % от базы (см. tipBeforeTax); сами чаевые НДС не облагаются */
  tipPresets: number[]
  /** Кнопка «Своя сумма» на экране чаевых (Square: Allow Custom Amounts) */
  tipAllowCustom: boolean
  /** Проценты от суммы БЕЗ НДС (Square: Calculate Tip Before Taxes); false — от итога с НДС */
  tipBeforeTax: boolean
  /** Умные суммы (Square: Smart Tip Amounts): для мелких заказов фиксированные ₪ вместо % */
  tipSmartAmounts: boolean
  /** Порог «мелкого» заказа, агороты (для умных сумм) */
  tipSmartThreshold: number
  /** Фиксированные суммы умного режима, агороты */
  tipSmartFixed: number[]
  setAutoLockSec: (sec: number) => void
  setLockAfterSale: (v: boolean) => void
  setPaymentSound: (v: boolean) => void
  setPrintMode: (m: PrintMode) => void
  setAutoPrintReceipt: (v: boolean) => void
  setReceiptPrompt: (v: boolean) => void
  setPrintKitchenTicket: (v: boolean) => void
  setFirstPayMethod: (m: FirstPayMethod) => void
  setCollectTips: (v: boolean) => void
  setTipAskBeforePayment: (v: boolean) => void
  setTipPresets: (p: number[]) => void
  setTipAllowCustom: (v: boolean) => void
  setTipBeforeTax: (v: boolean) => void
  setTipSmartAmounts: (v: boolean) => void
  setTipSmartThreshold: (v: number) => void
  setTipSmartFixed: (p: number[]) => void
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
      collectTips: false,
      tipAskBeforePayment: true,
      tipPresets: [10, 12, 15],
      tipAllowCustom: true,
      tipBeforeTax: false,
      tipSmartAmounts: false,
      tipSmartThreshold: 5000,   // до 50 ₪
      tipSmartFixed: [200, 300, 500],  // 2/3/5 ₪
      setAutoLockSec: (autoLockSec) => set({ autoLockSec }),
      setLockAfterSale: (lockAfterSale) => set({ lockAfterSale }),
      setPaymentSound: (paymentSound) => set({ paymentSound }),
      setPrintMode: (printMode) => set({ printMode }),
      setAutoPrintReceipt: (autoPrintReceipt) => set({ autoPrintReceipt }),
      setReceiptPrompt: (receiptPrompt) => set({ receiptPrompt }),
      setPrintKitchenTicket: (printKitchenTicket) => set({ printKitchenTicket }),
      setFirstPayMethod: (firstPayMethod) => set({ firstPayMethod }),
      setCollectTips: (collectTips) => set({ collectTips }),
      setTipAskBeforePayment: (tipAskBeforePayment) => set({ tipAskBeforePayment }),
      setTipPresets: (tipPresets) => set({ tipPresets }),
      setTipAllowCustom: (tipAllowCustom) => set({ tipAllowCustom }),
      setTipBeforeTax: (tipBeforeTax) => set({ tipBeforeTax }),
      setTipSmartAmounts: (tipSmartAmounts) => set({ tipSmartAmounts }),
      setTipSmartThreshold: (tipSmartThreshold) => set({ tipSmartThreshold }),
      setTipSmartFixed: (tipSmartFixed) => set({ tipSmartFixed }),
    }),
    { name: 'kassa-device-settings' }
  )
)
