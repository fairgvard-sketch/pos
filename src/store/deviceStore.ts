import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PayMethodId } from '../lib/payMethods'

/**
 * Настройки КОНКРЕТНОЙ кассы (per-device) — localStorage, не БД:
 * у каждой кассы своё поведение (Square хранит так же). Синхронизация
 * per-device настроек через devices-таблицу — позже, вместе с принтером.
 */
/** Способ печати чека: браузерный диалог / RawBT (встроенный принтер Sunmi) */
export type PrintMode = 'browser' | 'rawbt'

/**
 * Способ оплаты (Square: payment types): наличные/карта + кошельки
 * Cibus/Tenbis/Bit (046). В payMethodOrder перечислены ВКЛЮЧЁННЫЕ
 * способы в порядке показа; кошельки включаются в Настройки → Оплата.
 */
export type PayMethod = PayMethodId
/** @deprecated синоним PayMethod — оставлен, чтобы не ломать импорты */
export type FirstPayMethod = PayMethod

/**
 * Быстрые суммы при оплате наличными (Square: Quick amounts):
 *  smart  — авто по сумме заказа (округления вверх до круглых банкнот)
 *  manual — свои фиксированные суммы (quickAmountsManual, до 3)
 *  off    — только «Без сдачи» (ровно к оплате)
 */
export type QuickAmountsMode = 'smart' | 'manual' | 'off'

/** Порядок кнопок ряда действий на экране продажи (перестановка long-press'ом) */
export const DEFAULT_ACTION_ORDER = ['customItem', 'discount', 'loyalty', 'refund', 'tip']

interface DeviceState {
  /** Имя этой кассы (для отчётов/шапки настроек). Пусто = не задано */
  deviceName: string
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
  /**
   * Порядок способов оплаты в окне оплаты (Square: Payment types drag-list).
   * Первый — по умолчанию выбран. Все включённые способы перечислены.
   */
  payMethodOrder: PayMethod[]
  /** Порядок кнопок ряда действий на экране продажи (long-press drag, как iOS) */
  actionOrder: string[]
  /** Режим быстрых сумм наличных (Square: Quick amounts) */
  quickAmountsMode: QuickAmountsMode
  /** Ручные быстрые суммы, агороты (для quickAmountsMode='manual', до 3) */
  quickAmountsManual: number[]
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
  /** Округление чаевых до целого шекеля итога (Square: Allow Round-up Tipping) */
  tipRoundUp: boolean
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
  setPayMethodOrder: (o: PayMethod[]) => void
  setActionOrder: (o: string[]) => void
  setQuickAmountsMode: (m: QuickAmountsMode) => void
  setQuickAmountsManual: (a: number[]) => void
  setCollectTips: (v: boolean) => void
  setTipAskBeforePayment: (v: boolean) => void
  setTipPresets: (p: number[]) => void
  setTipAllowCustom: (v: boolean) => void
  setTipBeforeTax: (v: boolean) => void
  setTipRoundUp: (v: boolean) => void
  setTipSmartAmounts: (v: boolean) => void
  setTipSmartThreshold: (v: number) => void
  setTipSmartFixed: (p: number[]) => void
  setDeviceName: (v: string) => void
}

export const useDeviceStore = create<DeviceState>()(
  persist(
    (set) => ({
      deviceName: '',
      autoLockSec: 0,
      lockAfterSale: false,
      paymentSound: true,
      printMode: 'browser',
      autoPrintReceipt: false,
      receiptPrompt: false,
      printKitchenTicket: false,
      payMethodOrder: ['cash', 'card'],
      actionOrder: DEFAULT_ACTION_ORDER,
      quickAmountsMode: 'smart',
      quickAmountsManual: [2000, 5000, 10000],  // 20/50/100 ₪
      collectTips: false,
      tipAskBeforePayment: true,
      tipPresets: [10, 12, 15],
      tipAllowCustom: true,
      tipBeforeTax: false,
      tipRoundUp: true,
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
      setPayMethodOrder: (payMethodOrder) => set({ payMethodOrder }),
      setActionOrder: (actionOrder) => set({ actionOrder }),
      setQuickAmountsMode: (quickAmountsMode) => set({ quickAmountsMode }),
      setQuickAmountsManual: (quickAmountsManual) => set({ quickAmountsManual }),
      setCollectTips: (collectTips) => set({ collectTips }),
      setTipAskBeforePayment: (tipAskBeforePayment) => set({ tipAskBeforePayment }),
      setTipPresets: (tipPresets) => set({ tipPresets }),
      setTipAllowCustom: (tipAllowCustom) => set({ tipAllowCustom }),
      setTipBeforeTax: (tipBeforeTax) => set({ tipBeforeTax }),
      setTipRoundUp: (tipRoundUp) => set({ tipRoundUp }),
      setTipSmartAmounts: (tipSmartAmounts) => set({ tipSmartAmounts }),
      setTipSmartThreshold: (tipSmartThreshold) => set({ tipSmartThreshold }),
      setTipSmartFixed: (tipSmartFixed) => set({ tipSmartFixed }),
      setDeviceName: (deviceName) => set({ deviceName }),
    }),
    { name: 'kassa-device-settings' }
  )
)
