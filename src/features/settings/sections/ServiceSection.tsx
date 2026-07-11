import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import { updateServiceMode } from '../../auth/api'
import { fetchTables } from '../../tables/api'
import { useLangStore } from '../../../store/langStore'
import { useDeviceStore } from '../../../store/deviceStore'
import { t, type TranslationKey } from '../../../lib/i18n'
import { printCanvasSilently } from '../../../lib/escpos'
import { renderQrFlyerCanvas } from '../../receipt/printCanvas'
import { useLocationSettings } from '../useLocationSettings'
import { Group, NavRow, ToggleRow } from '../ui'
import type { DetailId } from '../registry'
import type { Location, ServiceMode } from '../../../types'

interface ModeOption {
  mode: ServiceMode
  title: TranslationKey
  hint: TranslationKey
}

const MODES: ModeOption[] = [
  { mode: 'counter', title: 'modeCounter', hint: 'modeCounterHint' },
  { mode: 'counter_tables', title: 'modeCounterTables', hint: 'modeCounterTablesHint' },
  { mode: 'tables', title: 'modeTables', hint: 'modeTablesHint' },
]

/** Категория «Обслуживание»: режим точки + столы (drill-down в режиме столов) */
export default function ServiceSection({
  location, openDetail,
}: { location: Location | undefined; openDetail: (id: DetailId) => void }) {
  const lang = useLangStore((s) => s.lang)
  const qc = useQueryClient()

  const current = location?.service_mode
  const { data: tables = [] } = useQuery({ queryKey: ['tables'], queryFn: fetchTables })

  const save = useMutation({
    mutationFn: (mode: ServiceMode) => updateServiceMode(mode),
    // Оптимистично: подменяем режим в кеше, экраны реагируют мгновенно
    onMutate: async (mode) => {
      await qc.cancelQueries({ queryKey: ['current_location'] })
      const prev = qc.getQueryData(['current_location'])
      qc.setQueryData(['current_location'], (old: typeof location) => (old ? { ...old, service_mode: mode } : old))
      return { prev }
    },
    onError: (e, _mode, ctx) => {
      qc.setQueryData(['current_location'], ctx?.prev)
      toast.error(e.message)
    },
    onSuccess: () => toast.success(t(lang, 'saved')),
  })

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2 px-1">
          {t(lang, 'serviceModeTitle')}
        </h3>
        <p className="text-sm text-gray-500 mb-3 px-1">{t(lang, 'serviceModeHint')}</p>
        <div className="space-y-2">
          {MODES.map((m) => {
            const active = current === m.mode
            return (
              <button
                key={m.mode}
                onClick={() => !active && save.mutate(m.mode)}
                disabled={save.isPending}
                className={`w-full text-start rounded-2xl border p-4 transition-all ${
                  active
                    ? 'border-gray-900 bg-gray-900/[0.03]'
                    : 'border-gray-200 hover:border-gray-400 active:scale-[0.99]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-900">{t(lang, m.title)}</span>
                  <span
                    className={`w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                      active ? 'border-gray-900 bg-gray-900' : 'border-gray-300'
                    }`}
                  >
                    {active && <span className="w-2 h-2 rounded-full bg-white" />}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1">{t(lang, m.hint)}</p>
              </button>
            )
          })}
        </div>
      </section>

      {current === 'tables' && (
        <Group>
          <NavRow
            label={t(lang, 'tablesManage')}
            value={String(tables.length)}
            onClick={() => openDetail('tables')}
          />
        </Group>
      )}

      <OnlineOrdersBlock location={location} />
    </div>
  )
}

/** Подпись на QR-флаере — для гостей, поэтому всегда иврит */
const QR_FLYER_CAPTION = 'להזמנה אונליין — סרקו את הקוד'

/**
 * Онлайн-заказы (050/051): тумблер приёма, ссылка для гостей, QR.
 * Ссылка работает сразу — публичная страница /order/:locId мультитенантна;
 * тумблер enforced на сервере (submit_online_order → 'disabled').
 */
function OnlineOrdersBlock({ location }: { location: Location | undefined }) {
  const lang = useLangStore((s) => s.lang)
  const printMode = useDeviceStore((s) => s.printMode)
  const { settings, update } = useLocationSettings(location)
  const enabled = settings.online_orders?.enabled !== false
  const url = location ? `${window.location.origin}/order/${location.id}` : ''
  const [showPreview, setShowPreview] = useState(false)

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
    const flyer = renderQrFlyerCanvas(location.receipt_business_name || location.name, qr, QR_FLYER_CAPTION)
    const ok = printCanvasSilently(flyer, printMode === 'rawbt')
    if (ok) {
      toast.success(t(lang, 'qrPrintSent'))
      return
    }
    // Нет тихой печати (браузер на ноуте) — обычная печать страницы с QR
    const win = window.open('', '_blank', 'width=420,height=640')
    if (!win) return
    win.document.write(`<img src="${flyer.toDataURL('image/png')}" style="width:100%" onload="window.print()">`)
    win.document.close()
  }

  return (
    <section>
      <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2 px-1">
        {t(lang, 'onlineOrders')}
      </h3>
      <Group>
        <ToggleRow
          label={t(lang, 'onlineSettingsToggle')}
          hint={t(lang, 'onlineSettingsToggleHint')}
          checked={enabled}
          onChange={(v) => update({ online_orders: { enabled: v } })}
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
          {/* Живое превью страницы гостя (идея из Square: Site Preview) */}
          <div className="mt-4">
            <button className="btn-ghost h-11 px-4" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? t(lang, 'previewHide') : t(lang, 'previewShow')}
            </button>
            {showPreview && (
              <div className="mt-3 mx-auto w-[280px] h-[500px] rounded-[28px] border-4 border-gray-900 overflow-hidden shadow-lg">
                <iframe title="preview" src={url} className="w-full h-full border-0" />
              </div>
            )}
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
    </section>
  )
}

/** URL-поле с сохранением на blur; голый домен дополняется https:// */
function LinkField({ label, placeholder, value, onSave }: {
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
