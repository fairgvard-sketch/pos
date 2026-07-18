import { useDeviceStore, type Orientation } from '../store/deviceStore'

/**
 * Применение настройки «Ориентация» (Настройки → Устройство).
 * Источник истины — deviceStore (persist + серверный snapshot 065):
 * применяем на старте кассы, при смене настройки и после восстановления
 * с сервера — за счёт подписки на store, отдельного «restore» не нужно.
 *
 * Пути применения:
 *  • мост APK v3+ (setOrientation → requestedOrientation) — надёжный;
 *  • Screen Orientation API — best-effort: в обычном браузере lock()
 *    чаще всего отвергается без fullscreen, это честно сообщается в UI.
 */

export type OrientationSupport = 'bridge' | 'web' | 'none'

/** Урезанный тип: в lib.dom нет lock/unlock для ScreenOrientation */
interface LockableScreenOrientation {
  lock?: (mode: 'landscape' | 'portrait') => Promise<void>
  unlock?: () => void
}

function screenOrientation(): LockableScreenOrientation | null {
  if (typeof screen === 'undefined' || !screen.orientation) return null
  return screen.orientation as unknown as LockableScreenOrientation
}

/** Чем это устройство реально может управлять ориентацией */
export function orientationSupport(): OrientationSupport {
  const bridge = window.KassaAndroid
  if (bridge && typeof bridge.setOrientation === 'function') return 'bridge'
  if (typeof screenOrientation()?.lock === 'function') return 'web'
  return 'none'
}

// Web-путь: unlock() зовём только если сами блокировали — иначе на гостевых
// страницах и в браузере без поддержки летели бы лишние вызовы/исключения
let webLocked = false

/** Применить режим. true = принято (мостом или браузером), false = не вышло */
export async function applyOrientation(mode: Orientation): Promise<boolean> {
  const bridge = window.KassaAndroid
  if (bridge && typeof bridge.setOrientation === 'function') {
    try {
      return bridge.setOrientation(mode)
    } catch {
      return false
    }
  }
  const so = screenOrientation()
  try {
    if (mode === 'auto') {
      if (webLocked) {
        so?.unlock?.()
        webLocked = false
      }
      return true
    }
    if (!so?.lock) return false
    await so.lock(mode)
    webLocked = true
    return true
  } catch {
    return false
  }
}

/**
 * Запустить слежение: применить текущее значение и повторять при каждой
 * смене (правка в настройках, восстановление серверного snapshot).
 */
export function initOrientation(): void {
  let last: Orientation | null = null
  const apply = (mode: Orientation) => {
    if (mode === last) return
    last = mode
    void applyOrientation(mode)
  }
  apply(useDeviceStore.getState().orientation)
  useDeviceStore.subscribe((s) => apply(s.orientation))
}
