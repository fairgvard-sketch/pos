import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLocationId, PublicApiError } from './publicApi'

const LOC_ID = 'fe2eebf0-65e3-45b4-a81f-331359d71955'

describe('resolveLocationId', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes a UUID through without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveLocationId(LOC_ID)).resolves.toBe(LOC_ID)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves a slug to the location id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => LOC_ID,
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveLocationId('bulochka')).resolves.toBe(LOC_ID)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches a resolved slug for the tab lifetime', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => LOC_ID,
    })
    vi.stubGlobal('fetch', fetchMock)

    await resolveLocationId('cached-cafe')
    await resolveLocationId('cached-cafe')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports an unknown slug as invalid_location, not as a crash', async () => {
    // RPC отдаёт null для несуществующего слага — гость должен увидеть
    // обычный экран «точка не найдена», а не белый экран от исключения.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => null,
    }))

    await expect(resolveLocationId('no-such-place')).rejects.toBeInstanceOf(PublicApiError)
  })

  it('does not accept a non-uuid answer from the resolver', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => 'not-a-uuid',
    }))

    await expect(resolveLocationId('weird')).rejects.toBeInstanceOf(PublicApiError)
  })
})
