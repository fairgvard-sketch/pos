import type { Transaction } from './api'
import { refundedTotal } from './api'
import { receiptMethodLabel } from '../../lib/payMethods'

/**
 * CSV-экспорт журнала операций за выбранный период (P1). Заголовки — иврит,
 * как у всех коммерческих документов; BOM — чтобы Excel открывал UTF-8.
 * Суммы в шекелях с точкой (машиночитаемо), даты локальные dd.mm.yyyy.
 */

const HEADERS = [
  'תאריך',        // дата
  'שעה',          // время
  'מס\' קבלה',    // номер чека
  'מס\' הזמנה',   // дневной номер
  'סכום',         // сумма, ₪
  'הוחזר',        // возвращено, ₪
  'סטטוס',        // статус
  'אופן תשלום',   // способы оплаты
  'מוכר/ת',       // сотрудник
  'לקוח/ה',       // гость
  'שולחן',        // стол
]

const STATUS_HE: Record<Transaction['status'], string> = {
  paid: 'שולם',
  fulfilled: 'נמסר',
  refunded: 'הוחזר',
}

function esc(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function transactionsToCsv(txs: Transaction[]): string {
  const rows = txs.map((tx) => {
    const dt = new Date(tx.paid_at ?? tx.created_at)
    const methods = tx.payments
      .filter((p) => p.amount > 0)
      .map((p) => receiptMethodLabel(p.method))
      .join(' + ')
    const refunded = refundedTotal(tx)
    return [
      dt.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
      tx.receipt_number ?? '',
      tx.daily_number,
      (tx.total / 100).toFixed(2),
      refunded > 0 ? (refunded / 100).toFixed(2) : '',
      STATUS_HE[tx.status],
      methods,
      tx.staff?.name ?? '',
      tx.customer_name ?? '',
      tx.table_label ?? '',
    ]
      .map(esc)
      .join(',')
  })
  return '\uFEFF' + [HEADERS.map(esc).join(','), ...rows].join('\r\n')
}

/** Скачивание CSV в браузере (менеджерский сценарий, не горячий поток) */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
