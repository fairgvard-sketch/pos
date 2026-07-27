import { describe, expect, it } from 'vitest'
import {
  interpretBillingState,
  shouldWarn,
  daysUntil,
  BILLING_WARN_DAYS,
  type PosEntitlement,
} from './posEntitlement'

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString()

const posState = (state: string, accessUntil?: string | null) => ({
  products: [{ product: 'pos', state, access_until: accessUntil ?? null }],
  open_invoice: null,
  min_days_left: null,
})

/**
 * Коммерческое состояние кассы (108/109). Блокирует кассу только уверенный
 * отрицательный ответ сервера; всё неоднозначное — 'unknown': офлайн-касса
 * работает по кэшу, границей остаются серверные RPC-гейты (module_disabled).
 * Триал и grace доступ НЕ блокируют — это повод показать плашку.
 */
describe('interpretBillingState', () => {
  it('оплаченный POS → ok', () => {
    expect(interpretBillingState(posState('active', inDays(20)), null).state).toBe('ok')
  })

  it('пробный период → trial с остатком дней', () => {
    const r = interpretBillingState(posState('trial', inDays(9)), null)
    expect(r.state).toBe('trial')
    expect(r.daysLeft).toBe(9)
  })

  it('grace: период оплаты истёк, но касса ещё жива', () => {
    const r = interpretBillingState(posState('grace', inDays(4)), null)
    expect(r.state).toBe('grace')
    expect(r.daysLeft).toBe(4)
  })

  it('приостановленный и отменённый продукт → missing', () => {
    expect(interpretBillingState(posState('suspended'), null).state).toBe('missing')
    expect(interpretBillingState(posState('canceled'), null).state).toBe('missing')
    expect(interpretBillingState(posState('none'), null).state).toBe('missing')
  })

  it('неоплаченный QR-меню не блокирует кассу', () => {
    const mixed = {
      products: [
        { product: 'pos', state: 'active', access_until: inDays(30) },
        { product: 'menu', state: 'suspended', access_until: null },
      ],
      open_invoice: null,
    }
    expect(interpretBillingState(mixed, null).state).toBe('ok')
  })

  it('QR без кассы: подписки на pos нет → не блокируем, решает сервер', () => {
    const qrOnly = {
      products: [{ product: 'menu', state: 'active', access_until: inDays(30) }],
      open_invoice: null,
    }
    expect(interpretBillingState(qrOnly, null).state).toBe('unknown')
  })

  it('открытый счёт прокидывается в плашку', () => {
    const withInvoice = {
      ...posState('grace', inDays(3)),
      open_invoice: { number: 'ANGLE-2026-000042', total_agorot: 17800 },
    }
    const r = interpretBillingState(withInvoice, null)
    expect(r.invoiceNumber).toBe('ANGLE-2026-000042')
    expect(r.invoiceTotalAgorot).toBe(17800)
  })

  it('ошибка сети/RPC не блокирует кассу', () => {
    expect(interpretBillingState(posState('suspended'), { code: 'PGRST301' }).state).toBe('unknown')
  })

  it('база до 109 (функции нет) не блокирует кассу', () => {
    expect(interpretBillingState(null, { code: '42883' }).state).toBe('unknown')
  })

  it('неожиданный payload не блокирует кассу', () => {
    expect(interpretBillingState('yes', null).state).toBe('unknown')
    expect(interpretBillingState(null, null).state).toBe('unknown')
    expect(interpretBillingState(undefined, null).state).toBe('unknown')
    expect(interpretBillingState({ products: [] }, null).state).toBe('unknown')
    expect(interpretBillingState(posState('чепуха'), null).state).toBe('unknown')
  })
})

describe('daysUntil', () => {
  it('прошедшая дата → 0, а не отрицательное число', () => {
    expect(daysUntil(inDays(-5))).toBe(0)
  })

  it('нет даты или мусор → null (бессрочно/неизвестно)', () => {
    expect(daysUntil(null)).toBeNull()
    expect(daysUntil(undefined)).toBeNull()
    expect(daysUntil('не дата')).toBeNull()
  })
})

describe('shouldWarn', () => {
  const make = (state: PosEntitlement['state'], daysLeft: number | null): PosEntitlement => ({
    state,
    daysLeft,
    invoiceNumber: null,
    invoiceTotalAgorot: null,
  })

  it('grace показывается всегда — доступ уже за пределами оплаченного периода', () => {
    expect(shouldWarn(make('grace', 6))).toBe(true)
    expect(shouldWarn(make('grace', null))).toBe(true)
  })

  it('длинный триал не мозолит глаза в горячем потоке', () => {
    expect(shouldWarn(make('trial', BILLING_WARN_DAYS + 1))).toBe(false)
    expect(shouldWarn(make('trial', BILLING_WARN_DAYS))).toBe(true)
    expect(shouldWarn(make('trial', 0))).toBe(true)
  })

  it('оплаченная и неизвестная касса плашку не показывают', () => {
    expect(shouldWarn(make('ok', 3))).toBe(false)
    expect(shouldWarn(make('unknown', null))).toBe(false)
    expect(shouldWarn(make('missing', null))).toBe(false)
  })
})
