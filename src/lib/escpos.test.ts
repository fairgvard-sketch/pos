import { afterEach, describe, expect, it } from 'vitest'
import { printCanvasWithResult } from './escpos'

afterEach(() => {
  delete window.KassaAndroid
})

describe('APK print bridge', () => {
  it('не теряет синхронный callback, пришедший до возврата printBase64', async () => {
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => ({
        getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
      }),
    } as unknown as HTMLCanvasElement

    window.KassaAndroid = {
      isAvailable: () => true,
      bridgeVersion: () => 2,
      printBase64: (_data, jobId) => {
        window.__kassaPrintResult?.(jobId!, 'success', null)
        return true
      },
    }

    await expect(printCanvasWithResult(canvas, false)).resolves.toMatchObject({
      ok: true,
      status: 'success',
    })
  })
})
