import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore } from '../../../store/deviceStore'
import { t } from '../../../lib/i18n'
import { hasSilentPrintPath } from '../../../lib/escpos'
import { printCanvasWithRetry } from '../../receipt/printFailure'
import { renderQrFlyerCanvas } from '../../receipt/printCanvas'
import { useLocationSettings } from '../useLocationSettings'
import { Group, ToggleRow } from '../ui'
import { ImageField, TextField, LinkField } from './OnlineOrdersDetail'
import { formatMoney, parseMoney } from '../../../lib/money'
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
    const makeFlyer = () => renderQrFlyerCanvas(location.receipt_business_name || location.name, qr, QR_RESERVE_CAPTION)
    const allowRawbt = printMode === 'rawbt'
    if (hasSilentPrintPath(allowRawbt)) {
      const ok = await printCanvasWithRetry(makeFlyer, allowRawbt)
      if (ok) toast.success(t(lang, 'qrPrintSent'))
      return
    }
    const flyer = makeFlyer()
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
      {enabled && <InstantBlock rsv={rsv} update={update} />}
      {enabled && <ReserveAddressBlock rsv={rsv} update={update} />}
      {enabled && <ReservePageBlock rsv={rsv} update={update} location={location} />}
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
 * Мгновенная бронь + вместимость (063). Instant-режим включает
 * live-доступность на гостевой странице и авто-подбор стола. Под ним —
 * объединение столов, длительность визита, буфер и депозит-плейсхолдер.
 * Все ключи опциональны, сервер применяет дефолты.
 */
function InstantBlock({ rsv, update }: {
  rsv: NonNullable<LocationSettings['reservations']>
  update: (patch: LocationSettings) => void
}) {
  const lang = useLangStore((s) => s.lang)
  const instant = rsv.instant === true
  const depositOn = rsv.deposit_required === true
  // Черновик суммы депозита (₪), коммит на blur → агороты
  const [depDraft, setDepDraft] = useState(
    rsv.deposit_amount ? formatMoney(rsv.deposit_amount, lang) : ''
  )

  function commitDeposit() {
    const s = depDraft.trim()
    if (s === '') { update({ reservations: { deposit_amount: 0 } }); return }
    const agorot = parseMoney(s)
    if (agorot == null || agorot < 0) {
      setDepDraft(rsv.deposit_amount ? formatMoney(rsv.deposit_amount, lang) : '')
      return
    }
    update({ reservations: { deposit_amount: agorot } })
    setDepDraft(formatMoney(agorot, lang))
  }

  return (
    <>
      <div className="border-t border-gray-100">
        <ToggleRow
          label={t(lang, 'resInstantTitle')}
          hint={t(lang, 'resInstantHint')}
          checked={instant}
          onChange={(v) => update({ reservations: { instant: v } })}
        />
      </div>

      {instant && (
        <>
          <div className="border-t border-gray-100">
            <ToggleRow
              label={t(lang, 'resCombineTitle')}
              hint={t(lang, 'resCombineHint')}
              checked={rsv.combine === true}
              onChange={(v) => update({ reservations: { combine: v } })}
            />
          </div>
          <div className="px-4 py-3 border-t border-gray-100 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1.5">{t(lang, 'resDurationTitle')}</span>
              <select
                className="input"
                value={rsv.duration_min ?? 90}
                onChange={(e) => update({ reservations: { duration_min: Number(e.target.value) } })}
              >
                {[30, 45, 60, 90, 120, 150, 180].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1.5">{t(lang, 'resBufferTitle')}</span>
              <select
                className="input"
                value={rsv.buffer_min ?? 0}
                onChange={(e) => update({ reservations: { buffer_min: Number(e.target.value) } })}
              >
                {[0, 5, 10, 15, 30].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          </div>
        </>
      )}

      <div className="border-t border-gray-100">
        <ToggleRow
          label={t(lang, 'resDepositTitle')}
          hint={t(lang, 'resDepositHint')}
          checked={depositOn}
          onChange={(v) => update({ reservations: { deposit_required: v } })}
        />
      </div>
      {depositOn && (
        <div className="px-4 py-3 border-t border-gray-100 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-semibold text-gray-500 mb-1.5">{t(lang, 'resDepositAmount')}</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder="0"
              value={depDraft}
              onChange={(e) => setDepDraft(e.target.value)}
              onBlur={commitDeposit}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-gray-500 mb-1.5">{t(lang, 'resDepositFrom')}</span>
            <select
              className="input"
              value={rsv.deposit_from_party ?? 1}
              onChange={(e) => update({ reservations: { deposit_from_party: Number(e.target.value) } })}
            >
              {[1, 2, 4, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      )}
    </>
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

/**
 * Оформление публичной страницы брони (066): своя фото-шапка (если не
 * задана — гость видит шапку онлайн-заказа, затем логотип), часы работы
 * (свободный текст в подвале) и соцссылки. Соцссылки живут в
 * settings.reservations, не переиспользуют online_orders — страницы
 * могут вести на разные аккаунты.
 */
function ReservePageBlock({ rsv, update, location }: {
  rsv: NonNullable<LocationSettings['reservations']>
  update: (patch: LocationSettings) => void
  location: Location | undefined
}) {
  const lang = useLangStore((s) => s.lang)
  // Шапка онлайн-заказа как плейсхолдер-подсказка (её увидит гость, если тут пусто)
  const fallbackHeader = location?.settings?.online_orders?.header_url ?? null
  return (
    <>
      <div className="px-4 py-3 border-t border-gray-100">
        <div className="text-sm font-semibold text-gray-900">{t(lang, 'rsvPageDesignTitle')}</div>
        <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'rsvPageDesignHint')}</p>
        <div className="space-y-3 mt-3">
          <TextField
            label={t(lang, 'onlineNameLabel')}
            hint={t(lang, 'onlineNameHint')}
            placeholder={location?.receipt_business_name || location?.name || ''}
            value={rsv.display_name ?? ''}
            onSave={(v) => update({ reservations: { display_name: v || null } })}
          />
          <ImageField
            label={t(lang, 'onlineImgHeader')}
            hint={fallbackHeader ? t(lang, 'rsvHeaderFallbackHint') : t(lang, 'onlineImgHeaderHint')}
            url={rsv.header_url ?? null}
            onChange={(v) => update({ reservations: { header_url: v } })}
          />
          <TextField
            label={t(lang, 'rsvHoursLabel')}
            hint={t(lang, 'rsvHoursSettingHint')}
            placeholder={t(lang, 'rsvHoursPlaceholder')}
            value={rsv.hours ?? ''}
            onSave={(v) => update({ reservations: { hours: v || null } })}
            multiline
            rows={4}
          />
        </div>
      </div>
      <div className="px-4 py-3 border-t border-gray-100">
        <div className="text-sm font-semibold text-gray-900">{t(lang, 'onlineSocialTitle')}</div>
        <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'rsvSocialHint')}</p>
        <div className="space-y-3 mt-3">
          <LinkField
            label="Instagram"
            placeholder="https://instagram.com/..."
            value={rsv.instagram ?? ''}
            onSave={(v) => update({ reservations: { instagram: v || null } })}
          />
          <LinkField
            label="Facebook"
            placeholder="https://facebook.com/..."
            value={rsv.facebook ?? ''}
            onSave={(v) => update({ reservations: { facebook: v || null } })}
          />
          <LinkField
            label={t(lang, 'googleReviewLabel')}
            placeholder="https://g.page/r/..."
            value={rsv.google_review ?? ''}
            onSave={(v) => update({ reservations: { google_review: v || null } })}
          />
        </div>
      </div>
    </>
  )
}
