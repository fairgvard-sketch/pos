import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  drawerPath,
  drawerPulseBase64,
  drawerPulseBytes,
  hasDrawerPath,
  openDrawerPhysically,
} from './cashDrawer'

/** Подменить window.KassaAndroid на время теста */
function setBridge(bridge: Partial<KassaAndroidBridge> | undefined) {
  ;(window as { KassaAndroid?: Partial<KassaAndroidBridge> }).KassaAndroid = bridge
}

afterEach(() => {
  setBridge(undefined)
  vi.restoreAllMocks()
})

describe('drawerPulseBytes', () => {
  it('ESC p 0 25 250 — импульс на контакт 2', () => {
    expect(Array.from(drawerPulseBytes())).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa])
  })

  it('контакт 5 меняет только режим m', () => {
    expect(Array.from(drawerPulseBytes(5))).toEqual([0x1b, 0x70, 0x01, 0x19, 0xfa])
  })

  it('в импульсе нет ни растра, ни отреза — бумага не двигается', () => {
    const bytes = Array.from(drawerPulseBytes())
    expect(bytes).not.toContain(0x76) // GS v 0 — растр
    expect(bytes).not.toContain(0x56) // GS V — отрез
    expect(bytes.length).toBe(5)
  })

  it('base64 декодируется в те же байты', () => {
    const decoded = Array.from(atob(drawerPulseBase64()), (c) => c.charCodeAt(0))
    expect(decoded).toEqual(Array.from(drawerPulseBytes()))
  })
})

describe('drawerPath', () => {
  it('мост v4 с openDrawer — нативный путь', () => {
    setBridge({ isAvailable: () => true, bridgeVersion: () => 4, openDrawer: () => true })
    expect(drawerPath(false)).toBe('bridge-native')
  })

  it('старый мост (v3, без openDrawer) — импульс через печать, новый APK не нужен', () => {
    setBridge({ isAvailable: () => true, bridgeVersion: () => 3, printBase64: () => true })
    expect(drawerPath(false)).toBe('bridge-pulse')
  })

  it('мост v4 без метода (APK старше объявленной версии) — всё равно импульс', () => {
    setBridge({ isAvailable: () => true, bridgeVersion: () => 4, printBase64: () => true })
    expect(drawerPath(false)).toBe('bridge-pulse')
  })

  it('контакт 5 тоже идёт нативным путём — импульс шлёт сам APK, минуя буфер печати', () => {
    setBridge({ isAvailable: () => true, bridgeVersion: () => 4, openDrawer: () => true })
    expect(drawerPath(false, 5)).toBe('bridge-native')
  })

  it('без моста: RawBT включён — rawbt, выключен — пути нет', () => {
    expect(drawerPath(true)).toBe('rawbt')
    expect(drawerPath(false)).toBe('none')
    expect(hasDrawerPath(false)).toBe(false)
  })

  it('исключение моста деградирует в «пути нет», а не в падение', () => {
    setBridge({
      isAvailable: () => {
        throw new Error('deadlock')
      },
    })
    expect(drawerPath(false)).toBe('none')
  })
})

describe('openDrawerPhysically', () => {
  it('нативный путь зовёт openDrawer с jobId и контактом', async () => {
    const openDrawer = vi.fn((jobId: string) => {
      window.__kassaPrintResult?.(jobId, 'success', 'opened')
      return true
    })
    setBridge({ isAvailable: () => true, bridgeVersion: () => 4, openDrawer })
    const res = await openDrawerPhysically(false, 5)
    expect(res.ok).toBe(true)
    // 'opened' = подтверждено датчиком ящика, а не просто «команда принята»
    expect(res.message).toBe('opened')
    expect(openDrawer).toHaveBeenCalledWith(expect.any(String), 5)
  })

  it('датчик сказал «закрыт» — это ошибка, а не зелёный тост', async () => {
    setBridge({
      isAvailable: () => true,
      bridgeVersion: () => 4,
      openDrawer: (jobId: string) => {
        window.__kassaPrintResult?.(jobId, 'error', 'drawer-did-not-open')
        return true
      },
    })
    const res = await openDrawerPhysically(false)
    expect(res.ok).toBe(false)
    expect(res.message).toBe('drawer-did-not-open')
  })

  it('без нативного метода уходит импульс через printBase64', async () => {
    const printBase64 = vi.fn((data: string, jobId?: string) => {
      expect(data).toBe(drawerPulseBase64())
      window.__kassaPrintResult?.(jobId!, 'success', null)
      return true
    })
    setBridge({ isAvailable: () => true, bridgeVersion: () => 3, printBase64 })
    const res = await openDrawerPhysically(false)
    expect(res.ok).toBe(true)
    expect(printBase64).toHaveBeenCalledTimes(1)
  })

  it('исключение моста → честная ошибка, а не выброс наружу', async () => {
    setBridge({
      isAvailable: () => true,
      bridgeVersion: () => 4,
      openDrawer: () => {
        throw new Error('bridge boom')
      },
    })
    const res = await openDrawerPhysically(false)
    expect(res.ok).toBe(false)
    expect(res.message).toBe('bridge boom')
  })

  it('нет ни моста, ни RawBT — ошибка no-drawer-path без побочных эффектов', async () => {
    const res = await openDrawerPhysically(false)
    expect(res).toEqual({ ok: false, status: 'error', message: 'no-drawer-path' })
  })
})
