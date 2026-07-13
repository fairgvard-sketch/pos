import type { Agorot } from './money'

/**
 * Cash-use restriction for an ordinary transaction with a business in Israel.
 *
 * Up to and including 6,000 NIS the whole transaction may be paid in cash.
 * Above 6,000 NIS, cash is limited to the lower of 10% of the transaction
 * value and 6,000 NIS. Values stay in integer agorot.
 *
 * The separate tourist threshold is intentionally not enabled: the POS does
 * not yet collect and audit the evidence needed to classify a buyer as a
 * tourist. Until that flow exists, every sale uses the standard business rule.
 */
export const STANDARD_CASH_THRESHOLD: Agorot = 600_000

type PaymentLike = {
  method: string
  amount: Agorot
}

export function maxStandardCashPayment(transactionTotal: Agorot): Agorot {
  const total = Math.max(Math.floor(transactionTotal), 0)
  if (total <= STANDARD_CASH_THRESHOLD) return total
  return Math.min(Math.floor(total / 10), STANDARD_CASH_THRESHOLD)
}

export function cashPaymentTotal(payments: readonly PaymentLike[]): Agorot {
  return payments.reduce(
    (sum, payment) => sum + (payment.method === 'cash' ? Math.max(Math.floor(payment.amount), 0) : 0),
    0,
  )
}

export function paymentAmountTotal(payments: readonly PaymentLike[]): Agorot {
  return payments.reduce((sum, payment) => sum + Math.max(Math.floor(payment.amount), 0), 0)
}

export function remainingStandardCashAllowance(
  transactionTotal: Agorot,
  payments: readonly PaymentLike[],
): Agorot {
  return Math.max(maxStandardCashPayment(transactionTotal) - cashPaymentTotal(payments), 0)
}

export function exceedsStandardCashLimit(
  transactionTotal: Agorot,
  payments: readonly PaymentLike[],
): boolean {
  return cashPaymentTotal(payments) > maxStandardCashPayment(transactionTotal)
}

/** Fail before a network call or an offline-outbox write. The database repeats the check. */
export function assertStandardCashLimitForPayments(payments: readonly PaymentLike[]): void {
  if (payments.length === 0) throw new Error('invalid_payments')
  if (payments.some((payment) => !Number.isSafeInteger(payment.amount) || payment.amount <= 0)) {
    throw new Error('invalid_payment_amount')
  }
  if (exceedsStandardCashLimit(paymentAmountTotal(payments), payments)) {
    throw new Error('cash_limit_exceeded')
  }
}
