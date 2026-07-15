/**
 * Маппинг снапшотов Kassa (orders / order_items / payments / refunds)
 * на документные записи Единого формата 1.31 (C100 + D110* + D120*).
 *
 * Модуль чистый: на вход — plain-объекты строк БД (их подготавливает
 * серверный экспорт), на выход — готовые байтовые записи и метаданные
 * для контрольного отчёта. Никаких обращений к БД и часам.
 *
 * Принятые соответствия (сверены с приложением 1 спецификации):
 * - doc_type 'receipt' → 400 (קבלה), 'tax_invoice' → 305 (חשבונית מס),
 *   'invoice_receipt' → 320 (חשבונית מס/קבלה); возврат → 330 (חשבונית מס זיכוי).
 * - способы оплаты (поле 1306): cash → 1 (מזומן), card → 3 (כרטיס אשראי),
 *   cibus/tenbis → 5 (תווי קניה), bit → 4 (העברה בנקאית), иное → 9.
 *
 * Открытые вопросы к бухгалтеру (см. docs/israel-compliance.md):
 * знак сумм в זיכוי (330), трактовка чаевых, маппинг bit.
 *
 * НДС: цены Kassa включают НДС; выделение — той же формулой, что и
 * сервер (`ROUND(total*rate/(100+rate))`, миграция 009), чтобы экспорт
 * бил в копейку со снапшотами заказов.
 */

import { c100, d110, d120, type DocumentHeader } from './records.ts'

export const DOC_TYPE_CODES = {
  receipt: 400,
  tax_invoice: 305,
  invoice_receipt: 320,
  refund: 330,
} as const

export const PAYMENT_METHOD_CODES: Record<string, number> = {
  cash: 1,
  card: 3,
  cibus: 5,
  tenbis: 5,
  bit: 4,
}
const PAYMENT_METHOD_OTHER = 9

// ------------------------------------------------------------- вход (БД)

export interface KassaOrderItemRow {
  name: string
  variant_name: string | null
  unit_price: number // агороты, с НДС, с модификаторами
  qty: number
  line_total: number // агороты, с НДС
}

export interface KassaPaymentRow {
  method: string
  amount: number // агороты — фактически зачтено (не tendered)
}

export interface KassaOrderRow {
  receipt_number: number
  doc_type: keyof typeof DOC_TYPE_CODES | 'receipt' | 'tax_invoice' | 'invoice_receipt'
  paid_at: string // ISO timestamptz (UTC)
  customer_name: string | null
  buyer_name: string | null // чек на компанию (048)
  buyer_tax_id: string | null
  subtotal: number // сумма позиций с НДС, до скидок
  vat_rate: number // проценты, снапшот (18)
  vat_amount: number // НДС внутри total
  total: number // к оплате, с НДС, после скидок
  discount_amount: number
  loyalty_discount: number
  items: KassaOrderItemRow[]
  payments: KassaPaymentRow[]
}

export interface KassaRefundRow {
  refund_number: number
  created_at: string // ISO timestamptz (UTC)
  amount: number // агороты, > 0
  method: string
  reason: string | null
  vat_rate: number // ставка исходного заказа
  /** Снапшот позиций [{name, qty, amount}] либо null (возврат суммой). */
  items: { name: string; qty: number; amount: number }[] | null
}

/** Контекст выгрузки: реквизиты, общие для всех документов набора. */
export interface ExportContext {
  taxId: number
  /** Идентификатор филиала; '' если филиалов нет. */
  branchId: string
}

/** Сквозные счётчики набора: номера записей и связок документов. */
export interface ExportSequence {
  record: number // следующий № записи BKMVDATA
  doc: number // следующий внутренний linkId
}

export interface MappedDocument {
  records: Uint8Array[]
  /** Для summary INI.TXT: количество записей по типам. */
  counts: { C100: number; D110: number; D120: number }
  /** Для контрольного отчёта (раздел 2.6): тип и итог документа. */
  docTypeCode: number
  totalIncVat: number
}

// ---------------------------------------------------------------- helpers

/** НДС внутри суммы-с-НДС — формула сервера (миграция 009). */
export function vatInside(amountIncVat: number, vatRatePct: number): number {
  return Math.round((amountIncVat * vatRatePct) / (100 + vatRatePct))
}

/**
 * Дата и время документа в часовом поясе бизнеса (Asia/Jerusalem):
 * фискальный документ датируется локальным временем точки, а БД хранит UTC.
 */
export function ilDateTime(iso: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    date: `${get('year')}${get('month')}${get('day')}`,
    time: `${get('hour') === '24' ? '00' : get('hour')}${get('minute')}`,
  }
}

function paymentCode(method: string): number {
  return PAYMENT_METHOD_CODES[method] ?? PAYMENT_METHOD_OTHER
}

// ---------------------------------------------------------------- продажа

/** Оплаченный заказ → C100 + D110 по позициям + D120 по оплатам. */
export function mapSaleOrder(
  order: KassaOrderRow,
  ctx: ExportContext,
  seq: ExportSequence,
): MappedDocument {
  const docTypeCode = DOC_TYPE_CODES[order.doc_type as keyof typeof DOC_TYPE_CODES]
  if (!docTypeCode || order.doc_type === 'refund') throw new Error('uf_bad_doc_type')
  if (!order.receipt_number) throw new Error('uf_missing_receipt_number')

  const { date, time } = ilDateTime(order.paid_at)
  const docNumber = String(order.receipt_number)
  const linkId = seq.doc++
  const records: Uint8Array[] = []

  const header: DocumentHeader = {
    recordNumber: seq.record++,
    taxId: ctx.taxId,
    docType: docTypeCode,
    docNumber,
    docDate: date,
    docTime: time,
    customerName: order.buyer_name ?? order.customer_name ?? 'לקוח מזדמן',
    customerTaxId: order.buyer_tax_id ? Number(order.buyer_tax_id) : undefined,
    valueDate: date,
    amountBeforeDiscount: order.subtotal,
    documentDiscount: order.discount_amount + order.loyalty_discount,
    amountExVat: order.total - order.vat_amount,
    vatAmount: order.vat_amount,
    amountIncVat: order.total,
    customerKey: order.buyer_tax_id ?? '',
    printDate: date,
    branchId: ctx.branchId,
    linkId,
  }
  records.push(c100(header))

  order.items.forEach((item, i) => {
    const name = item.variant_name ? `${item.name} ${item.variant_name}` : item.name
    records.push(
      d110({
        recordNumber: seq.record++,
        taxId: ctx.taxId,
        docType: docTypeCode,
        docNumber,
        lineNumber: i + 1,
        description: name,
        unitDescription: 'יחידה',
        quantity: item.qty * 10_000, // X9(12)V9999
        unitPriceExVat: item.unit_price - vatInside(item.unit_price, order.vat_rate),
        lineDiscount: 0, // скидки в Kassa — уровнем документа
        lineTotal: item.line_total - vatInside(item.line_total, order.vat_rate),
        vatPercent: Math.round(order.vat_rate * 100), // 18% → 1800
        branchId: ctx.branchId,
        docDate: date,
        linkId,
      }),
    )
  })

  order.payments.forEach((p, i) => {
    records.push(
      d120({
        recordNumber: seq.record++,
        taxId: ctx.taxId,
        docType: docTypeCode,
        docNumber,
        lineNumber: i + 1,
        paymentMethod: paymentCode(p.method),
        amount: p.amount,
        branchId: ctx.branchId,
        docDate: date,
        linkId,
      }),
    )
  })

  return {
    records,
    counts: { C100: 1, D110: order.items.length, D120: order.payments.length },
    docTypeCode,
    totalIncVat: order.total,
  }
}

// ---------------------------------------------------------------- возврат

/**
 * Возврат → документ 330 (חשבונית מס זיכוי): C100 + строки из снапшота
 * позиций (или одна строка «החזר» при возврате суммой) + D120 выплаты.
 *
 * Суммы кредитового документа выгружаются ПОЛОЖИТЕЛЬНЫМИ — семантику
 * несёт тип документа, как в печатном зикуе Kassa. Подтвердить у
 * бухгалтера и симулятором до регистрации.
 */
export function mapRefund(
  refund: KassaRefundRow,
  ctx: ExportContext,
  seq: ExportSequence,
): MappedDocument {
  if (!refund.refund_number) throw new Error('uf_missing_refund_number')
  const docTypeCode = DOC_TYPE_CODES.refund
  const { date, time } = ilDateTime(refund.created_at)
  const docNumber = String(refund.refund_number)
  const linkId = seq.doc++
  const vat = vatInside(refund.amount, refund.vat_rate)
  const records: Uint8Array[] = []

  records.push(
    c100({
      recordNumber: seq.record++,
      taxId: ctx.taxId,
      docType: docTypeCode,
      docNumber,
      docDate: date,
      docTime: time,
      customerName: 'לקוח מזדמן',
      valueDate: date,
      amountBeforeDiscount: refund.amount,
      documentDiscount: 0,
      amountExVat: refund.amount - vat,
      vatAmount: vat,
      amountIncVat: refund.amount,
      customerKey: '',
      printDate: date,
      branchId: ctx.branchId,
      linkId,
    }),
  )

  const lines = refund.items ?? [{ name: 'החזר', qty: 1, amount: refund.amount }]
  lines.forEach((item, i) => {
    records.push(
      d110({
        recordNumber: seq.record++,
        taxId: ctx.taxId,
        docType: docTypeCode,
        docNumber,
        lineNumber: i + 1,
        description: item.name,
        unitDescription: 'יחידה',
        quantity: item.qty * 10_000,
        unitPriceExVat:
          item.qty > 0
            ? Math.round((item.amount - vatInside(item.amount, refund.vat_rate)) / item.qty)
            : 0,
        lineDiscount: 0,
        lineTotal: item.amount - vatInside(item.amount, refund.vat_rate),
        vatPercent: Math.round(refund.vat_rate * 100),
        branchId: ctx.branchId,
        docDate: date,
        linkId,
      }),
    )
  })

  records.push(
    d120({
      recordNumber: seq.record++,
      taxId: ctx.taxId,
      docType: docTypeCode,
      docNumber,
      lineNumber: 1,
      paymentMethod: paymentCode(refund.method),
      amount: refund.amount,
      branchId: ctx.branchId,
      docDate: date,
      linkId,
    }),
  )

  return {
    records,
    counts: { C100: 1, D110: lines.length, D120: 1 },
    docTypeCode,
    totalIncVat: refund.amount,
  }
}
