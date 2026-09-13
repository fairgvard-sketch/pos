import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '../types'

let context: { orgId: string | null; locationId: string | null } | null = null
let mockScope: string | null = null
let mockUserId = 'user-1'
let mockAccessToken = 'synthetic-token-1'
let authCallback: ((event: string, session: { user: { app_metadata?: Record<string, unknown> } } | null) => void) | null = null

const registerDevice = vi.fn()
const getDeviceContext = vi.fn(async () => context)

vi.mock('../features/auth/api', () => ({
  registerDevice: (...args: unknown[]) => registerDevice(...args),
  updateDeviceSettings: vi.fn(),
  getDeviceContext: () => getDeviceContext(),
  getDeviceSyncSession: async () => {
    const ctx = await getDeviceContext()
    return ctx && { ...ctx, authUserId: mockUserId, accessToken: mockAccessToken }
  },
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
vi.mock('./offline/scope', () => ({ currentScopeKey: () => mockScope }))

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

function deferredDevice() {
  let resolve!: (value: Device) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Device>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  context = null
  mockScope = null
  mockUserId = 'user-1'
  mockAccessToken = 'synthetic-token-1'
  authCallback?.('SIGNED_OUT', null)
  registerDevice.mockReset()
  getDeviceContext.mockClear()
  useDeviceStore.setState(DEFAULT_DEVICE_PREFERENCES)
  // setState проходит через persist; эмулируем новый/очищенный scope после
  // hydration Zustand — в памяти дефолты, server key отсутствует.
  localStorage.clear()
  localStorage.setItem('kassa-device-uuid', '00000000-0000-4000-8000-000000000001')
  useDeviceSyncStore.setState({ status: 'idle', lastSyncedAt: null, lastError: null })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

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
    mockScope = 'org-1:loc-1:user-1'
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

  it('не применяет поздний server snapshot аккаунта A после перехода на B', async () => {
    vi.useFakeTimers()
    context = { orgId: 'org-1', locationId: 'loc-1' }
    mockScope = 'org-1:loc-1:user-1'
    const response = deferredDevice()
    registerDevice.mockReturnValueOnce(response.promise)
    const pending = syncDeviceNow()
    await vi.waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1))
    context = { orgId: 'org-2', locationId: 'loc-2' }
    mockUserId = 'user-2'
    mockScope = 'org-2:loc-2:user-2'
    useDeviceStore.setState({ ...DEFAULT_DEVICE_PREFERENCES, deviceName: 'B' })
    localStorage.removeItem('kassa-device-settings')
    response.resolve(serverDevice({ tapeWidth: 58, startScreen: 'queue' }))
    await pending
    expect(useDeviceStore.getState().deviceName).toBe('B')
    expect(useDeviceStore.getState().tapeWidth).toBe(80)
    expect(localStorage.getItem('kassa-device-settings')).toBeNull()
    expect(registerDevice).toHaveBeenCalledTimes(1)
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('привязывает обе записи настроек к исходному токену, не к новой сессии SDK', async () => {
    context = { orgId: 'org-1', locationId: 'loc-1' }
    mockScope = 'org-1:loc-1:user-1'
    useDeviceStore.setState({ deviceName: 'Local', tapeWidth: 58 })
    registerDevice.mockImplementation(async () => {
      mockAccessToken = 'refreshed-token'
      return serverDevice({})
    })
    await syncDeviceNow()
    expect(registerDevice).toHaveBeenCalledTimes(2)
    for (const call of registerDevice.mock.calls) expect(call[1]).toBe('synthetic-token-1')
    expect(registerDevice.mock.calls[1][0].settings.tapeWidth).toBe(58)
  })

  it.each(['org', 'location', 'user', 'device'])('не гидратирует ответ с несовпадающим %s', async field => {
    context = { orgId: 'org-1', locationId: 'loc-1' }
    mockScope = 'org-1:loc-1:user-1'
    const row = serverDevice({ tapeWidth: 58 })
    const key = { org: 'org_id', location: 'location_id', user: 'auth_user_id', device: 'device_uuid' }[field] as keyof Device
    registerDevice.mockResolvedValue({ ...row, [key]: 'another' })
    await syncDeviceNow()
    expect(useDeviceStore.getState().tapeWidth).toBe(80)
    expect(localStorage.getItem('kassa-device-settings')).toBeNull()
    expect(useDeviceSyncStore.getState().lastError).toBe('device identity mismatch')
    expect(registerDevice).toHaveBeenCalledTimes(1)
  })

  it('игнорирует поздний отказ после выхода и не ставит повтор под другой учёткой', async () => {
    context = { orgId: 'org-1', locationId: 'loc-1' }
    mockScope = 'org-1:loc-1:user-1'
    const response = deferredDevice()
    registerDevice.mockReturnValueOnce(response.promise)
    const pending = syncDeviceNow()
    await vi.waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1))
    context = null; mockScope = null
    authCallback?.('SIGNED_OUT', null)
    response.reject(new Error('old account failure'))
    await pending
    expect(useDeviceSyncStore.getState()).toMatchObject({ status: 'idle', lastError: null, lastSyncedAt: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('A → выход → A не оживляет ответ предыдущего входа', async () => {
    context = { orgId: 'org-1', locationId: 'loc-1' }
    mockScope = 'org-1:loc-1:user-1'
    const response = deferredDevice()
    registerDevice.mockReturnValueOnce(response.promise)
    const pending = syncDeviceNow()
    await vi.waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(1))
    authCallback?.('SIGNED_OUT', null)
    authCallback?.('SIGNED_IN', { user: { app_metadata: { org_id: 'org-1' } } })
    response.resolve(serverDevice({ tapeWidth: 58 }))
    await pending
    expect(localStorage.getItem('kassa-device-settings')).toBeNull()
    expect(useDeviceStore.getState().tapeWidth).toBe(80)
    expect(registerDevice).toHaveBeenCalledTimes(1)
  })

  it('ответ второй записи не ставит synced новому аккаунту', async () => {
    context = { orgId: 'org-1', locationId: 'loc-1' }
    mockScope = 'org-1:loc-1:user-1'
    useDeviceStore.setState({ deviceName: 'Local' })
    const response = deferredDevice()
    registerDevice.mockResolvedValueOnce(serverDevice({})).mockReturnValueOnce(response.promise)
    const pending = syncDeviceNow()
    await vi.waitFor(() => expect(registerDevice).toHaveBeenCalledTimes(2))
    mockScope = 'org-1:loc-1:user-2' // same point, different Auth user
    useDeviceSyncStore.setState({ status: 'idle', lastSyncedAt: null })
    response.resolve(serverDevice({}))
    await pending
    expect(useDeviceSyncStore.getState()).toMatchObject({ status: 'idle', lastSyncedAt: null })
  })
})
