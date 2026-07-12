import { useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore } from '../../../store/deviceStore'
import { t, type TranslationKey } from '../../../lib/i18n'
import { printCanvasSilently } from '../../../lib/escpos'
import { renderQrFlyerCanvas } from '../../receipt/printCanvas'
import { useLocationSettings } from '../useLocationSettings'
import { Group, NavRow, ToggleRow } from '../ui'
import type { DetailId } from '../registry'
import type { Location, ServiceMode } from '../../../types'

/** Название текущего режима обслуживания — для значения на строке */
function modeLabel(mode: ServiceMode | undefined): TranslationKey {
  return mode === 'tables' ? 'modeTables' : mode === 'counter_tables' ? 'modeCounterTables' : 'modeCounter'
}

/**
 * Категория «Обслуживание»: режим точки и онлайн-заказы — каждый drill-down
 * (ServiceModeDetail / OnlineOrdersDetail). Настройки брони (053) —
 * инлайн-блоком ниже, только в режиме столов (там они осмысленны).
 */
export default function ServiceSection({
  location, openDetail,
}: { location: Location | undefined; openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const { settings } = useLocationSettings(location)
  const onlineOn = settings.online_orders?.enabled !== false
  const tablesMode = location?.service_mode === 'tables'

  return (
    <div className="space-y-6">
      <Group>
        <NavRow
          label={t(lang, 'serviceModeTitle')}
          hint={t(lang, 'serviceModeHint')}
          value={t(lang, modeLabel(location?.service_mode))}
          onClick={() => openDetail('service-mode')}
        />
        <NavRow
          label={t(lang, 'onlineOrders')}
          hint={t(lang, 'onlineSettingsToggleHint')}
          value={t(lang, onlineOn ? 'settingOn' : 'settingOff')}
          onClick={() => openDetail('online-orders')}
        />
      </Group>

      {tablesMode && <ReservationsBlock location={location} />}
    </div>
  )
}

/** Подпись на QR-флаере брони — для гостей, поэтому всегда иврит */
const QR_RESERVE_CAPTION = 'להזמנת שולחן — סרקו את הקוד'

/**
 * Бронирование столов (053): тумблер приёма (default ВЫКЛ), ссылка
 * для гостей, QR. Тумблер enforced на сервере (submit_reservation →
 * 'disabled'). Работает осмысленно только в режиме столов.
 */
function ReservationsBlock({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const printMode = useDeviceStore((s) => s.printMode)
  const { settings, update } = useLocationSettings(location)
  // Отсутствие ключа = ВЫКЛЮЧЕНО (в отличие от online_orders)
  const enabled = settings.reservations?.enabled === true
  const url = location ? `${window.location.origin}/reserve/${location.id}` : ''

  const qrRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (qrRef.current && url && enabled) {
      QRCode.toCanvas(qrRef.current, url, { width: 176, margin: 1 }).catch(() => {})
    }
  }, [url, enabled])

  async function copyLink() {
    try {
      // Chrome 52 (T2) не знает clipboard API — fallback через execCommand
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url)
      else {
        const ta = document.createElement('textarea')
        ta.value = url
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      toast.success(t(lang, 'copiedToast'))
    } catch {
      toast.error(t(lang, 'qrPrintFail'))
    }
  }

  async function printQr() {
    if (!location) return
    const qr = document.createElement('canvas')
    await QRCode.toCanvas(qr, url, { width: 400, margin: 2 })
    const flyer = renderQrFlyerCanvas(location.receipt_business_name || location.name, qr, QR_RESERVE_CAPTION)
    const ok = printCanvasSilently(flyer, printMode === 'rawbt')
    if (ok) {
      toast.success(t(lang, 'qrPrintSent'))
      return
    }
    const win = window.open('', '_blank', 'width=420,height=640')
    if (!win) return
    win.document.write(`<img src="${flyer.toDataURL('image/png')}" style="width:100%" onload="window.print()">`)
    win.document.close()
  }

  return (
    <section>
      <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2 px-1">
        {t(lang, 'reservationsTitle')}
      </h3>
      <Group>
        <ToggleRow
          label={t(lang, 'reservationsToggle')}
          hint={t(lang, 'reservationsToggleHint')}
          checked={enabled}
          onChange={(v) => update({ reservations: { enabled: v } })}
        />
        {enabled && (
          <div className="px-4 py-3 border-t border-gray-100">
            <div className="text-sm font-semibold text-gray-900">{t(lang, 'reserveLinkTitle')}</div>
            <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'reserveLinkHint')}</p>
            <div className="flex items-center gap-2 mt-3">
              <input
                readOnly
                value={url}
                dir="ltr"
                onFocus={(e) => e.target.select()}
                className="input flex-1 min-w-0 text-xs text-gray-600"
              />
              <button className="btn-secondary h-11 px-4 shrink-0" onClick={copyLink}>
                {t(lang, 'copyAction')}
              </button>
            </div>
            <div className="flex items-center gap-4 mt-4">
              <canvas ref={qrRef} className="rounded-lg border border-gray-100 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs text-gray-500">{t(lang, 'qrHint')}</p>
                <button className="btn-secondary h-11 px-4 mt-3" onClick={printQr}>
                  {t(lang, 'printQrAction')}
                </button>
              </div>
            </div>
          </div>
        )}
      </Group>
    </section>
  )
}
