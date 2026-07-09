/**
 * JS-мост APK-обёртки для Sunmi (android/ в этом репо).
 * Присутствует только когда касса открыта внутри нашего Android-приложения.
 */
interface KassaAndroidBridge {
  /** Есть ли связь со встроенным принтером Sunmi */
  isAvailable(): boolean
  /** Печать сырых ESC/POS байтов (base64). true = отправлено. */
  printBase64(data: string): boolean
}

interface Window {
  KassaAndroid?: KassaAndroidBridge
}

/** Версия приложения — из package.json через define в vite.config.ts */
declare const __APP_VERSION__: string
