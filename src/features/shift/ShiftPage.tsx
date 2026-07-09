import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCurrentShift, fetchShiftReport, closeShift, type CloseResult } from './api'
import { fetchOnShiftStaff, clockOutStaff } from '../timesheet/api'
import { fetchCurrentLocation } from '../auth/api'
import { useCloseReminder } from './reminder'
import { renderZReportCanvas, type ZReportData } from '../receipt/printCanvas'
import { canvasToRawbtUrl, canvasToEscposBase64, printCanvasSilently } from '../../lib/escpos'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t } from '../../lib/i18n'
import { can } from '../../lib/perms'
import { formatMoney, parseMoney } from '../../lib/money'
import AppSidebar from '../../components/AppSidebar'
import type { Location } from '../../types'

/** Данные печатного דו"ח Z из результата close_shift (поля 037 с фолбэками) */
function toZReportData(res: CloseResult, openedAt: string | undefined, staffName: string | null, note: string): ZReportData {
  return {
    zNumber: res.z_number ?? null,
    openedAt: res.opened_at ?? openedAt ?? null,
    closedAt: res.closed_at ?? new Date().toISOString(),
    staffName,
    ordersCount: res.orders_count,
    grossCash: res.gross_cash ?? res.cash_sales,
    grossCard: res.gross_card ?? res.card_sales,
    refundsTotal: res.refunds_total ?? 0,
    netTotal: res.total_sales,
    vatTotal: res.vat_total ?? null,
    tipsTotal: res.tips_total,
    openingFloat: res.opening_float ?? null,
    expectedCash: res.expected_cash,
    countedCash: res.counted_cash,
    cashDiff: res.cash_diff,
    note: note || null,
  }
}

export default function ShiftPage() {
  const navigate = useNavigate()
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const { data: shift } = useQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
  const { data: report } = useQuery({
    queryKey: ['shift_report', shift?.id],
    queryFn: () => fetchShiftReport(shift!.id),
    enabled: !!shift,
    refetchInterval: 15_000,
  })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })

  // Настройки точки: право закрытия, напоминание, порог наличных
  const canCloseShift = can(staff?.role, 'close_shift', location?.settings)
  const remindClose = useCloseReminder(shift?.opened_at, location?.settings?.shift?.close_reminder)
  const cashWarnAt = location?.settings?.shift?.cash_warn_threshold ?? null
  const tooMuchCash = report != null && cashWarnAt != null && cashWarnAt > 0 && report.expected_cash > cashWarnAt

  const [closing, setClosing] = useState(false)
  const [countedStr, setCountedStr] = useState('')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<CloseResult | null>(null)
  // Данные печатного Z-отчёта — снимаются в момент закрытия (после
  // закрытия current_shift обнуляется, opened_at оттуда уже не взять)
  const [zData, setZData] = useState<ZReportData | null>(null)
  const printMode = useDeviceStore((s) => s.printMode)
  // Диалог подтверждения закрытия (заменяет window.confirm — тот не работает
  // в APK-обёртке Sunmi). Внутри — проверка, кто на смене в табеле.
  const [confirmOpen, setConfirmOpen] = useState(false)

  const close = useMutation({
    mutationFn: async (staffToClockOut: string[]) => {
      const counted = parseMoney(countedStr || '0')
      if (counted === null) throw new Error(t(lang, 'countedCash'))
      // Сначала снимаем выбранных сотрудников с табеля, затем закрываем смену
      for (const id of staffToClockOut) {
        await clockOutStaff(id).catch(() => {})
      }
      return closeShift(shift!.id, staff!.id, counted, note)
    },
    onSuccess: (res) => {
      const z = toZReportData(res, shift?.opened_at, staff?.name ?? null, note)
      setResult(res)
      setZData(z)
      setClosing(false)
      setConfirmOpen(false)
      // דו"ח Z печатается при закрытии автоматически (тихие пути:
      // мост APK / RawBT); в браузерном режиме — кнопкой на экране итога
      printCanvasSilently(renderZReportCanvas(z, location), printMode === 'rawbt')
      qc.invalidateQueries({ queryKey: ['current_shift'] })
      qc.invalidateQueries({ queryKey: ['timesheet'] })
    },
    onError: (e) =>
      toast.error(
        e.message.includes('open orders') ? t(lang, 'closeShiftOpenOrders') : e.message
      ),
  })

  // Нажали «Закрыть смену» в форме → открываем диалог (сам подтянет табель)
  function requestClose() {
    if (!countedStr.trim()) return
    setConfirmOpen(true)
  }

  if (!staff) return null

  // Печать דו"ח Z с экрана итога: мост APK → RawBT → браузерный диалог
  function printZ() {
    if (!zData) return
    const bridge = window.KassaAndroid
    if (bridge?.isAvailable()) {
      bridge.printBase64(canvasToEscposBase64(renderZReportCanvas(zData, location)))
      return
    }
    if (printMode === 'rawbt') {
      window.location.href = canvasToRawbtUrl(renderZReportCanvas(zData, location))
      return
    }
    window.print()
  }

  // Экран итога после закрытия
  if (result) {
    const diff = result.cash_diff
    return (
      <Shell isRtl={isRtl} lang={lang} onBack={() => navigate('/home')}>
        <div className="max-w-md mx-auto w-full">
          <div className="text-center mb-6">
            <div className="text-4xl mb-2">✓</div>
            <h1 className="text-xl font-black text-gray-900">{t(lang, 'shiftClosed')}</h1>
            {result.z_number != null && (
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'zReport')} №{result.z_number}</p>
            )}
          </div>
          <div className="card p-5 space-y-1">
            <Row label={t(lang, 'zReport')} bold />
            <Line label={t(lang, 'ordersCount')} value={String(result.orders_count)} />
            <Line label={t(lang, 'cashSales')} value={formatMoney(result.gross_cash ?? result.cash_sales, lang)} />
            <Line label={t(lang, 'cardSales')} value={formatMoney(result.gross_card ?? result.card_sales, lang)} />
            {(result.refunds_total ?? 0) > 0 && (
              <Line label={t(lang, 'refundsTotal')} value={`−${formatMoney(result.refunds_total!, lang)}`} />
            )}
            <Line label={t(lang, 'totalSales')} value={formatMoney(result.total_sales, lang)} bold />
            {result.vat_total != null && (
              <Line label={t(lang, 'vatOfSales')} value={formatMoney(result.vat_total, lang)} />
            )}
            {result.tips_total > 0 && (
              <Line label={t(lang, 'tipsTotal')} value={formatMoney(result.tips_total, lang)} />
            )}
            <div className="divider my-2" />
            <Line label={t(lang, 'expectedCash')} value={formatMoney(result.expected_cash, lang)} />
            <Line label={t(lang, 'countedCash')} value={formatMoney(result.counted_cash, lang)} />
            <Line
              label={diff === 0 ? t(lang, 'exactMatch') : diff < 0 ? t(lang, 'shortage') : t(lang, 'surplus')}
              value={formatMoney(Math.abs(diff), lang)}
              tone={diff === 0 ? 'ok' : 'warn'}
              bold
            />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-5">
            <button onClick={printZ} className="btn-secondary !rounded-2xl">
              {t(lang, 'printZReport')}
            </button>
            <button onClick={() => navigate('/home')} className="btn-primary !rounded-2xl">
              {t(lang, 'back')}
            </button>
          </div>
        </div>
        {/* Печатная версия דו"ח Z для браузерного диалога: на экране спрятана
            за пределами вьюпорта, @media print показывает только её */}
        {zData && <ZReportPrintBody z={zData} location={location} />}
      </Shell>
    )
  }

  return (
    <Shell isRtl={isRtl} lang={lang} onBack={() => navigate('/home')}>
      <div className="max-w-md mx-auto w-full">
        <h1 className="text-2xl font-black text-gray-900 mb-1">{t(lang, 'shift')}</h1>
        {shift && (
          <p className="text-sm text-gray-500 mb-5">
            {t(lang, 'openedAt')}: {new Date(shift.opened_at).toLocaleString(lang === 'he' ? 'he-IL' : 'ru-RU')}
          </p>
        )}

        {/* Баннеры: пора закрывать / много наличных (настройки точки «Смена») */}
        {remindClose && (
          <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 mb-3 text-sm font-semibold text-amber-800">
            {t(lang, 'closeReminderBanner')}
          </div>
        )}
        {tooMuchCash && (
          <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 mb-3 text-sm font-semibold text-amber-800">
            {t(lang, 'cashWarnBanner')} · {formatMoney(report!.expected_cash, lang)}
          </div>
        )}

        {/* X-отчёт (живой) */}
        {report && (
          <div className="card p-5 space-y-1 mb-5">
            <Row label={t(lang, 'xReport')} bold />
            <Line label={t(lang, 'ordersCount')} value={String(report.orders_count)} />
            <Line label={t(lang, 'cashSales')} value={formatMoney(report.cash_sales, lang)} />
            <Line label={t(lang, 'cardSales')} value={formatMoney(report.card_sales, lang)} />
            <Line label={t(lang, 'totalSales')} value={formatMoney(report.total_sales, lang)} bold />
            {report.tips_total > 0 && (
              <Line label={t(lang, 'tipsTotal')} value={formatMoney(report.tips_total, lang)} />
            )}
            <div className="divider my-2" />
            <Line label={t(lang, 'openingFloat')} value={formatMoney(report.opening_float, lang)} />
            <Line label={t(lang, 'expectedCash')} value={formatMoney(report.expected_cash, lang)} bold />
          </div>
        )}

        {!closing ? (
          <button
            onClick={() => {
              if (!canCloseShift) { toast.error(t(lang, 'permManagerToast')); return }
              setClosing(true)
            }}
            className={`btn-danger w-full !rounded-2xl ${canCloseShift ? '' : '!opacity-40'}`}
          >
            {t(lang, 'closeShift')}
          </button>
        ) : (
          <div className="card p-5 space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-500 mb-1 block">{t(lang, 'countedCash')}</label>
              <input
                className="input tabular-nums text-lg"
                inputMode="decimal"
                autoFocus
                placeholder="0"
                value={countedStr}
                onChange={(e) => setCountedStr(e.target.value)}
              />
              <p className="text-[11px] text-gray-500 mt-1.5">{t(lang, 'countCashHint')}</p>
            </div>
            <input
              className="input"
              placeholder={t(lang, 'closeNote')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                onClick={requestClose}
                disabled={close.isPending || !countedStr.trim()}
                className="btn-danger flex-1 !rounded-2xl"
              >
                {t(lang, 'closeShift')}
              </button>
              <button onClick={() => setClosing(false)} className="btn-secondary">{t(lang, 'cancel')}</button>
            </div>
          </div>
        )}
      </div>

      {confirmOpen && (
        <CloseShiftDialog
          lang={lang}
          isRtl={isRtl}
          busy={close.isPending}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={(ids) => close.mutate(ids)}
        />
      )}
    </Shell>
  )
}

/**
 * Подтверждение закрытия смены. Своя модалка вместо window.confirm —
 * системный диалог не показывается в WebView-обёртке Sunmi. Если в
 * табеле есть сотрудники на смене, показываем их галочками (по умолчанию
 * все отмечены) и снимаем выбранных с табеля при закрытии.
 */
function CloseShiftDialog({
  lang,
  isRtl,
  busy,
  onCancel,
  onConfirm,
}: {
  lang: 'ru' | 'he'
  isRtl: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: (staffIds: string[]) => void
}) {
  const { data: onShift, isLoading } = useQuery({
    queryKey: ['on_shift_staff'],
    queryFn: fetchOnShiftStaff,
  })
  // По умолчанию отмечаем всех, кто на смене
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const initialized = useRef(false)
  useEffect(() => {
    if (onShift && !initialized.current) {
      initialized.current = true
      setPicked(new Set(onShift.map((s) => s.staff_id)))
    }
  }, [onShift])

  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  const hasStaff = (onShift?.length ?? 0) > 0

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 animate-[rise-in_0.2s_ease-out]">
        <h2 className="text-lg font-black text-gray-900 mb-2">{t(lang, 'closeShiftTitle')}</h2>

        {isLoading ? (
          <p className="text-center text-gray-400 py-6">…</p>
        ) : (
          <>
            <p className="text-sm text-gray-500 mb-4">
              {hasStaff ? t(lang, 'closeShiftStaffOnShift') : t(lang, 'confirmClose')}
            </p>

            {hasStaff && (
              <>
                <div className="text-xs font-semibold text-gray-500 mb-2">{t(lang, 'closeShiftPickStaff')}</div>
                <div className="space-y-2 mb-5 max-h-64 overflow-y-auto">
                  {onShift!.map((s) => {
                    const on = picked.has(s.staff_id)
                    return (
                      <button
                        key={s.staff_id}
                        onClick={() => toggle(s.staff_id)}
                        className={`w-full flex items-center gap-3 rounded-2xl border p-3 text-start transition-all min-h-[52px] ${
                          on ? 'border-gray-900 bg-gray-50' : 'border-gray-200'
                        }`}
                      >
                        <span
                          className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${
                            on ? 'bg-gray-900 border-gray-900 text-white' : 'border-gray-300'
                          }`}
                        >
                          {on && '✓'}
                        </span>
                        <span className="flex-1 min-w-0 flex items-baseline justify-between gap-2">
                          <span className="font-bold text-gray-900 truncate">{s.staff_name}</span>
                          <span className="text-xs text-gray-500 tabular-nums shrink-0" dir="ltr">
                            {t(lang, 'sinceShort')} {new Date(s.clock_in).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => onConfirm(Array.from(picked))}
                disabled={busy}
                className="btn-danger flex-1 !rounded-2xl"
              >
                {hasStaff && picked.size > 0 ? t(lang, 'closeAndClockOut') : t(lang, 'closeShiftOnly')}
              </button>
              <button onClick={onCancel} disabled={busy} className="btn-secondary">
                {t(lang, 'cancel')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Shell({ isRtl, lang, onBack, children }: { isRtl: boolean; lang: 'ru' | 'he'; onBack: () => void; children: React.ReactNode }) {
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="shift" />
      <main className="flex-1 bg-white rounded-3xl overflow-y-auto p-6">
        <button onClick={onBack} className="btn-ghost !px-2 -ms-2 mb-4 text-sm">
          {isRtl ? '→' : '←'} {t(lang, 'back')}
        </button>
        {children}
      </main>
    </div>
  )
}

/**
 * Печатная версия דו"ח Z (иврит/RTL, как чек) для браузерного пути печати.
 * На экране уводится за вьюпорт; @media print (index.css) показывает
 * только .receipt-print и позиционирует её в 0,0.
 */
function ZReportPrintBody({ z, location }: { z: ZReportData; location: Location | undefined }) {
  const fmt = (agorot: number) => (agorot / 100).toFixed(2)
  const dt = (iso: string) => {
    const d = new Date(iso)
    return `${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
  }
  const businessName = location?.receipt_business_name || location?.name || ''

  return (
    <div dir="rtl" className="receipt-print fixed start-[-9999px] top-0 w-[300px] font-mono text-[13px] text-gray-900 leading-snug bg-white">
      <div className="text-center mb-2">
        <div className="font-bold text-base">{businessName}</div>
        {location?.receipt_address && <div className="text-xs">{location.receipt_address}</div>}
        {location?.receipt_phone && <div className="text-xs">טל׳: {location.receipt_phone}</div>}
        {location?.receipt_tax_id && <div className="text-xs">ע.מ/ח.פ: {location.receipt_tax_id}</div>}
      </div>

      <div className="text-center font-bold text-sm">דו"ח Z מס' {z.zNumber ?? '—'}</div>
      <div className="text-center text-xs mb-1">סגירת משמרת</div>
      <ZDivider />

      {z.openedAt && <ZRow label="נפתחה:" value={dt(z.openedAt)} />}
      <ZRow label="נסגרה:" value={dt(z.closedAt ?? new Date().toISOString())} />
      {z.staffName && <ZRow label='נסגרה ע"י:' value={z.staffName} />}
      <ZRow label="עסקאות:" value={String(z.ordersCount)} />
      <ZDivider />

      <ZRow label="מכירות מזומן" value={fmt(z.grossCash)} />
      <ZRow label="מכירות אשראי" value={fmt(z.grossCard)} />
      <ZRow label='סה"כ מכירות' value={fmt(z.grossCash + z.grossCard)} bold />
      {z.refundsTotal > 0 && <ZRow label="החזרים" value={`−${fmt(z.refundsTotal)}`} />}
      <ZRow label='סה"כ נטו' value={fmt(z.netTotal)} bold />
      {z.vatTotal != null && <ZRow label='מתוך זה מע"מ' value={fmt(z.vatTotal)} />}
      {z.tipsTotal > 0 && <ZRow label="טיפים" value={fmt(z.tipsTotal)} />}
      <ZDivider />

      {z.openingFloat != null && <ZRow label="עודף פתיחה" value={fmt(z.openingFloat)} />}
      <ZRow label="מזומן צפוי" value={fmt(z.expectedCash)} />
      <ZRow label="מזומן שנספר" value={fmt(z.countedCash)} />
      <ZRow
        label={z.cashDiff === 0 ? 'התאמה מלאה' : z.cashDiff < 0 ? 'חוסר' : 'עודף'}
        value={z.cashDiff === 0 ? '✓' : `${z.cashDiff < 0 ? '−' : '+'}${fmt(Math.abs(z.cashDiff))}`}
        bold
      />
      {z.note && (
        <>
          <ZDivider />
          <div className="text-center text-xs">{z.note}</div>
        </>
      )}
      <div className="text-center text-xs mt-2">— סוף דו"ח —</div>
    </div>
  )
}

function ZDivider() {
  return <div className="border-t border-dashed border-gray-300 my-2" />
}

function ZRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between text-sm ${bold ? 'font-bold' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums" dir="ltr">{value}</span>
    </div>
  )
}

function Row({ label, bold }: { label: string; bold?: boolean }) {
  return <div className={`text-xs uppercase tracking-wide text-gray-400 mb-1 ${bold ? 'font-bold' : ''}`}>{label}</div>
}

function Line({ label, value, bold, tone }: { label: string; value: string; bold?: boolean; tone?: 'ok' | 'warn' }) {
  const color = tone === 'ok' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-gray-900'
  return (
    <div className="flex justify-between items-baseline py-0.5">
      <span className={`text-sm ${bold ? 'font-bold text-gray-900' : 'text-gray-500'}`}>{label}</span>
      <span className={`tabular-nums ${bold ? 'font-black' : 'font-semibold'} ${color}`}>{value}</span>
    </div>
  )
}
