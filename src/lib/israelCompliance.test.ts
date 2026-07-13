import { describe, expect, it } from 'vitest'
import {
  cashPaymentTotal,
  assertStandardCashLimitForPayments,
  exceedsStandardCashLimit,
  maxStandardCashPayment,
  remainingStandardCashAllowance,
  STANDARD_CASH_THRESHOLD,
} from './israelCompliance'

describe('Israeli standard business cash limit', () => {
  it('allows the full amount through 6,000 NIS inclusive', () => {
    expect(maxStandardCashPayment(599_999)).toBe(599_999)
    expect(maxStandardCashPayment(STANDARD_CASH_THRESHOLD)).toBe(600_000)
  })

  it('limits a larger transaction to 10%, rounded down to an agorot', () => {
    expect(maxStandardCashPayment(600_001)).toBe(60_000)
    expect(maxStandardCashPayment(2_345_679)).toBe(234_567)
  })

  it('caps cash at 6,000 NIS for very large transactions', () => {
    expect(maxStandardCashPayment(7_000_000)).toBe(600_000)
  })

  it('adds all cash parts of a mixed or equal-split payment', () => {
    const payments = [
      { method: 'cash', amount: 40_000 },
      { method: 'card', amount: 520_001 },
      { method: 'cash', amount: 20_000 },
    ]
    expect(cashPaymentTotal(payments)).toBe(60_000)
    expect(remainingStandardCashAllowance(600_001, payments)).toBe(0)
    expect(exceedsStandardCashLimit(600_001, payments)).toBe(false)
    expect(exceedsStandardCashLimit(600_001, [...payments, { method: 'cash', amount: 1 }])).toBe(true)
  })

  it('fails before an illegal payment reaches the network or offline outbox', () => {
    expect(() => assertStandardCashLimitForPayments([
      { method: 'cash', amount: 60_001 },
      { method: 'card', amount: 540_000 },
    ])).toThrow('cash_limit_exceeded')
  })

  it('rejects empty, non-integer and non-positive payment amounts', () => {
    expect(() => assertStandardCashLimitForPayments([])).toThrow('invalid_payments')
    expect(() => assertStandardCashLimitForPayments([{ method: 'card', amount: 10.5 }])).toThrow('invalid_payment_amount')
    expect(() => assertStandardCashLimitForPayments([{ method: 'cash', amount: 0 }])).toThrow('invalid_payment_amount')
  })
})
