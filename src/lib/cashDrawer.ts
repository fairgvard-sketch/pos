/**
 * Денежный ящик: физическое открытие.
 *
 * Ящик подключается к принтеру (RJ-11 на Sunmi T2 mini) и открывается
 * импульсом на его порт. Путь до порта — тот же, что у печати:
 *
 *   1. мост APK v4+ — нативный openDrawer() (Sunmi API, если прошивка умеет,
 *      иначе тот же импульс уже внутри APK);
 *   2. мост APK любой версии — импульс ESC/POS через printBase64: обычное
 *      задание печати, в котором нет ни растра, ни отреза, поэтому бумага
 *      не двигается. Это позволяет открывать ящик на УЖЕ раскатанных APK
 *      (на терминале стоит 1.3) — новый APK нужен только ради нативного
 *      пути и не является условием работы функции;
 *   3. RawBT — тот же импульс через rawbt:-ссылку;
 *   4. браузер без моста и без RawBT — тихого пути нет, честно говорим.
 *
 * Импульс: ESC p m t1 t2 (0x1B 0x70). m — номер контакта (0 = pin 2,
 * 1 = pin 5), t1/t2 — длительности on/off по 2 мс. 25/250 — значения,
 * которые принимают и Sunmi, и подавляющее большинство ESC/POS-принтеров:
 * слишком короткий импульс не втягивает соленоид, слишком длинный греет
 * катушку.
 */

import {
  newPrintJobId,
  awaitPrintResult,
  installPrintResultReceiver,
  type PrintOutcome,
} from './printJobs'
import { bridgeAvailable, bridgeVersion } from './androidBridge'

/** Контакт разъёма ящика: 2 (по умолчанию) или 5 (часть кассовых боксов) */
export type DrawerPin = 2 | 5

/**
 * Сколько ждём ответ моста по заданию ящика. Открытие — мгновенная команда:
 * либо колбэк приходит за доли секунды, либо прошивка его не шлёт вовсе.
 * Печатные 15 секунд здесь означали бы «тост через 15 секунд после того,
 * как ящик уже открылся».
 */
const DRAWER_RESULT_TIMEOUT_MS = 3000

/** Как именно эта касса может открыть ящик прямо сейчас */
export type DrawerPath = 'bridge-native' | 'bridge-pulse' | 'rawbt' | 'none'

/** Версия моста, начиная с которой есть нативный openDrawer */
const BRIDGE_DRAWER_VERSION = 4

/** Импульс открытия ящика: ESC p m t1 t2 */
export function drawerPulseBytes(pin: DrawerPin = 2): Uint8Array {
  return new Uint8Array([0x1b, 0x70, pin === 5 ? 0x01 : 0x00, 0x19, 0xfa])
}

/** Тот же импульс в base64 — для моста APK и rawbt:-ссылки */
export function drawerPulseBase64(pin: DrawerPin = 2): string {
  let bin = ''
  for (const b of drawerPulseBytes(pin)) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * Каким путём эта касса откроет ящик (для настроек и честных подсказок).
 * Нестандартный контакт (5) всегда идёт импульсом: нативный вызов Sunmi
 * бьёт в штатный порт и номер контакта не принимает.
 */
export function drawerPath(allowRawbt: boolean, pin: DrawerPin = 2): DrawerPath {
  if (bridgeAvailable()) {
    const bridge = window.KassaAndroid
    const version = bridgeVersion() ?? 0
    if (pin === 2 && version >= BRIDGE_DRAWER_VERSION && typeof bridge?.openDrawer === 'function') {
      return 'bridge-native'
    }
    return 'bridge-pulse'
  }
  return allowRawbt ? 'rawbt' : 'none'
}

/** Есть ли на этой кассе путь к ящику вообще */
export function hasDrawerPath(allowRawbt: boolean): boolean {
  return drawerPath(allowRawbt) !== 'none'
}

/**
 * Открыть ящик физически. Ошибку НЕ глотаем: кассир должен узнать, что
 * ящик не открылся (иначе он будет ждать сдачу из закрытого ящика), но
 * и денежная операция из-за этого не отменяется — решение принимает
 * вызывающий по результату.
 */
export async function openDrawerPhysically(
  allowRawbt: boolean,
  pin: DrawerPin = 2,
): Promise<PrintOutcome> {
  const path = drawerPath(allowRawbt, pin)
  if (path === 'none') {
    return { ok: false, status: 'error', message: 'no-drawer-path' }
  }
  if (path === 'rawbt') {
    window.location.href = 'rawbt:base64,' + drawerPulseBase64(pin)
    return { ok: true, status: 'success', message: 'rawbt' }
  }

  const bridge = window.KassaAndroid!
  const jobId = newPrintJobId()
  // Приёмник результата регистрируем ДО синхронного вызова моста: быстрый
  // колбэк обязан найти jobId в Map (та же гонка, что у печати чека).
  installPrintResultReceiver()
  // resultAware=false СОЗНАТЕЛЬНО, в отличие от печати: подтвердить
  // физическое открытие ящика касса не может (датчика на этом пути нет),
  // а прошивки после команды ящика колбэк присылают не всегда. Явный отказ
  // моста (нет принтера, недоверенная страница, исключение) приезжает
  // колбэком и станет ошибкой; молчание считаем открытием — иначе кассир
  // видел бы «ящик не открылся» над открытым ящиком и перестал бы верить
  // предупреждениям.
  const result = awaitPrintResult(jobId, true, false, DRAWER_RESULT_TIMEOUT_MS)
  try {
    const accepted = path === 'bridge-native'
      ? bridge.openDrawer!(jobId)
      : bridge.printBase64(drawerPulseBase64(pin), jobId)
    if (!accepted) {
      // Мост шлёт настоящую причину асинхронно — даём ей дойти первой,
      // иначе синхронный generic навсегда замаскирует статус.
      setTimeout(() => window.__kassaPrintResult?.(jobId, 'error', 'not-accepted'), 500)
    }
  } catch (e) {
    window.__kassaPrintResult?.(
      jobId,
      'error',
      e instanceof Error ? e.message : 'bridge-call-failed',
    )
  }
  return result
}
