import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import { uploadItemImage } from '../../menu/api'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore } from '../../../store/deviceStore'
import { t } from '../../../lib/i18n'
import { hasSilentPrintPath } from '../../../lib/escpos'
import { printCanvasWithRetry } from '../../receipt/printFailure'
import { renderQrFlyerCanvas } from '../../receipt/printCanvas'
import { useLocationSettings } from '../useLocationSettings'
import { Group, ToggleRow } from '../ui'
import type { Location } from '../../../types'

/** Подпись на QR-флаере — для гостей, поэтому всегда иврит */
const QR_FLYER_CAPTION = 'להזמנה אונליין — סרקו את הקוד'

/**
 * Деталь «Онлайн-заказы» (050/051): тумблер приёма, ссылка для гостей, QR,
 * оформление гостевой страницы, соцссылки.
 * Ссылка работает сразу — публичная страница /order/:locId мультитенантна;
 * тумблер enforced на сервере (submit_online_order → 'disabled').
 */
export default function OnlineOrdersDetail({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const printMode = useDeviceStore((s) => s.printMode)
  const { settings, update } = useLocationSettings(location)
  const enabled = settings.online_orders?.enabled !== false
  const url = location ? `${window.location.origin}/order/${location.id}` : ''

  // Типы заказа для гостя (055). Отсутствие ключа = дефолт here+takeaway.
  const orderTypes = settings.online_orders?.order_types ?? ['here', 'takeaway']
  function toggleType(tp: 'here' | 'takeaway' | 'delivery') {
    const has = orderTypes.includes(tp)
    // Нельзя выключить последний тип — хоть один должен остаться
    if (has && orderTypes.length === 1) return
    const next = has ? orderTypes.filter((x) => x !== tp) : [...orderTypes, tp]
    // Сохраняем в каноническом порядке here → takeaway → delivery
    const order: ('here' | 'takeaway' | 'delivery')[] = ['here', 'takeaway', 'delivery']
    update({ online_orders: { order_types: order.filter((x) => next.includes(x)) } })
  }

  // QR-превью на экране
  const qrRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (qrRef.current && url) {
      QRCode.toCanvas(qrRef.current, url, { width: 176, margin: 1 }).catch(() => {})
    }
  }, [url])

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
    const makeFlyer = () => renderQrFlyerCanvas(location.receipt_business_name || location.name, qr, QR_FLYER_CAPTION)
    const allowRawbt = printMode === 'rawbt'
    if (hasSilentPrintPath(allowRawbt)) {
      const ok = await printCanvasWithRetry(makeFlyer, allowRawbt)
      if (ok) toast.success(t(lang, 'qrPrintSent'))
      return
    }
    // Нет тихой печати (браузер на ноуте) — обычная печать страницы с QR
    const flyer = makeFlyer()
    const win = window.open('', '_blank', 'width=420,height=640')
    if (!win) return
    win.document.write(`<img src="${flyer.toDataURL('image/png')}" style="width:100%" onload="window.print()">`)
    win.document.close()
  }

  return (
    <Group>
      <ToggleRow
        label={t(lang, 'onlineSettingsToggle')}
        hint={t(lang, 'onlineSettingsToggleHint')}
        checked={enabled}
        onChange={(v) => update({ online_orders: { enabled: v } })}
      />
      <div className="px-4 py-3 border-t border-gray-100">
        <div className="text-sm font-semibold text-gray-900">{t(lang, 'onlineTypesTitle')}</div>
        <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'onlineTypesHint')}</p>
      </div>
      <ToggleRow
        label={t(lang, 'onlineTypeHere')}
        checked={orderTypes.includes('here')}
        onChange={() => toggleType('here')}
      />
      <ToggleRow
        label={t(lang, 'onlineTypeTakeaway')}
        checked={orderTypes.includes('takeaway')}
        onChange={() => toggleType('takeaway')}
      />
      <ToggleRow
        label={t(lang, 'onlineTypeDelivery')}
        checked={orderTypes.includes('delivery')}
        onChange={() => toggleType('delivery')}
      />
      <div className="px-4 py-3 border-t border-gray-100">
        <div className="text-sm font-semibold text-gray-900">{t(lang, 'onlineLinkTitle')}</div>
        <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'onlineLinkHint')}</p>
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
      <div className="px-4 py-3 border-t border-gray-100">
        <div className="text-sm font-semibold text-gray-900">{t(lang, 'onlineDesignTitle')}</div>
        <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'onlineDesignHint')}</p>
        <div className="space-y-3 mt-3">
          <TextField
            label={t(lang, 'onlineNameLabel')}
            hint={t(lang, 'onlineNameHint')}
            placeholder={location?.receipt_business_name || location?.name || ''}
            value={settings.online_orders?.display_name ?? ''}
            onSave={(v) => update({ online_orders: { display_name: v || null } })}
          />
          <ImageField
            label={t(lang, 'onlineImgHeader')}
            hint={t(lang, 'onlineImgHeaderHint')}
            url={settings.online_orders?.header_url ?? null}
            onChange={(v) => update({ online_orders: { header_url: v } })}
          />
          <ImageField
            label={t(lang, 'onlineImgBg')}
            hint={t(lang, 'onlineImgBgHint')}
            url={settings.online_orders?.background_url ?? null}
            onChange={(v) => update({ online_orders: { background_url: v } })}
          />
        </div>
      </div>
      <div className="px-4 py-3 border-t border-gray-100">
        <div className="text-sm font-semibold text-gray-900">{t(lang, 'onlineSocialTitle')}</div>
        <p className="text-xs text-gray-500 mt-0.5">{t(lang, 'onlineSocialHint')}</p>
        <div className="space-y-3 mt-3">
          <LinkField
            label="Instagram"
            placeholder="https://instagram.com/..."
            value={settings.online_orders?.instagram ?? ''}
            onSave={(v) => update({ online_orders: { instagram: v || null } })}
          />
          <LinkField
            label="Facebook"
            placeholder="https://facebook.com/..."
            value={settings.online_orders?.facebook ?? ''}
            onSave={(v) => update({ online_orders: { facebook: v || null } })}
          />
          <LinkField
            label={t(lang, 'googleReviewLabel')}
            placeholder="https://g.page/r/..."
            value={settings.online_orders?.google_review ?? ''}
            onSave={(v) => update({ online_orders: { google_review: v || null } })}
          />
        </div>
      </div>
    </Group>
  )
}

/**
 * Фото оформления гостевой страницы: превью + загрузка в Storage
 * (тот же бакет и компрессия, что у фото товаров) + удаление.
 * Удаление не трогает файл в Storage — только ссылку в настройках.
 */
export function ImageField({ label, hint, url, onChange }: {
  label: string
  hint: string
  url: string | null
  onChange: (url: string | null) => void
}) {
  const lang = useLangStore((s) => s.lang)
  const fileRef = useRef<HTMLInputElement>(null)
  const upload = useMutation({
    mutationFn: (file: File) => uploadItemImage(file),
    onSuccess: (publicUrl) => onChange(publicUrl),
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <div className="flex items-center gap-3">
      {url ? (
        <img src={url} alt="" className="w-24 h-14 rounded-xl object-cover border border-gray-100 shrink-0" />
      ) : (
        <div className="w-24 h-14 rounded-xl bg-gray-100 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">{label}</div>
        <p className="text-xs text-gray-500 mt-0.5">{hint}</p>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          className="btn-secondary h-11 px-4"
          disabled={upload.isPending}
          onClick={() => fileRef.current?.click()}
        >
          {upload.isPending ? t(lang, 'loading') : t(lang, 'uploadPhoto')}
        </button>
        {url && (
          <button className="btn-ghost h-11 px-3" onClick={() => onChange(null)}>
            {t(lang, 'removeLogo')}
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) upload.mutate(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** Текстовое поле с сохранением на blur (без URL-логики) */
export function TextField({ label, hint, placeholder, value, onSave }: {
  label: string
  hint?: string
  placeholder?: string
  value: string
  onSave: (v: string) => void
}) {
  const [val, setVal] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    setVal(value)
  }
  return (
    <label className="block">
      <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">{label}</span>
      <input
        className="input text-sm"
        value={val}
        placeholder={placeholder}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          const v = val.trim()
          if (v !== val) setVal(v)
          if (v !== value) onSave(v)
        }}
      />
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </label>
  )
}

/** URL-поле с сохранением на blur; голый домен дополняется https:// */
export function LinkField({ label, placeholder, value, onSave }: {
  label: string
  placeholder: string
  value: string
  onSave: (v: string) => void
}) {
  const [val, setVal] = useState(value)
  // Сброс при смене пропа — во время рендера (без setState-в-эффекте)
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    setVal(value)
  }
  return (
    <label className="block">
      <span className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">{label}</span>
      <input
        className="input text-sm"
        dir="ltr"
        inputMode="url"
        value={val}
        placeholder={placeholder}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          const raw = val.trim()
          const v = raw && !/^https?:\/\//i.test(raw) ? `https://${raw}` : raw
          if (v !== val) setVal(v)
          if (v !== value) onSave(v)
        }}
      />
    </label>
  )
}
