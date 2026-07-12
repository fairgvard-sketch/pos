import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore } from '../../../store/deviceStore'
import { t } from '../../../lib/i18n'
import { printCanvasSilently } from '../../../lib/escpos'
import { renderQrFlyerCanvas } from '../../receipt/printCanvas'
import { useLocationSettings } from '../useLocationSettings'
import { Group, ToggleRow } from '../ui'
import type { Location, LocationSettings } from '../../../types'

/** Подпись на QR-флаере брони — для гостей, поэтому всегда иврит */
const QR_RESERVE_CAPTION = 'להזמנת שולחן — סרקו את הקוד'

/**
 * Деталь «Бронирование столов» (053): тумблер приёма (default ВЫКЛ),
 * часы приёма, адрес, ссылка для гостей, QR. Тумблер enforced на сервере
 * (submit_reservation → 'disabled'). Осмысленно только в режиме столов —
 * строка в ServiceSection показывается лишь там.
 */
export default function ReservationsDetail({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const printMode = useDeviceStore((s) => s.printMode)
  const { settings, update } = useLocationSettings(location)
  // Отсутствие ключа = ВЫКЛЮЧЕНО (в отличие от online_orders)
  const enabled = settings.reservations?.enabled === true
  const rsv = settings.reservations ?? {}
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
    <Group>
      <ToggleRow
        label={t(lang, 'reservationsToggle')}
        hint={t(lang, 'reservationsToggleHint')}
        checked={enabled}
        onChange={(v) => update({ reservations: { enabled: v } })}
      />
      {enabled && (
        <div className="px-4 py-3 border-t border-gray-100">
          <div className="text-sm font-semibold text-gray-900">{t(lang, 'resHoursTitle')}</div>
          <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'resHoursHint')}</p>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1.5">{t(lang, 'resOpenTime')}</span>
              <input
                type="time"
                className="input"
                value={rsv.open ?? ''}
                onChange={(e) => update({ reservations: { open: e.target.value || null } })}
              />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1.5">{t(lang, 'resCloseTime')}</span>
              <input
                type="time"
                className="input"
                value={rsv.close ?? ''}
                onChange={(e) => update({ reservations: { close: e.target.value || null } })}
              />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1.5">{t(lang, 'resSlot')}</span>
              <select
                className="input"
                value={rsv.slot_min ?? 15}
                onChange={(e) => update({ reservations: { slot_min: Number(e.target.value) } })}
              >
                {[15, 30, 60].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1.5">{t(lang, 'resMaxParty')}</span>
              <select
                className="input"
                value={rsv.max_party ?? 20}
                onChange={(e) => update({ reservations: { max_party: Number(e.target.value) } })}
              >
                {[2, 4, 6, 8, 10, 12, 15, 20, 30, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}
      {enabled && <ReserveAddressBlock rsv={rsv} update={update} />}
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
  )
}

/**
 * Точный адрес заведения для гостя брони (062). Адрес — текст под
 * названием; координаты (необязательно) делают кнопку «Навигация»
 * точной (открывает пин lat,lng вместо текстового поиска). Пустой
 * адрес → гость видит адрес из реквизитов чека (обратная совместимость).
 * Координаты вводятся как «lat, lng» одной строкой и парсятся на blur.
 */
function ReserveAddressBlock({ rsv, update }: {
  rsv: NonNullable<LocationSettings['reservations']>
  update: (patch: LocationSettings) => void
}) {
  const lang = useLangStore((s) => s.lang)
  // Черновик координат: показываем как есть, коммитим на blur (парсинг «lat, lng»)
  const [coords, setCoords] = useState(
    rsv.lat != null && rsv.lng != null ? `${rsv.lat}, ${rsv.lng}` : ''
  )

  function commitCoords() {
    const s = coords.trim()
    if (s === '') {
      update({ reservations: { lat: null, lng: null } })
      return
    }
    const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
    if (!m) {
      toast.error(t(lang, 'resGeoInvalid'))
      // Откатываем черновик к сохранённому
      setCoords(rsv.lat != null && rsv.lng != null ? `${rsv.lat}, ${rsv.lng}` : '')
      return
    }
    const lat = Number(m[1])
    const lng = Number(m[2])
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      toast.error(t(lang, 'resGeoInvalid'))
      setCoords(rsv.lat != null && rsv.lng != null ? `${rsv.lat}, ${rsv.lng}` : '')
      return
    }
    update({ reservations: { lat, lng } })
  }

  return (
    <div className="px-4 py-3 border-t border-gray-100">
      <div className="text-sm font-semibold text-gray-900">{t(lang, 'resAddressTitle')}</div>
      <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'resAddressHint')}</p>
      <input
        className="input mt-3"
        placeholder={t(lang, 'resAddressPlaceholder')}
        value={rsv.address ?? ''}
        onChange={(e) => update({ reservations: { address: e.target.value || null } })}
      />
      <div className="text-xs font-semibold text-gray-500 mt-4 mb-1.5">{t(lang, 'resGeoLabel')}</div>
      <input
        className="input"
        dir="ltr"
        placeholder="32.0853, 34.7818"
        value={coords}
        onChange={(e) => setCoords(e.target.value)}
        onBlur={commitCoords}
      />
      <p className="text-xs text-gray-500 mt-1.5">{t(lang, 'resGeoHint')}</p>
    </div>
  )
}
