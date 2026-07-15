import { useQuery } from '@tanstack/react-query'
import { fetchRefundReceipt, type RefundReceipt } from './api'
import { renderRefundReceiptCanvas } from './printCanvas'
import { fetchCurrentLocation } from '../auth/api'
import { useLangStore } from '../../store/langStore'
import { useDeviceStore } from '../../store/deviceStore'
import { hasSilentPrintPath } from '../../lib/escpos'
import { printCanvasWithRetry } from './printFailure'
import { receiptMethodLabel } from '../../lib/payMethods'
import { t } from '../../lib/i18n'
import type { Location } from '../../types'

interface Props {
  refundId: string
  /** Перепечатка старого зикуя — только как *העתק* (оригинал уже выдан) */
  reprint?: boolean
  onClose: () => void
}

/**
 * Просмотр и печать чека возврата (документ זכות). Документ — всегда
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

  async function handlePrint() {
    if (!receipt) return
    const allowRawbt = printMode === 'rawbt'
    if (hasSilentPrintPath(allowRawbt)) {
      await printCanvasWithRetry(
        () => renderRefundReceiptCanvas(receipt, location, { copy: reprint }),
        allowRawbt,
      )
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

/** Название типа документа на иврите (фиск. требование Израиля) */
function docTypeLabel(dt: RefundReceipt['doc_type']): string {
  switch (dt) {
    case 'receipt': return 'קבלה'
    case 'tax_invoice': return 'חשבונית מס'
    case 'invoice_receipt': return 'חשבונית מס/קבלה'
  }
}

/**
 * Тело зикуя — оно же печатается (класс receipt-print). Иврит, RTL.
 * Знаки — как в референсе старой системы: минус только в строках таблицы,
 * итог «לזיכוי», НДС и способ возврата — положительные.
 */
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

      <div className="text-center font-bold text-sm">{docTypeLabel(r.doc_type)} זכות {r.refund_number ?? '—'}</div>
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

      {/* Таблица позиций как у чека: минус в количестве и сумме строки.
          Возврат произвольной суммой (items = null) — без таблицы. */}
      {r.items && r.items.length > 0 && (
        <>
          <div className="grid grid-cols-[1fr_3.5rem_2rem_3.5rem] text-xs font-bold border-b border-gray-300 pb-1 mb-1">
            <span>שם</span>
            <span className="text-left">מחיר</span>
            <span className="text-center">כמות</span>
            <span className="text-left">לתשלום</span>
          </div>
          {r.items.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_3.5rem_2rem_3.5rem] text-sm items-baseline">
              <span className="truncate pl-2">{l.name}</span>
              <span className="text-left tabular-nums">{fmt(Math.round(l.amount / l.qty))}</span>
              <span className="text-center tabular-nums" dir="ltr">−{l.qty}</span>
              <span className="text-left tabular-nums" dir="ltr">−{fmt(l.amount)}</span>
            </div>
          ))}
          <div className="flex justify-between text-sm font-bold border-t border-gray-300 mt-1 pt-1">
            <span>סה"כ פריטים</span>
            <span className="tabular-nums" dir="ltr">−{r.items.reduce((s, l) => s + l.qty, 0)}</span>
          </div>
        </>
      )}

      {/* Итог зикуя — положительный, направление задаёт метка */}
      <div className="text-center font-bold text-lg my-3">
        לזיכוי: {fmt(r.amount)}
      </div>

      <MetaRow label='סה"כ חייב במע"מ' value={fmt(r.amount - r.vat_amount)} />
      <MetaRow label={`מע"מ ${Number(r.vat_rate).toFixed(1)}%`} value={fmt(r.vat_amount)} />

      <Divider />
      <div className="text-sm font-bold">אופן החזר כספי:</div>
      <MetaRow label={receiptMethodLabel(r.method)} value={fmt(r.amount)} />

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
