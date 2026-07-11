import { useQuery } from '@tanstack/react-query'
import { fetchRefundReceipt, type RefundReceipt } from './api'
import { renderRefundReceiptCanvas } from './printCanvas'
import { fetchCurrentLocation } from '../auth/api'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { canvasToRawbtUrl, canvasToEscposBase64 } from '../../lib/escpos'
import { t } from '../../lib/i18n'
import type { Location } from '../../types'

interface Props {
  refundId: string
  /** Перепечатка старого зикуя — только как *העתק* (оригинал уже выдан) */
  reprint?: boolean
  onClose: () => void
}

/**
 * Просмотр и печать תעודת זיכוי (чека возврата). Документ — всегда
 * иврит/RTL (фискальный), кнопки — на языке UI. Печать тем же
 * конвейером, что и чек: мост APK → RawBT → браузерный диалог.
 */
export default function RefundReceiptSheet({ refundId, reprint = false, onClose }: Props) {
  const lang = useLangStore((s) => s.lang)
  const printMode = useDeviceStore((s) => s.printMode)
  const { data: receipt, isLoading } = useQuery({
    queryKey: ['refund_receipt', refundId],
    queryFn: () => fetchRefundReceipt(refundId),
  })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })

  function handlePrint() {
    if (!receipt) return
    const bridge = window.KassaAndroid
    if (bridge?.isAvailable()) {
      const canvas = renderRefundReceiptCanvas(receipt, location, { copy: reprint })
      bridge.printBase64(canvasToEscposBase64(canvas))
      return
    }
    if (printMode === 'rawbt') {
      const canvas = renderRefundReceiptCanvas(receipt, location, { copy: reprint })
      window.location.href = canvasToRawbtUrl(canvas)
      return
    }
    window.print()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl w-full max-w-sm max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 overflow-y-auto">
          {isLoading || !receipt ? (
            <p className="text-center text-gray-400 py-12">…</p>
          ) : (
            <RefundReceiptBody receipt={receipt} location={location} copy={reprint} />
          )}
        </div>

        <div className="p-4 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2 shrink-0">
          <button onClick={handlePrint} disabled={!receipt} className="btn-primary !py-3.5 !rounded-2xl">
            {t(lang, 'printReceipt')}
          </button>
          <button onClick={onClose} className="btn-ghost !py-3.5 !rounded-2xl">
            {t(lang, 'close')}
          </button>
        </div>
      </div>
    </div>
  )
}

function fmt(agorot: number): string {
  return (agorot / 100).toFixed(2)
}

/** Тело зикуя — оно же печатается (класс receipt-print). Иврит, RTL. */
function RefundReceiptBody({ receipt: r, location, copy = false }: {
  receipt: RefundReceipt
  location: Location | undefined
  copy?: boolean
}) {
  const businessName = location?.receipt_business_name || location?.name || ''
  const dt = new Date(r.created_at)
  const dateStr = dt.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })

  return (
    <div dir="rtl" className="receipt-print font-mono text-[13px] text-gray-900 leading-snug">
      <div className="text-center mb-2">
        <div className="font-bold text-base">{businessName}</div>
        {location?.receipt_address && <div className="text-xs">{location.receipt_address}</div>}
        {location?.receipt_phone && <div className="text-xs">טל׳: {location.receipt_phone}</div>}
        {location?.receipt_tax_id && <div className="text-xs">ע.מ/ח.פ: {location.receipt_tax_id}</div>}
      </div>

      <div className="text-center font-bold text-sm">תעודת זיכוי {r.refund_number ?? '—'}</div>
      <div className="text-center text-xs mb-1">{copy ? '*העתק*' : '*מקור*'}</div>

      <Divider />

      <MetaRow label="תאריך:" value={`${timeStr} ${dateStr}`} />
      {r.receipt_number != null && <MetaRow label="עבור חשבונית:" value={String(r.receipt_number)} />}
      <MetaRow label="הזמנה:" value={`#${r.daily_number}`} />
      {r.staff_name && <MetaRow label="מוכר/ת:" value={r.staff_name} />}
      {r.reason && (
        <div className="flex justify-between text-sm gap-2">
          <span className="shrink-0">סיבה:</span>
          <span className="min-w-0 truncate">{r.reason}</span>
        </div>
      )}

      <Divider />

      {r.items && r.items.length > 0 && (
        <>
          {r.items.map((l, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="min-w-0 truncate pl-2">
                {l.qty > 1 && `${l.qty}× `}
                {l.name}
              </span>
              <span className="tabular-nums shrink-0" dir="ltr">−{fmt(l.amount)}</span>
            </div>
          ))}
        </>
      )}

      <div className="text-center font-bold text-lg my-3" >
        סה"כ זיכוי: <span dir="ltr">−{fmt(r.amount)}</span>
      </div>

      <MetaRow label='סה"כ חייב במע"מ' value={`−${fmt(r.amount - r.vat_amount)}`} />
      <MetaRow label={`מע"מ ${Number(r.vat_rate).toFixed(1)}%`} value={`−${fmt(r.vat_amount)}`} />

      <Divider />
      <MetaRow label={r.method === 'cash' ? 'מזומן' : 'אשראי'} value={`−${fmt(r.amount)}`} />

      {location?.receipt_footer && (
        <>
          <Divider />
          <div className="text-center text-xs">{location.receipt_footer}</div>
        </>
      )}
    </div>
  )
}

function Divider() {
  return <div className="border-t border-dashed border-gray-300 my-2" />
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span>{label}</span>
      <span className="tabular-nums" dir="ltr">{value}</span>
    </div>
  )
}
