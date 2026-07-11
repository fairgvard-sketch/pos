import type { Receipt, ReceiptLine, ReceiptPayment } from './api'
import type { PaymentInput } from '../sell/api'
import type { BillLine } from '../tables/api'
import {
  cartSubtotal,
  cartTotal,
  discountAmount,
  loyaltyAmount,
  lineUnitPrice,
  type CartDiscount,
  type CartLine,
  type CartRedeem,
  type OrderType,
} from '../../store/cartStore'
import type { Location } from '../../types'

/**
 * Временный чек офлайн-продажи (фаза 7): строится целиком на кассе,
 * без fetchReceipt. Деньги — зеркало серверной математики (cartStore ↔
 * round_order_total 034), поэтому суммы совпадут со снапшотом после
 * replay. Фискального номера нет — печатается «מסמך זמני» + K-n;
 * настоящий номер присвоит pay_order при синхронизации.
 */

function cartLineToReceiptLine(l: CartLine): ReceiptLine {
  return {
    name: l.name,
    variant_name: l.variantName,
    qty: l.qty,
    unit_price: lineUnitPrice(l),
    line_total: lineUnitPrice(l) * l.qty,
    modifiers: l.mods.map((m) => ({ name: m.name, price_delta: m.priceDelta })),
  }
}

/** Серверная строка счёта стола → строка чека (для оплаты стола офлайн) */
export function billLineToReceiptLine(l: BillLine): ReceiptLine {
  return {
    name: l.name,
    variant_name: l.variant_name,
    qty: l.qty,
    unit_price: l.qty > 0 ? Math.round(l.line_total / l.qty) : l.line_total,
    line_total: l.line_total,
    modifiers: l.modifiers.map((name) => ({ name, price_delta: 0 })),
  }
}

function toReceiptPayment(p: PaymentInput): ReceiptPayment {
  return {
    method: p.method,
    amount: p.amount,
    tendered: p.tendered ?? null,
    change_due: p.change_due ?? null,
  }
}

export function buildLocalReceipt(args: {
  lines: CartLine[]
  /** Уже заказанные серверные строки (оплата счёта стола офлайн) */
  extraLines?: ReceiptLine[]
  orderType: OrderType
  customerName: string
  tableLabel: string | null
  discount: CartDiscount | null
  redeem: CartRedeem | null
  payments: PaymentInput[]
  tip: number
  staffName: string | null
  location: Location | undefined
  provisionalNumber: string | null
  /** Серверный номер, если заказ создан онлайн (известен до оплаты) */
  dailyNumber?: number | null
  /** Итог, если посчитан сервером (append вернул total); иначе — клиентский */
  knownTotal?: number | null
  paidAt: string
}): Receipt {
  const cartLines = args.lines.map(cartLineToReceiptLine)
  const lines = [...(args.extraLines ?? []), ...cartLines]

  const subtotal = lines.reduce((s, l) => s + l.line_total, 0)
  const cartOnlySubtotal = cartSubtotal(args.lines)
  // Скидка/лояльность считаются только в counter-потоке (скидка стола
  // живёт на заказе и уже входит в knownTotal сервера)
  const disc = args.extraLines?.length ? 0 : discountAmount(cartOnlySubtotal, args.discount, args.redeem)
  const loy = args.extraLines?.length ? 0 : loyaltyAmount(cartOnlySubtotal, args.discount, args.redeem)
  const total = args.knownTotal ?? cartTotal(args.lines, args.discount, args.redeem)

  const vatRate = Number(args.location?.vat_rate ?? 18)
  const vatAmount = Math.round((total * vatRate) / (100 + vatRate))

  return {
    order_id: '', // серверного id ещё нет — временный документ
    daily_number: args.dailyNumber ?? 0,
    receipt_number: null,
    doc_type: 'invoice_receipt', // дефолт orders.doc_type (020)
    allocation_number: null,
    buyer_name: null, // реквизиты покупателя (048) добавляются онлайн, после синка
    buyer_tax_id: null,
    order_type: args.orderType,
    customer_name: args.customerName || null,
    table_label: args.tableLabel,
    status: 'paid',
    subtotal,
    discount_type: args.discount?.type ?? null,
    discount_value: args.discount?.value ?? null,
    discount_amount: disc,
    loyalty_discount: loy,
    vat_rate: vatRate,
    vat_amount: vatAmount,
    total,
    tip_amount: args.tip,
    paid_at: args.paidAt,
    created_at: args.paidAt,
    staff_name: args.staffName,
    lines,
    payments: args.payments.map(toReceiptPayment),
    provisional: true,
    provisional_number: args.provisionalNumber,
  }
}
