import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { signOutDevice } from '../../auth/api'
import { supabase } from '../../../lib/supabase'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore } from '../../../store/deviceStore'
import { renderTestPrintCanvas } from '../../receipt/printCanvas'
import { canvasToRawbtUrl, canvasToEscposBase64 } from '../../../lib/escpos'
import { t } from '../../../lib/i18n'
import { Group, InputRow, NavRow } from '../ui'
import type { Location } from '../../../types'

/**
 * Категория «Устройство»: имя этой кассы, аккаунт входа, статус печати +
 * тестовый оттиск, версия приложения, отвязка устройства.
 */
export default function DeviceSection({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const navigate = useNavigate()
  const deviceName = useDeviceStore((s) => s.deviceName)
  const setDeviceName = useDeviceStore((s) => s.setDeviceName)
  const printMode = useDeviceStore((s) => s.printMode)

  const [name, setName] = useState(deviceName)
  useEffect(() => setName(deviceName), [deviceName])

  const [email, setEmail] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null))
  }, [])

  const [confirmUnlink, setConfirmUnlink] = useState(false)

  const bridgeReady = typeof window !== 'undefined' && !!window.KassaAndroid?.isAvailable()
  const printStatus = bridgeReady
    ? t(lang, 'printBridgeApk')
    : printMode === 'rawbt'
      ? t(lang, 'printModeRawbt')
      : t(lang, 'printModeBrowser')

  /** Тестовый оттиск: мост APK → RawBT → браузер; иначе подсказка */
  function testPrint() {
    const canvas = renderTestPrintCanvas(location?.receipt_business_name || location?.name || '', deviceName)
    if (bridgeReady) {
      window.KassaAndroid!.printBase64(canvasToEscposBase64(canvas))
      toast.success(t(lang, 'testPrintSent'))
      return
    }
    if (printMode === 'rawbt') {
      window.location.href = canvasToRawbtUrl(canvas)
      return
    }
    // Браузерный режим не умеет тихую печать — честно предупреждаем
    toast(t(lang, 'testPrintNoSilent'))
  }

  async function unlink() {
    await signOutDevice()
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
        <InputRow label={t(lang, 'deviceAccount')}>
          <span className="text-sm text-gray-500 truncate max-w-[220px]">{email ?? '…'}</span>
        </InputRow>
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
      </Group>

      <button
        onClick={() => setConfirmUnlink(true)}
        className="btn-danger !rounded-2xl w-full"
      >
        {t(lang, 'signOutDevice')}
      </button>

      {confirmUnlink && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 animate-[rise-in_0.2s_ease-out]">
            <h2 className="text-lg font-black text-gray-900 mb-2">{t(lang, 'signOutDevice')}</h2>
            <p className="text-sm text-gray-500 mb-5">{t(lang, 'unlinkConfirm')}</p>
            <div className="flex gap-2">
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
