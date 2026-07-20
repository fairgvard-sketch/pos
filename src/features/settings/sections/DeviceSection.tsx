import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { safeUnlinkDevice, pendingOutboxCount } from '../../auth/unlink'
import { useLangStore, RUSSIAN_UI_ENABLED } from '../../../store/langStore'
import { useDeviceStore } from '../../../store/deviceStore'
import { renderTestPrintCanvas } from '../../receipt/printCanvas'
import { hasSilentPrintPath } from '../../../lib/escpos'
import { bridgeAvailable } from '../../../lib/androidBridge'
import { orientationSupport } from '../../../lib/orientation'
import { printCanvasWithRetry } from '../../receipt/printFailure'
import { syncDeviceNow, useDeviceSyncStore } from '../../../lib/deviceSync'
import { t } from '../../../lib/i18n'
import { Group, InputRow, NavRow, SegmentRow, ToggleRow } from '../ui'
import LangToggle from '../../../components/ui/LangToggle'
import type { Location } from '../../../types'

/**
 * Категория «Устройство»: имя этой кассы, безопасность (автоблокировка +
 * PIN после продажи), статус печати + тестовый оттиск, версия приложения,
 * отвязка устройства.
 */

/** Варианты автоблокировки (сек); 0 = выключена */
const AUTOLOCK_OPTIONS = [0, 30, 60, 300, 900]

function lockLabel(sec: number, lang: 'ru' | 'he'): string {
  if (sec === 0) return t(lang, 'autoLockOff')
  if (sec < 60) return `${sec} ${t(lang, 'secShort')}`
  return `${sec / 60} ${t(lang, 'minShort')}`
}

/** Мажор Chrome/Chromium из UA — версия WebView в APK, браузера иначе */
function chromeMajor(): number | null {
  const m = navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Порог «движок устарел». T2 (Android 7.1) поставляется с Chrome 52 —
 * минимальный поддерживаемый таргет (plugin-legacy); всё ниже 80 (2020)
 * помечаем: работает, но каждая фича платит налог совместимости.
 */
const WEBVIEW_FRESH_MAJOR = 80
export default function DeviceSection({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const navigate = useNavigate()
  const deviceName = useDeviceStore((s) => s.deviceName)
  const setDeviceName = useDeviceStore((s) => s.setDeviceName)
  const printMode = useDeviceStore((s) => s.printMode)
  const autoLockSec = useDeviceStore((s) => s.autoLockSec)
  const lockAfterSale = useDeviceStore((s) => s.lockAfterSale)
  const setAutoLockSec = useDeviceStore((s) => s.setAutoLockSec)
  const setLockAfterSale = useDeviceStore((s) => s.setLockAfterSale)
  // Per-device интерфейс/лента (P5)
  const startScreen = useDeviceStore((s) => s.startScreen)
  const setStartScreen = useDeviceStore((s) => s.setStartScreen)
  const orientation = useDeviceStore((s) => s.orientation)
  const setOrientation = useDeviceStore((s) => s.setOrientation)
  const tapeWidth = useDeviceStore((s) => s.tapeWidth)
  const setTapeWidth = useDeviceStore((s) => s.setTapeWidth)
  const deviceSyncStatus = useDeviceSyncStore((s) => s.status)
  const deviceSyncError = useDeviceSyncStore((s) => s.lastError)

  const [name, setName] = useState(deviceName)
  // Ресинк драфта имени при внешней смене deviceName (сравнение с прошлым
  // значением в рендере вместо setState в эффекте):
  const [prevDeviceName, setPrevDeviceName] = useState(deviceName)
  if (deviceName !== prevDeviceName) {
    setPrevDeviceName(deviceName)
    setName(deviceName)
  }

  const queryClient = useQueryClient()
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  // Число неотправленных операций фиксируем в момент открытия диалога
  const [pendingOnConfirm, setPendingOnConfirm] = useState(0)

  const engine = chromeMajor()
  const bridgeReady = bridgeAvailable()
  const printStatus = bridgeReady
    ? t(lang, 'printBridgeApk')
    : printMode === 'rawbt'
      ? t(lang, 'printModeRawbt')
      : t(lang, 'printModeBrowser')
  const syncLabel = {
    idle: t(lang, 'deviceSyncIdle'),
    pending: t(lang, 'deviceSyncPending'),
    syncing: t(lang, 'deviceSyncing'),
    synced: t(lang, 'deviceSynced'),
    error: t(lang, 'deviceSyncError'),
  }[deviceSyncStatus]

  /** Тестовый оттиск: мост APK → RawBT → браузер; иначе подсказка */
  async function testPrint() {
    const allowRawbt = printMode === 'rawbt'
    if (hasSilentPrintPath(allowRawbt)) {
      const ok = await printCanvasWithRetry(
        () => renderTestPrintCanvas(location?.receipt_business_name || location?.name || '', deviceName),
        allowRawbt,
      )
      if (ok) toast.success(t(lang, 'testPrintSent'))
      return
    }
    // Браузерный режим не умеет тихую печать — честно предупреждаем
    toast(t(lang, 'testPrintNoSilent'))
  }

  function openUnlink() {
    setPendingOnConfirm(pendingOutboxCount())
    setConfirmUnlink(true)
  }

  async function unlink() {
    // force=true: непустая очередь уже показана пользователю в диалоге,
    // он подтвердил осознанно (операции карантинятся по scope, не теряются молча)
    const res = await safeUnlinkDevice(queryClient, { force: true })
    if (!res.ok) {
      toast.error(t(lang, 'error'))
      return
    }
    navigate('/setup', { replace: true })
  }

  return (
    <div className="space-y-6">
      <Group>
        <InputRow label={t(lang, 'deviceName')} hint={t(lang, 'deviceNameHint')} device>
          <input
            className="input !w-44"
            value={name}
            placeholder={t(lang, 'deviceNamePh')}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() !== deviceName && setDeviceName(name.trim())}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </InputRow>
        {RUSSIAN_UI_ENABLED && (
          <InputRow label={t(lang, 'interfaceLanguage')} device>
            <LangToggle />
          </InputRow>
        )}
        <InputRow
          label={t(lang, 'deviceSyncStatus')}
          hint={deviceSyncError ?? undefined}
          device
        >
          <button
            type="button"
            onClick={() => void syncDeviceNow()}
            className={`min-h-11 px-3 rounded-xl text-sm font-semibold active:scale-[0.97] ${
              deviceSyncStatus === 'error'
                ? 'bg-red-50 text-red-700'
                : deviceSyncStatus === 'pending'
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-gray-100 text-gray-700'
            }`}
          >
            {syncLabel}
          </button>
        </InputRow>
      </Group>

      {/* Интерфейс/лента per-device (P5) */}
      <Group title={t(lang, 'deviceInterfaceGroup')}>
        <SegmentRow<'sell' | 'hall' | 'queue'>
          label={t(lang, 'startScreen')}
          hint={t(lang, 'startScreenHint')}
          device
          options={[
            { value: 'sell', label: t(lang, 'sell') },
            { value: 'hall', label: t(lang, 'hall') },
            { value: 'queue', label: t(lang, 'queue') },
          ]}
          value={startScreen}
          onChange={setStartScreen}
        />
        <SegmentRow<'auto' | 'landscape' | 'portrait'>
          label={t(lang, 'orientation')}
          // Честный hint: мост v3 — надёжно; браузер — по возможности; иначе
          // прямо говорим, что нужен новый APK, а не молча игнорируем выбор
          hint={t(
            lang,
            orientationSupport() === 'bridge'
              ? 'orientationHint'
              : orientationSupport() === 'web'
                ? 'orientationWebHint'
                : 'orientationUnsupported'
          )}
          device
          options={[
            { value: 'auto', label: t(lang, 'orientationAuto') },
            { value: 'landscape', label: t(lang, 'orientationLandscape') },
            { value: 'portrait', label: t(lang, 'orientationPortrait') },
          ]}
          value={orientation}
          onChange={setOrientation}
        />
        <SegmentRow<58 | 80>
          label={t(lang, 'tapeWidth')}
          hint={t(lang, 'tapeWidthHint')}
          device
          options={[
            { value: 80, label: '80 mm' },
            { value: 58, label: '58 mm' },
          ]}
          value={tapeWidth}
          onChange={setTapeWidth}
        />
      </Group>

      <Group title={t(lang, 'catSecurity')}>
        <SegmentRow<number>
          label={t(lang, 'autoLock')}
          hint={t(lang, 'autoLockHint')}
          device
          options={AUTOLOCK_OPTIONS.map((sec) => ({ value: sec, label: lockLabel(sec, lang) }))}
          value={autoLockSec}
          onChange={setAutoLockSec}
        />
        <ToggleRow
          label={t(lang, 'lockAfterSale')}
          hint={t(lang, 'lockAfterSaleHint')}
          device
          checked={lockAfterSale}
          onChange={setLockAfterSale}
        />
      </Group>

      <Group title={t(lang, 'groupPrinting')}>
        <InputRow label={t(lang, 'printBridgeStatus')}>
          <span className="text-sm text-gray-500">{printStatus}</span>
        </InputRow>
        <NavRow label={t(lang, 'testPrint')} onClick={testPrint} />
      </Group>

      <Group>
        <InputRow label={t(lang, 'appVersion')}>
          <span className="text-sm text-gray-500 tabular-nums">{__APP_VERSION__}</span>
        </InputRow>
        <InputRow
          label={t(lang, 'browserEngine')}
          hint={engine !== null && engine < WEBVIEW_FRESH_MAJOR ? t(lang, 'webviewOutdatedHint') : undefined}
        >
          <span className={`text-sm tabular-nums ${engine !== null && engine < WEBVIEW_FRESH_MAJOR ? 'text-amber-600' : 'text-gray-500'}`}>
            {engine !== null ? `Chrome ${engine}` : '—'}
          </span>
        </InputRow>
      </Group>

      <button
        onClick={openUnlink}
        className="btn-danger !rounded-2xl w-full"
      >
        {t(lang, 'signOutDevice')}
      </button>

      {confirmUnlink && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 animate-[rise-in_0.2s_ease-out]">
            <h2 className="text-lg font-black text-gray-900 mb-2">{t(lang, 'signOutDevice')}</h2>
            <p className="text-sm text-gray-500 mb-3">{t(lang, 'unlinkConfirm')}</p>
            {pendingOnConfirm > 0 && (
              <p className="text-sm font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 mb-3">
                {t(lang, 'unlinkOutboxWarn').replace('{n}', String(pendingOnConfirm))}
              </p>
            )}
            <div className="flex gap-2 mt-2">
              <button onClick={unlink} className="btn-danger flex-1 !rounded-2xl">
                {t(lang, 'signOutDevice')}
              </button>
              <button onClick={() => setConfirmUnlink(false)} className="btn-secondary">
                {t(lang, 'cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
