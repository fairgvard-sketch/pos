import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '../types'

let context: { orgId: string | null; locationId: string | null } | null = null
let authCallback: ((event: string, session: { user: { app_metadata?: Record<string, unknown> } } | null) => void) | null = null

const registerDevice = vi.fn()
const getDeviceContext = vi.fn(async () => context)

vi.mock('../features/auth/api', () => ({
  registerDevice: (...args: unknown[]) => registerDevice(...args),
  updateDeviceSettings: vi.fn(),
  getDeviceContext: () => getDeviceContext(),
}))

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn((cb) => {
        authCallback = cb
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      }),
    },
  },
}))

vi.mock('./offline/net', () => ({
  isOnline: () => true,
  useNetStore: { subscribe: vi.fn() },
}))

import {
  initDeviceSync,
  sanitizeDeviceSettings,
  syncDeviceNow,
  useDeviceSyncStore,
} from './deviceSync'
import {
  DEFAULT_DEVICE_PREFERENCES,
  useDeviceStore,
} from '../store/deviceStore'

function serverDevice(settings: Record<string, unknown>): Device {
  return {
    id: 'device-1',
    org_id: 'org-1',
    location_id: 'loc-1',
    name: 'Барная касса',
    device_uuid: '00000000-0000-4000-8000-000000000001',
    auth_user_id: 'user-1',
    settings,
    app_version: '1.1.0',
    webview_version: '120',
    printer_capabilities: null,
    registered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  }
}

beforeEach(() => {
  localStorage.clear()
  context = null
  registerDevice.mockReset()
  getDeviceContext.mockClear()
  useDeviceStore.setState(DEFAULT_DEVICE_PREFERENCES)
  // setState проходит через persist; эмулируем новый/очищенный scope после
  // hydration Zustand — в памяти дефолты, server key отсутствует.
  localStorage.clear()
  useDeviceSyncStore.setState({ status: 'idle', lastSyncedAt: null, lastError: null })
})

describe('device settings validation', () => {
  it('отбрасывает повреждённые значения и сохраняет обязательные pay methods', () => {
    const next = sanitizeDeviceSettings({
      startScreen: 'broken',
      tapeWidth: 42,
      autoLockSec: -10,
      payMethodOrder: ['bit', 'bit', 'unknown'],
    }, 'Касса 2')

    expect(next.startScreen).toBe('sell')
    expect(next.tapeWidth).toBe(80)
    expect(next.autoLockSec).toBe(0)
    expect(next.payMethodOrder).toEqual(['bit', 'cash', 'card'])
    expect(next.deviceName).toBe('Касса 2')
  })
})

describe('device sync lifecycle', () => {
  it('регистрируется после SIGNED_IN без reload и восстанавливает server snapshot', async () => {
    registerDevice.mockResolvedValue(serverDevice({ startScreen: 'queue', tapeWidth: 58 }))

    await initDeviceSync() // приложение открылось на /setup, сессии ещё нет
    expect(registerDevice).not.toHaveBeenCalled()

    context = { orgId: 'org-1', locationId: 'loc-1' }
    authCallback?.('SIGNED_IN', { user: { app_metadata: { org_id: 'org-1' } } })

    await vi.waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1))
    expect(useDeviceStore.getState().startScreen).toBe('queue')
    expect(useDeviceStore.getState().tapeWidth).toBe(58)
    expect(useDeviceStore.getState().deviceName).toBe('Барная касса')
    expect(useDeviceSyncStore.getState().status).toBe('synced')
  })

  it('переводит ошибку чтения auth context в retryable status', async () => {
    vi.useFakeTimers()
    getDeviceContext.mockRejectedValueOnce(new Error('context unavailable'))

    await expect(syncDeviceNow()).resolves.toBeUndefined()
    expect(useDeviceSyncStore.getState()).toMatchObject({
      status: 'error',
      lastError: 'context unavailable',
    })

    vi.clearAllTimers()
    vi.useRealTimers()
  })
})
