/**
 * JS-мост APK-обёртки для Sunmi (android/ в этом репо).
 * Присутствует только когда касса открыта внутри нашего Android-приложения.
 */
interface KassaAndroidBridge {
  /** Есть ли связь со встроенным принтером Sunmi */
  isAvailable(): boolean
  /**
   * Печать сырых ESC/POS байтов (base64). Возвращает, ПРИНЯТО ли задание
   * (queued), НЕ результат печати. Реальный итог приходит асинхронно в
   * window.__kassaPrintResult(jobId, status, message).
   * jobId опционален для совместимости со старым мостом (без callback).
   */
  printBase64(data: string, jobId?: string): boolean
}

/** Статус задания печати от моста APK */
type KassaPrintStatus = 'queued' | 'success' | 'error' | 'no-paper' | 'disconnected'

interface Window {
  KassaAndroid?: KassaAndroidBridge
  /** Колбэк результата печати от нативного моста (регистрирует printJobs.ts) */
  __kassaPrintResult?: (jobId: string, status: KassaPrintStatus, message: string | null) => void
}

/** Версия приложения — из package.json через define в vite.config.ts */
declare const __APP_VERSION__: string
