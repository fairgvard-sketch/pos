/**
 * Безопасный доступ к мосту APK (window.KassaAndroid).
 *
 * Метод @JavascriptInterface — синхронный вызов в Java: WebView может кинуть
 * RuntimeException («Probable deadlock detected…»), если нативная сторона
 * обращается к UI-потоку, а тот занят. Инцидент 20.07: голый isAvailable()
 * ронял рендер настроек и обработчик успеха закрытия смены. Любой сбой моста
 * должен деградировать в «принтера нет», а не валить React-дерево, поэтому
 * все вызовы моста за пределами try/catch печати идут через эти обёртки.
 *
 * В телеметрию сбой уходит событием kassa:client-error (канал ErrorBoundary):
 * прямой импорт telemetry.ts создал бы цикл telemetry → androidBridge.
 */

function reportBridgeFailure(method: string, e: unknown): void {
  try {
    window.dispatchEvent(new CustomEvent('kassa:client-error', {
      detail: {
        source: 'print',
        message: `bridge ${method} threw: ${e instanceof Error ? e.message : String(e)}`,
      },
    }))
  } catch { /* телеметрия не должна ронять кассу */ }
}

/** Мост есть и рапортует связь с принтером; исключение моста = принтера нет */
export function bridgeAvailable(): boolean {
  try {
    return !!window.KassaAndroid?.isAvailable()
  } catch (e) {
    reportBridgeFailure('isAvailable', e)
    return false
  }
}

/** Версия контракта моста: null — моста нет, 1 — старый APK без bridgeVersion */
export function bridgeVersion(): number | null {
  const bridge = window.KassaAndroid
  if (!bridge) return null
  try {
    return bridge.bridgeVersion?.() ?? 1
  } catch (e) {
    reportBridgeFailure('bridgeVersion', e)
    return 1
  }
}
