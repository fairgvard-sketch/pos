import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridgeAvailable, bridgeVersion } from './androidBridge'
import { hasSilentPrintPath } from './escpos'

afterEach(() => {
  delete window.KassaAndroid
  vi.restoreAllMocks()
})

/** RuntimeException WebView при вызове @JavascriptInterface (инцидент 20.07) */
const javaException = () => {
  throw new Error('Java exception was raised during method invocation')
}

describe('androidBridge: безопасный доступ к мосту APK', () => {
  it('без моста: недоступен, версия null', () => {
    expect(bridgeAvailable()).toBe(false)
    expect(bridgeVersion()).toBe(null)
  })

  it('рабочий мост: доступность и версия как есть', () => {
    window.KassaAndroid = {
      isAvailable: () => true,
      bridgeVersion: () => 3,
      printBase64: () => true,
    }
    expect(bridgeAvailable()).toBe(true)
    expect(bridgeVersion()).toBe(3)
  })

  it('старый мост без bridgeVersion: версия 1', () => {
    window.KassaAndroid = {
      isAvailable: () => false,
      printBase64: () => true,
    }
    expect(bridgeVersion()).toBe(1)
  })

  it('isAvailable кидает Java-исключение: false вместо краша, сигнал телеметрии', () => {
    const events: string[] = []
    const onError = (e: Event) =>
      events.push((e as CustomEvent<{ message?: string }>).detail?.message ?? '')
    window.addEventListener('kassa:client-error', onError)
    window.KassaAndroid = {
      isAvailable: javaException,
      printBase64: () => true,
    }

    expect(bridgeAvailable()).toBe(false)
    // Путь печати деградирует в «тихого пути нет», а не в исключение рендера
    expect(hasSilentPrintPath(false)).toBe(false)
    expect(hasSilentPrintPath(true)).toBe(true)
    expect(events.some((m) => m.includes('isAvailable'))).toBe(true)
    window.removeEventListener('kassa:client-error', onError)
  })

  it('bridgeVersion кидает: мост есть — считаем версию 1', () => {
    window.KassaAndroid = {
      isAvailable: () => true,
      bridgeVersion: javaException,
      printBase64: () => true,
    }
    expect(bridgeVersion()).toBe(1)
  })
})
