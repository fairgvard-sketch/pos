import { describe, it, expect, afterEach, vi } from 'vitest'
import { applyOrientation, orientationSupport } from './orientation'

/** Подменить window.KassaAndroid на время теста */
function setBridge(bridge: Partial<KassaAndroidBridge> | undefined) {
  ;(window as { KassaAndroid?: Partial<KassaAndroidBridge> }).KassaAndroid = bridge
}

afterEach(() => {
  setBridge(undefined)
})

describe('orientationSupport', () => {
  it('мост v3 с setOrientation — bridge', () => {
    setBridge({ isAvailable: () => true, setOrientation: () => true })
    expect(orientationSupport()).toBe('bridge')
  })

  it('старый мост без setOrientation — не bridge (нужен новый APK)', () => {
    setBridge({ isAvailable: () => true })
    expect(orientationSupport()).not.toBe('bridge')
  })
})

describe('applyOrientation', () => {
  it('мост v3: режим уходит в setOrientation как есть', async () => {
    const spy = vi.fn().mockReturnValue(true)
    setBridge({ isAvailable: () => true, setOrientation: spy })
    expect(await applyOrientation('landscape')).toBe(true)
    expect(spy).toHaveBeenCalledWith('landscape')
  })

  it('мост вернул false (недоверенная страница) — честный false', async () => {
    setBridge({ isAvailable: () => true, setOrientation: () => false })
    expect(await applyOrientation('portrait')).toBe(false)
  })

  it('исключение моста не роняет кассу', async () => {
    setBridge({
      isAvailable: () => true,
      setOrientation: () => {
        throw new Error('boom')
      },
    })
    expect(await applyOrientation('portrait')).toBe(false)
  })

  it('без моста и без Screen Orientation lock: auto — no-op успех, lock — false', async () => {
    // jsdom: screen.orientation отсутствует → web-путь недоступен
    expect(await applyOrientation('auto')).toBe(true)
    expect(await applyOrientation('landscape')).toBe(false)
  })
})
