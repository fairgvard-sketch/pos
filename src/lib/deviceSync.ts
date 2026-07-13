import { create } from 'zustand'
import { supabase } from './supabase'
import {
  registerDevice,
  getDeviceContext,
} from '../features/auth/api'
import {
  DEFAULT_ACTION_ORDER,
  DEFAULT_DEVICE_PREFERENCES,
  DEVICE_SETTINGS_STORAGE_KEY,
  useDeviceStore,
  type DevicePreferences,
  type Orientation,
  type PayMethod,
  type PrintMode,
  type QuickAmountsMode,
  type StartScreen,
  type TapeWidth,
} from '../store/deviceStore'
import { isOnline, useNetStore } from './offline/net'
import type { Device } from '../types'

/**
 * Per-device sync (065): localStorage остаётся offline-first источником UI,
 * devices.settings — серверной копией для восстановления после очистки данных.
 *
 * Правила разрешения конфликта:
 *  • localStorage есть → локальный snapshot выигрывает и уезжает на сервер;
 *  • localStorage отсутствует (новый/отвязанный scope) → серверный snapshot
 *    гидратирует store; пустая серверная строка получает безопасные дефолты.
 *
 * Регистрация повторяется после SIGNED_IN и восстановления сети. Поэтому вход
 * устройства без full reload больше не оставляет devices без строки.
 */

const DEVICE_UUID_KEY = 'kassa-device-uuid'
const DEBOUNCE_MS = 1500
const RETRY_MS = 30_000

export type DeviceSyncState = 'idle' | 'pending' | 'syncing' | 'synced' | 'error'

interface SyncState {
  status: DeviceSyncState
  lastSyncedAt: string | null
  lastError: string | null
}

export const useDeviceSyncStore = create<SyncState>(() => ({
  status: 'idle',
  lastSyncedAt: null,
  lastError: null,
}))

/** Стабильный UUID физического терминала; не очищается при смене аккаунта. */
export function deviceUuid(): string {
  let id: string | null = null
  try { id = localStorage.getItem(DEVICE_UUID_KEY) } catch { /* ignore */ }
  if (!id) {
    id = crypto.randomUUID()
    try { localStorage.setItem(DEVICE_UUID_KEY, id) } catch { /* ignore */ }
  }
  return id
}

function localSnapshotExists(): boolean {
  try { return localStorage.getItem(DEVICE_SETTINGS_STORAGE_KEY) !== null } catch { return false }
}

function intArray(v: unknown, fallback: number[], max = 8): number[] {
  if (!Array.isArray(v)) return fallback
  const next = v.filter((n): n is number => Number.isSafeInteger(n) && n >= 0).slice(0, max)
  return next.length > 0 ? next : fallback
}

function percentArray(v: unknown, fallback: number[], max = 5): number[] {
  const next = intArray(v, fallback, max).filter((n) => n <= 100)
  return next.length > 0 ? next : fallback
}

function enumValue<T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? v as T : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function nonNegativeInt(v: unknown, fallback: number): number {
  return Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : fallback
}

const PAY_METHODS: readonly PayMethod[] = ['cash', 'card', 'cibus', 'tenbis', 'bit']

function payMethods(v: unknown): PayMethod[] {
  if (!Array.isArray(v)) return DEFAULT_DEVICE_PREFERENCES.payMethodOrder
  const unique = v.filter((x, i): x is PayMethod =>
    PAY_METHODS.includes(x as PayMethod) && v.indexOf(x) === i
  )
  // cash/card — базовые способы: повреждённый snapshot не может их выключить.
  for (const required of ['cash', 'card'] as const) {
    if (!unique.includes(required)) unique.push(required)
  }
  return unique
}

function actionOrder(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DEFAULT_ACTION_ORDER]
  const known = DEFAULT_ACTION_ORDER.filter((x) => v.includes(x))
  for (const x of DEFAULT_ACTION_ORDER) if (!known.includes(x)) known.push(x)
  return known
}

/** Валидировать server JSONB перед тем, как он попадёт в рабочий store. */
export function sanitizeDeviceSettings(
  raw: Record<string, unknown> | null | undefined,
  serverName = '',
): DevicePreferences {
  const r = raw ?? {}
  const d = DEFAULT_DEVICE_PREFERENCES
  return {
    deviceName: typeof serverName === 'string' && serverName !== 'Касса' ? serverName.slice(0, 80) : '',
    autoLockSec: nonNegativeInt(r.autoLockSec, d.autoLockSec),
    lockAfterSale: bool(r.lockAfterSale, d.lockAfterSale),
    paymentSound: bool(r.paymentSound, d.paymentSound),
    printMode: enumValue<PrintMode>(r.printMode, ['browser', 'rawbt'], d.printMode),
    autoPrintReceipt: bool(r.autoPrintReceipt, d.autoPrintReceipt),
    receiptPrompt: bool(r.receiptPrompt, d.receiptPrompt),
    printKitchenTicket: bool(r.printKitchenTicket, d.printKitchenTicket),
    startScreen: enumValue<StartScreen>(r.startScreen, ['sell', 'hall', 'queue'], d.startScreen),
    orientation: enumValue<Orientation>(r.orientation, ['auto', 'landscape', 'portrait'], d.orientation),
    tapeWidth: enumValue<TapeWidth>(r.tapeWidth, [58, 80], d.tapeWidth),
    payMethodOrder: payMethods(r.payMethodOrder),
    actionOrder: actionOrder(r.actionOrder),
    quickAmountsMode: enumValue<QuickAmountsMode>(r.quickAmountsMode, ['smart', 'manual', 'off'], d.quickAmountsMode),
    quickAmountsManual: intArray(r.quickAmountsManual, d.quickAmountsManual, 3),
    collectTips: bool(r.collectTips, d.collectTips),
    tipAskBeforePayment: bool(r.tipAskBeforePayment, d.tipAskBeforePayment),
    tipPresets: percentArray(r.tipPresets, d.tipPresets),
    tipAllowCustom: bool(r.tipAllowCustom, d.tipAllowCustom),
    tipBeforeTax: bool(r.tipBeforeTax, d.tipBeforeTax),
    tipRoundUp: bool(r.tipRoundUp, d.tipRoundUp),
    tipSmartAmounts: bool(r.tipSmartAmounts, d.tipSmartAmounts),
    tipSmartThreshold: nonNegativeInt(r.tipSmartThreshold, d.tipSmartThreshold),
    tipSmartFixed: intArray(r.tipSmartFixed, d.tipSmartFixed, 5),
  }
}

/** Поля store, которые синхронизируются в devices.settings. */
export function settingsSnapshot(): Record<string, unknown> {
  const { deviceName: _name, ...settings } = sanitizeDeviceSettings(
    useDeviceStore.getState() as unknown as Record<string, unknown>,
  )
  return settings
}

function webviewVersion(): string | null {
  const m = /Chrom(?:e|ium)\/(\d+[\d.]*)/.exec(navigator.userAgent)
  return m ? m[1] : null
}

let inited = false
let syncing = false
let syncAgain = false
let suppressStorePush = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

function setStatus(status: DeviceSyncState, error: string | null = null): void {
  useDeviceSyncStore.setState({ status, lastError: error })
}

function applyRemote(row: Device): void {
  const next = sanitizeDeviceSettings(row.settings, row.name)
  suppressStorePush = true
  useDeviceStore.setState(next)
  suppressStorePush = false
}

function scheduleRetry(): void {
  if (retryTimer !== null) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void syncDeviceNow()
  }, RETRY_MS)
}

/** Зарегистрировать, восстановить или отправить настройки текущего устройства. */
export async function syncDeviceNow(): Promise<void> {
  if (syncing) {
    syncAgain = true
    return
  }
  if (!isOnline()) {
    setStatus('pending')
    return
  }

  syncing = true
  setStatus('syncing')
  try {
    const ctx = await getDeviceContext()
    if (!ctx?.orgId) {
      setStatus('idle')
      return
    }

    const hasLocal = localSnapshotExists()
    const local = useDeviceStore.getState()
    // Первый вызов только гарантирует строку и возвращает server snapshot.
    // При отсутствии localStorage не передаём stale in-memory значения прошлого scope.
    const row = await registerDevice({
      deviceUuid: deviceUuid(),
      name: hasLocal ? local.deviceName || null : null,
      settings: null,
      appVersion: __APP_VERSION__,
      webviewVersion: webviewVersion(),
    })

    const remoteHasSettings = row.settings && Object.keys(row.settings).length > 0
    if (!hasLocal && remoteHasSettings) {
      applyRemote(row)
    } else {
      if (!hasLocal) {
        // scope.ts мог очистить storage после hydration Zustand; не переносим
        // старые in-memory настройки в новую организацию.
        applyRemote({ ...row, name: 'Касса', settings: {} })
      }
      const s = useDeviceStore.getState()
      await registerDevice({
        deviceUuid: deviceUuid(),
        name: s.deviceName || null,
        settings: settingsSnapshot(),
        appVersion: __APP_VERSION__,
        webviewVersion: webviewVersion(),
      })
    }

    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    useDeviceSyncStore.setState({
      status: 'synced',
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    setStatus('error', message)
    scheduleRetry()
  } finally {
    syncing = false
    if (syncAgain) {
      syncAgain = false
      void syncDeviceNow()
    }
  }
}

function schedulePush(): void {
  if (suppressStorePush) return
  setStatus('pending')
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void syncDeviceNow()
  }, DEBOUNCE_MS)
}

/** Подключить auth/network/store-сигналы и выполнить первичную синхронизацию. */
export async function initDeviceSync(): Promise<void> {
  if (inited) return
  inited = true

  useDeviceStore.subscribe(() => schedulePush())
  useNetStore.subscribe((s, prev) => {
    if (s.online && !prev.online) void syncDeviceNow()
    if (!s.online && prev.online) setStatus('pending')
  })
  supabase.auth.onAuthStateChange((_event, session) => {
    // Не await внутри auth callback: Supabase может держать auth lock.
    if (session?.user.app_metadata?.org_id) {
      setTimeout(() => void syncDeviceNow(), 0)
    } else {
      setStatus('idle')
    }
  })

  await syncDeviceNow()
}
