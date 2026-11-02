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
 * Суммы документа (раздел 2.4.יב, разъяснения 1 и 5):
 * - все суммы положительны, смысл несёт тип документа (330 уменьшает
 *   доход), кроме скидок: скидка уменьшает документ и идёт со знаком «−»;
 * - 1219 «до скидки» и 1221 «после скидок» — обе БЕЗ НДС, поэтому
 *   1219 + 1220 = 1221 и 1221 + 1222 = 1223 сходятся до агоры;
 * - строки D110 без НДС в сумме дают ровно 1219: НДС выделяется из суммы
 *   документа, а не построчно, и раскладывается по строкам пропорционально
 *   (остатки округления — по наибольшему остатку);
 * - в строке «количество × цена + скидка строки = итог строки» тоже точно:
 *   цена за единицу округляется вверх, а остаток (меньше агоры на штуку)
 *   уходит в скидку строки со знаком «−».
 *
 * Открытые вопросы к бухгалтеру (см. docs/israel-compliance.md):
 * трактовка чаевых (сейчас вне документа), маппинг bit.
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
  /**
   * Документ-основание — исходный чек (поля D110 1256/1257, разъяснение 6)
   * и его покупатель. Выборка отдаёт их с миграции 185; до неё — нет.
   */
  base_receipt_number?: number | null
  base_doc_type?: string | null
  customer_name?: string | null
  buyer_name?: string | null
  buyer_tax_id?: string | null
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
  /** Клиент документа — для карточки счёта B110 (ключ = C100 1225). */
  customer: DocumentCustomer
}

/** Клиент, на которого выписан документ. */
export interface DocumentCustomer {
  key: string
  /** Название карточки счёта. */
  name: string
  taxId?: number
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

/**
 * Ключ клиента (поле 1225) обязателен для документов 100–710. У Kassa
 * нет карточки покупателя на каждый чек, поэтому ключ — ח.פ покупателя,
 * если чек выписан на компанию, иначе общий ключ разового покупателя.
 */
export const WALK_IN_CUSTOMER_KEY = 'WALKIN'
export const WALK_IN_CUSTOMER_NAME = 'לקוח מזדמן'
/** Название общей карточки разовых покупателей (B110). */
export const WALK_IN_ACCOUNT_NAME = 'לקוחות מזדמנים'

/**
 * Клиент документа: компания — по своему ח.פ, все остальные — одна общая
 * карточка разовых покупателей. Имя на чеке (окликают у стойки) карточкой
 * не становится.
 */
function documentCustomer(
  taxId: number | undefined,
  buyerName: string | null | undefined,
): DocumentCustomer {
  return taxId
    ? { key: String(taxId), name: buyerName ?? String(taxId), taxId }
    : { key: WALK_IN_CUSTOMER_KEY, name: WALK_IN_ACCOUNT_NAME }
}

/** ח.פ покупателя → 9 цифр либо undefined (мусор не уходит в числовое поле). */
function buyerTaxId(raw: string | null | undefined): number | undefined {
  const digits = (raw ?? '').replace(/\D/g, '')
  return digits.length > 0 && digits.length <= 9 ? Number(digits) : undefined
}

/**
 * Раскладка целой суммы по весам пропорционально, методом наибольшего
 * остатка: результат — целые агороты, сумма которых равна `total` ровно.
 * Только целочисленная арифметика (total × вес < 2^53 для любых чеков).
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('uf_bad_allocation')
  if (weights.length === 0) return []
  const sum = weights.reduce((s, w) => s + Math.max(w, 0), 0)
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0))
  const shares = weights.map((w, i) => {
    const product = total * Math.max(w, 0)
    return { i, base: Math.floor(product / sum), rest: product % sum }
  })
  let left = total - shares.reduce((s, x) => s + x.base, 0)
  const out = shares.map((x) => x.base)
  for (const x of [...shares].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left === 0) break
    out[x.i] += 1
    left -= 1
  }
  return out
}

/**
 * Строка D110 по итогу строки без НДС: цена за единицу округлена вверх,
 * остаток округления — скидкой строки со знаком «−», чтобы
 * количество × цена + скидка = итог строки (поле 1267) точно.
 */
function linePricing(lineTotalExVat: number, qty: number) {
  if (qty <= 0) return { unitPriceExVat: 0, lineDiscount: 0, lineTotal: lineTotalExVat }
  const unitPriceExVat = Math.ceil(lineTotalExVat / qty)
  return {
    unitPriceExVat,
    lineDiscount: lineTotalExVat - unitPriceExVat * qty, // ≤ 0
    lineTotal: lineTotalExVat,
  }
}

/**
 * Оплаты документа без чаевых: чаевые не входят в total (миграция 033),
 * но проходят через payments. Строки D120 обязаны дать итог документа
 * (поле 1223), поэтому излишек снимается с последних строк оплаты.
 */
export function paymentsForDocument(
  payments: readonly KassaPaymentRow[],
  total: number,
): KassaPaymentRow[] {
  let excess = payments.reduce((s, p) => s + p.amount, 0) - total
  const out = payments.map((p) => ({ ...p }))
  for (let i = out.length - 1; i >= 0 && excess > 0; i--) {
    const cut = Math.min(out[i].amount, excess)
    out[i].amount -= cut
    excess -= cut
  }
  return out.filter((p) => p.amount > 0)
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

  // Без НДС: до скидки — из суммы позиций, после скидок — снапшот заказа.
  const beforeDiscountExVat = order.subtotal - vatInside(order.subtotal, order.vat_rate)
  const afterDiscountExVat = order.total - order.vat_amount
  const linesExVat = allocate(
    beforeDiscountExVat,
    order.items.map((item) => item.line_total),
  )
  const taxId = buyerTaxId(order.buyer_tax_id)
  const customer = documentCustomer(taxId, order.buyer_name)

  const header: DocumentHeader = {
    recordNumber: seq.record++,
    taxId: ctx.taxId,
    docType: docTypeCode,
    docNumber,
    docDate: date,
    docTime: time,
    customerName: order.buyer_name ?? order.customer_name ?? WALK_IN_CUSTOMER_NAME,
    customerTaxId: taxId,
    valueDate: date,
    amountBeforeDiscount: beforeDiscountExVat,
    documentDiscount: afterDiscountExVat - beforeDiscountExVat, // ≤ 0
    amountExVat: afterDiscountExVat,
    vatAmount: order.vat_amount,
    amountIncVat: order.total,
    customerKey: customer.key,
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
        ...linePricing(linesExVat[i], item.qty),
        vatPercent: Math.round(order.vat_rate * 100), // 18% → 1800
        branchId: ctx.branchId,
        docDate: date,
        linkId,
      }),
    )
  })

  const payments = paymentsForDocument(order.payments, order.total)
  payments.forEach((p, i) => {
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
    counts: { C100: 1, D110: order.items.length, D120: payments.length },
    docTypeCode,
    totalIncVat: order.total,
    customer,
  }
}

// ---------------------------------------------------------------- возврат

/**
 * Возврат → документ 330 (חשבונית מס זיכוי): C100 + строки из снапшота
 * позиций (или одна строка «החזר» при возврате суммой).
 *
 * Строк D120 у зикуя нет: «פרטי קבלה/הפקדה» принадлежат квитанциям
 * (320/400) — официальный симулятор не привязывает D120 к заголовку 330
 * и отвергает набор («לא נמצאה רשומת כותרת מסמך», прогон 02.11.2026).
 * Способ выплаты остаётся на печатном зикуе и в учёте смены.
 *
 * Суммы кредитового документа выгружаются ПОЛОЖИТЕЛЬНЫМИ — семантику
 * несёт тип документа (разъяснение 1), как в печатном зикуе Kassa.
 * Каждая строка ссылается на исходный чек как на документ-основание
 * (разъяснение 6), покупатель — тот же, что в исходном чеке.
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
  const amountExVat = refund.amount - vat
  const taxId = buyerTaxId(refund.buyer_tax_id)
  const customer = documentCustomer(taxId, refund.buyer_name)
  const baseDocType = refund.base_doc_type
    ? DOC_TYPE_CODES[refund.base_doc_type as keyof typeof DOC_TYPE_CODES]
    : undefined
  const baseDocNumber = refund.base_receipt_number ? String(refund.base_receipt_number) : undefined
  const records: Uint8Array[] = []

  records.push(
    c100({
      recordNumber: seq.record++,
      taxId: ctx.taxId,
      docType: docTypeCode,
      docNumber,
      docDate: date,
      docTime: time,
      customerName: refund.buyer_name ?? refund.customer_name ?? WALK_IN_CUSTOMER_NAME,
      customerTaxId: taxId,
      valueDate: date,
      amountBeforeDiscount: amountExVat,
      documentDiscount: 0,
      amountExVat,
      vatAmount: vat,
      amountIncVat: refund.amount,
      customerKey: customer.key,
      printDate: date,
      branchId: ctx.branchId,
      linkId,
    }),
  )

  const lines = refund.items?.length
    ? refund.items
    : [{ name: 'החזר', qty: 1, amount: refund.amount }]
  const linesExVat = allocate(
    amountExVat,
    lines.map((item) => item.amount),
  )
  lines.forEach((item, i) => {
    records.push(
      d110({
        recordNumber: seq.record++,
        taxId: ctx.taxId,
        docType: docTypeCode,
        docNumber,
        lineNumber: i + 1,
        baseDocType: baseDocNumber ? baseDocType : undefined,
        baseDocNumber,
        description: item.name,
        unitDescription: 'יחידה',
        quantity: item.qty * 10_000,
        ...linePricing(linesExVat[i], item.qty),
        vatPercent: Math.round(refund.vat_rate * 100),
        branchId: ctx.branchId,
        docDate: date,
        linkId,
        baseBranchId: baseDocNumber && ctx.branchId ? ctx.branchId : undefined,
      }),
    )
  })

  return {
    records,
    counts: { C100: 1, D110: lines.length, D120: 0 },
    docTypeCode,
    totalIncVat: refund.amount,
    customer,
  }
}
