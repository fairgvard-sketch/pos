import { afterEach, describe, expect, it, vi } from 'vitest'
import { printCanvasWithResult } from './escpos'

afterEach(() => {
  delete window.KassaAndroid
  vi.useRealTimers()
})

function fakeCanvas(): HTMLCanvasElement {
  return {
    width: 1,
    height: 1,
    getContext: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
    }),
  } as unknown as HTMLCanvasElement
}

describe('APK print bridge', () => {
  it('не теряет синхронный callback, пришедший до возврата printBase64', async () => {
    window.KassaAndroid = {
      isAvailable: () => true,
      bridgeVersion: () => 2,
      printBase64: (_data, jobId) => {
        window.__kassaPrintResult?.(jobId!, 'success', null)
        return true
      },
    }

    await expect(printCanvasWithResult(fakeCanvas(), false)).resolves.toMatchObject({
      ok: true,
      status: 'success',
    })
  })

  it('отказ моста: настоящая причина (disconnected) выигрывает у not-accepted', async () => {
    vi.useFakeTimers()
    let captured = ''
    window.KassaAndroid = {
      isAvailable: () => true,
      bridgeVersion: () => 2,
      printBase64: (_data, jobId) => {
        captured = jobId!
        return false
      },
    }

    const p = printCanvasWithResult(fakeCanvas(), false)
    // Мост доносит причину асинхронно (evaluateJavascript), но раньше 500 мс
    window.__kassaPrintResult?.(captured, 'disconnected', 'printer-disconnected')
    await expect(p).resolves.toMatchObject({ ok: false, status: 'disconnected' })
    // Опоздавший fallback уже никого не находит и ничего не ломает
    vi.advanceTimersByTime(500)
  })

  it('отказ моста без причины: через 500 мс приходит not-accepted', async () => {
    vi.useFakeTimers()
    window.KassaAndroid = {
      isAvailable: () => true,
      bridgeVersion: () => 2,
      printBase64: () => false,
    }

    const p = printCanvasWithResult(fakeCanvas(), false)
    vi.advanceTimersByTime(500)
    await expect(p).resolves.toMatchObject({
      ok: false,
      status: 'error',
      message: 'not-accepted',
    })
  })
})
