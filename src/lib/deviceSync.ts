import { useDeviceStore } from '../store/deviceStore'
import { registerDevice, updateDeviceSettings, getDeviceContext } from '../features/auth/api'
import { isOnline } from './offline/net'

/**
 * Синхронизация per-device настроек с БД (P5), optimistic-first.
 *
 * Источник истины для UI — localStorage (deviceStore): интерфейс меняется
 * мгновенно и работает офлайн. Запись в БД (devices.settings) идёт В ФОНЕ,
 * с дебаунсом, и терпит офлайн (ошибку глотаем — localStorage уже сохранил,
 * досинкается при следующем изменении/перезапуске онлайн).
 *
 * device_uuid — стабильный идентификатор ЭТОГО терминала (один Supabase-
 * аккаунт может работать на нескольких кассах, см. 065). Живёт в localStorage
 * отдельно от scoped-ключей — это идентичность железа, не данные аккаунта.
 */

const DEVICE_UUID_KEY = 'kassa-device-uuid'
const DEBOUNCE_MS = 1500

/** Стабильный UUID этого терминала (создаётся один раз) */
export function deviceUuid(): string {
  let id: string | null = null
  try { id = localStorage.getItem(DEVICE_UUID_KEY) } catch { /* ignore */ }
  if (!id) {
    id = crypto.randomUUID()
    try { localStorage.setItem(DEVICE_UUID_KEY, id) } catch { /* ignore */ }
  }
  return id
}

/** Поля deviceStore, которые уезжают в БД (settings jsonb) */
function settingsSnapshot(): Record<string, unknown> {
  const s = useDeviceStore.getState()
  return {
    autoLockSec: s.autoLockSec,
    lockAfterSale: s.lockAfterSale,
    paymentSound: s.paymentSound,
    printMode: s.printMode,
    autoPrintReceipt: s.autoPrintReceipt,
    receiptPrompt: s.receiptPrompt,
    printKitchenTicket: s.printKitchenTicket,
    startScreen: s.startScreen,
    orientation: s.orientation,
    tapeWidth: s.tapeWidth,
    payMethodOrder: s.payMethodOrder,
    actionOrder: s.actionOrder,
    quickAmountsMode: s.quickAmountsMode,
    quickAmountsManual: s.quickAmountsManual,
    collectTips: s.collectTips,
    tipAskBeforePayment: s.tipAskBeforePayment,
    tipPresets: s.tipPresets,
    tipAllowCustom: s.tipAllowCustom,
    tipBeforeTax: s.tipBeforeTax,
    tipRoundUp: s.tipRoundUp,
    tipSmartAmounts: s.tipSmartAmounts,
    tipSmartThreshold: s.tipSmartThreshold,
    tipSmartFixed: s.tipSmartFixed,
  }
}

let inited = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function webviewVersion(): string | null {
  const m = /Chrom(?:e|ium)\/(\d+[\d.]*)/.exec(navigator.userAgent)
  return m ? m[1] : null
}

/** Фоновая запись настроек в БД (тихая: офлайн/ошибку глотаем) */
async function pushSettings(): Promise<void> {
  if (!isOnline()) return
  const ctx = await getDeviceContext()
  if (!ctx?.orgId) return // не онбордились — нечего писать
  try {
    await updateDeviceSettings(deviceUuid(), settingsSnapshot())
  } catch {
    // localStorage уже сохранил — досинкается при следующем изменении
  }
}

function scheduleDebounce(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void pushSettings()
  }, DEBOUNCE_MS)
}

/**
 * Инициализация синка (из App). Регистрирует устройство (идемпотентно) и
 * подписывается на изменения deviceStore для фоновой записи. Optimistic-first:
 * UI уже реагирует через zustand, БД догоняет.
 */
export async function initDeviceSync(): Promise<void> {
  if (inited) return
  inited = true

  const ctx = await getDeviceContext()
  if (ctx?.orgId && isOnline()) {
    const s = useDeviceStore.getState()
    try {
      await registerDevice({
        deviceUuid: deviceUuid(),
        name: s.deviceName || null,
        settings: settingsSnapshot(),
        appVersion: __APP_VERSION__,
        webviewVersion: webviewVersion(),
      })
    } catch {
      // Регистрация не критична для работы кассы — повторится при следующем старте
    }
  }

  // Любое изменение настроек → дебаунс-запись в БД (не на каждый тап)
  useDeviceStore.subscribe(() => scheduleDebounce())
}
