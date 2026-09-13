import { beforeEach, describe, expect, it, vi } from 'vitest'
const { rpc, setHeader, getSession } = vi.hoisted(() => ({ rpc: vi.fn(), setHeader: vi.fn(), getSession: vi.fn() }))
vi.mock('../../lib/supabase', () => ({ supabase: { rpc, auth: { getSession } } }))
vi.mock('../../store/authStore', () => ({ currentStaffToken: () => null }))
import { getDeviceSyncSession, registerDevice } from './api'

beforeEach(() => {
  vi.clearAllMocks()
  rpc.mockReturnValue({ setHeader })
  setHeader.mockResolvedValue({ data: { id: 'own-device' }, error: null })
})
describe('device registration authorization', () => {
  it('pins Authorization explicitly and keeps the token out of RPC parameters', async () => {
    await expect(registerDevice({ deviceUuid: 'device-key' }, 'synthetic-a')).resolves.toEqual({ id: 'own-device' })
    expect(setHeader).toHaveBeenCalledExactlyOnceWith('Authorization', 'Bearer synthetic-a')
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('synthetic-a')
    expect(rpc.mock.calls[0][0]).toBe('register_device')
  })
  it('does not fall back to the SDK current session when snapshot token is missing', async () => {
    await expect(registerDevice({ deviceUuid: 'device-key' }, '')).rejects.toThrow('device sync session required')
    expect(rpc).not.toHaveBeenCalled()
  })
  it('propagates server identity conflicts without retrying another UUID or account', async () => {
    setHeader.mockResolvedValue({ data: null, error: { message: 'device_identity_conflict' } })
    await expect(registerDevice({ deviceUuid: 'device-key' }, 'synthetic-a')).rejects.toThrow('device_identity_conflict')
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('takes tenant, user and token from one session snapshot', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'synthetic-a', user: {
      id: 'user-a', app_metadata: { org_id: 'org-a', location_id: 'loc-a' },
    } } }, error: null })
    expect(await getDeviceSyncSession()).toEqual({ orgId: 'org-a', locationId: 'loc-a', authUserId: 'user-a', accessToken: 'synthetic-a' })
    expect(getSession).toHaveBeenCalledTimes(1)
  })
})
