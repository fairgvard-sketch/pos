/// <reference types="vite-plugin-pwa/client" />

/**
 * JS-мост APK-обёртки для Sunmi (android/ в этом репо).
 * Присутствует только когда касса открыта внутри нашего Android-приложения.
 */
interface KassaAndroidBridge {
  /** Есть ли связь со встроенным принтером Sunmi */
  isAvailable(): boolean
  /**
   * Версия контракта моста. v2+ гарантирует callback результата задания,
   * v3+ умеет setOrientation, v4+ — openDrawer.
   */
  bridgeVersion?(): number
  /**
   * Ориентация интерфейса (v3+): auto|landscape|portrait → requestedOrientation.
   * true = применено; false = недоверенная страница или неизвестный режим.
   */
  setOrientation?(mode: string): boolean
  /**
   * Печать сырых ESC/POS байтов (base64). Возвращает, ПРИНЯТО ли задание
   * (queued), НЕ результат печати. Реальный итог приходит асинхронно в
   * window.__kassaPrintResult(jobId, status, message).
   * jobId опционален для совместимости со старым мостом (без callback).
   */
  printBase64(data: string, jobId?: string): boolean
  /**
   * Открыть денежный ящик (v4+): нативный Sunmi-вызов, а если прошивка его
   * не знает — импульс ESC/POS НАПРЯМУЮ, минуя буфер печати (буфер команду
   * ящика проглатывает — полевой факт на T2). Возвращает, принято ли
   * задание; итог приходит в window.__kassaPrintResult(jobId, ...) и при
   * наличии датчика отражает ФАКТ открытия (`opened`), а не только
   * доставку команды (`sent-unverified`). На старом мосту метода нет —
   * импульс идёт через printBase64, и до порта он не доходит.
   */
  openDrawer?(jobId: string, pin?: number): boolean
}

/** Статус задания печати от моста APK */
type KassaPrintStatus = 'queued' | 'success' | 'error' | 'no-paper' | 'disconnected'

interface Window {
  KassaAndroid?: KassaAndroidBridge
  /** Колбэк результата печати от нативного моста (регистрирует printJobs.ts) */
  __kassaPrintResult?: (jobId: string, status: KassaPrintStatus, message: string | null) => void
  /** Ранний выбор manifest до загрузки React: pos | menu. */
  __ANGLE_APP_SURFACE__?: 'pos' | 'menu'
}

/** Версия приложения — из package.json через define в vite.config.ts */
declare const __APP_VERSION__: string
