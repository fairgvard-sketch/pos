import toast from 'react-hot-toast'
import { openDrawerPhysically } from '../../lib/cashDrawer'
import { deviceUuid } from '../../lib/deviceSync'
import { OfflineError, withOfflineFallback } from '../../lib/offline/net'
import { enqueueDrawerOpen } from '../../lib/offline/enqueue'
import { useDeviceStore } from '../../store/deviceStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { captureMessage } from '../../lib/telemetry'
import { t } from '../../lib/i18n'
import { logDrawerOpen, type DrawerReason } from './api'

/**
 * Открытие денежного ящика как операция кассы: импульс на ящик + запись
 * в журнал (144).
 *
 * Порядок важен: сначала ЖЕЛЕЗО, потом аудит. Кассир не должен ждать
 * сеть с деньгами в руках, а журнал доедет офлайн-очередью. Оба шага
 * независимы: не открылся ящик — запись всё равно нужна (пытались);
 * не записался журнал — ящик всё равно открыт.
 */

export interface OpenDrawerOptions {
  reason: DrawerReason
  /** Заказ, с которым связано открытие (оплата наличными, возврат) */
  orderId?: string | null
  /** Комментарий кассира (открытие без продажи) */
  note?: string | null
  /**
   * Открыть, даже если ящик в настройках не отмечен как подключённый.
   * Нужно тесту из настроек: им как раз и проверяют, что ящик подключён.
   */
  force?: boolean
  /** Показать тост при неудаче (ручные действия — да, автооткрытие — нет) */
  notifyOnFailure?: boolean
  /**
   * Дождаться записи в журнал. По умолчанию нет: в горячем потоке кассир
   * не ждёт сеть. Экран смены ставит true, чтобы обновлённый список
   * открытий не отставал на одну запись.
   */
  awaitLog?: boolean
}

/**
 * Открыть ящик и зафиксировать это. Возвращает, открылся ли ящик
 * физически (журнал на результат не влияет).
 */
export async function openDrawer(opts: OpenDrawerOptions): Promise<boolean> {
  const device = useDeviceStore.getState()
  if (!device.cashDrawerEnabled && !opts.force) return false

  const lang = useLangStore.getState().lang
  const staff = useAuthStore.getState().staff
  const openedAt = new Date().toISOString()
  const opUuid = crypto.randomUUID()

  const outcome = await openDrawerPhysically(device.printMode === 'rawbt', device.drawerPin)
  if (!outcome.ok && opts.notifyOnFailure !== false) {
    toast.error(t(lang, outcome.message === 'no-drawer-path' ? 'drawerNoPath' : 'drawerFailed'))
  }

  // Журнал: попытку фиксируем в любом случае — «пытались открыть, ящик не
  // ответил» тоже событие для разбора недостачи. Сеть не держит кассира:
  // запись уходит фоном, ошибка не отменяет уже открытый ящик.
  const logged = recordDrawerOpen({
    opUuid,
    reason: opts.reason,
    staffId: staff?.id ?? null,
    orderId: opts.orderId ?? null,
    note: opts.note ?? null,
    openedAt,
  }).catch((e: unknown) => {
    captureMessage('shift', `drawer log failed: ${e instanceof Error ? e.message : String(e)}`)
    if (opts.notifyOnFailure !== false) toast.error(t(lang, 'drawerLogFailed'))
  })
  if (opts.awaitLog) await logged

  return outcome.ok
}

/** Записать открытие: онлайн — сразу, иначе (или по таймауту) — в очередь */
async function recordDrawerOpen(args: {
  opUuid: string
  reason: DrawerReason
  staffId: string | null
  orderId: string | null
  note: string | null
  openedAt: string
}): Promise<void> {
  const params = { ...args, deviceUuid: deviceUuid() }
  try {
    // withOfflineFallback сам отдаёт OfflineError, когда сети уже нет —
    // отдельная проверка isOnline не нужна.
    await withOfflineFallback(() => logDrawerOpen(params))
  } catch (e) {
    // Таймаут/сеть — тем же uuid в очередь (log_drawer_open идемпотентен,
    // долетевшая первая попытка не задвоится). Доменную ошибку не прячем
    // в очередь: там она застряла бы навсегда.
    if (e instanceof OfflineError) {
      enqueueDrawerOpen(params)
      return
    }
    throw e
  }
}
