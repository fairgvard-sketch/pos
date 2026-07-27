import { describe, expect, it } from 'vitest'
import { parseWebhook } from './providers'

/**
 * Адаптеры провайдеров переводят формат, но не решают, оплачен ли счёт:
 * сумма из webhook нужна только для СВЕРКИ со счётом в БД
 * (record_provider_payment, 111). Любой невнятный вход должен давать
 * отказ, а не догадку — иначе доступ откроется по мусорному payload.
 */

const INVOICE = 'a1b2c3d4-1111-4222-8333-444455556666'

describe('parseWebhook: stripe', () => {
  const ok = {
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        payment_intent: 'pi_1',
        amount_total: 17800,
        currency: 'ils',
        metadata: { invoice_id: INVOICE },
      },
    },
  }

  it('успешная оплата разбирается', () => {
    const r = parseWebhook('stripe', ok)
    expect(r).toEqual({
      ok: true,
      payment: {
        eventId: 'evt_1',
        invoiceId: INVOICE,
        amountAgorot: 17800,
        currency: 'ILS',
        eventType: 'checkout.session.completed',
        providerRef: 'pi_1',
      },
    })
  })

  it('посторонние события игнорируются, доступ не открывают', () => {
    const r = parseWebhook('stripe', { ...ok, type: 'payment_intent.created' })
    expect(r).toEqual({ ok: false, reason: 'unsupported_event_type' })
  })

  it('без invoice_id в metadata — отказ (непонятно, какой счёт закрывать)', () => {
    const noMeta = { ...ok, data: { object: { ...ok.data.object, metadata: {} } } }
    expect(parseWebhook('stripe', noMeta)).toEqual({ ok: false, reason: 'missing_invoice_id' })
  })

  it('invoice_id не-UUID отбивается', () => {
    const bad = {
      ...ok,
      data: { object: { ...ok.data.object, metadata: { invoice_id: '../../etc/passwd' } } },
    }
    expect(parseWebhook('stripe', bad)).toEqual({ ok: false, reason: 'missing_invoice_id' })
  })

  it('дробная или отрицательная сумма отбивается (агороты целые)', () => {
    const frac = { ...ok, data: { object: { ...ok.data.object, amount_total: 178.5 } } }
    expect(parseWebhook('stripe', frac)).toEqual({ ok: false, reason: 'bad_amount' })

    const neg = { ...ok, data: { object: { ...ok.data.object, amount_total: -100 } } }
    expect(parseWebhook('stripe', neg)).toEqual({ ok: false, reason: 'bad_amount' })
  })

  it('сумма строкой не принимается', () => {
    const str = { ...ok, data: { object: { ...ok.data.object, amount_total: '17800' } } }
    expect(parseWebhook('stripe', str)).toEqual({ ok: false, reason: 'bad_amount' })
  })

  it('мусор вместо тела не роняет разбор', () => {
    expect(parseWebhook('stripe', null)).toEqual({ ok: false, reason: 'bad_payload' })
    expect(parseWebhook('stripe', 'строка')).toEqual({ ok: false, reason: 'bad_payload' })
    expect(parseWebhook('stripe', {})).toEqual({ ok: false, reason: 'missing_event_fields' })
  })
})

describe('parseWebhook: cardcom', () => {
  const ok = {
    InternalDealNumber: '9001',
    TranzactionId: 'tx-9001',
    ResponseCode: 0,
    ReturnValue: INVOICE,
    Amount: 178,
  }

  it('успешная оплата: шекели переводятся в агороты', () => {
    const r = parseWebhook('cardcom', ok)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payment.amountAgorot).toBe(17800)
      expect(r.payment.currency).toBe('ILS')
      expect(r.payment.providerRef).toBe('tx-9001')
    }
  })

  it('дробные шекели округляются до целых агорот', () => {
    const r = parseWebhook('cardcom', { ...ok, Amount: 178.55 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payment.amountAgorot).toBe(17855)
  })

  it('неуспешная транзакция не считается оплатой', () => {
    const r = parseWebhook('cardcom', { ...ok, ResponseCode: 500 })
    expect(r).toEqual({ ok: false, reason: 'payment_not_successful' })
  })

  it('без ReturnValue (наш invoice_id) — отказ', () => {
    const { ReturnValue: _drop, ...noRet } = ok
    expect(parseWebhook('cardcom', noRet)).toEqual({ ok: false, reason: 'missing_invoice_id' })
  })
})

describe('parseWebhook: manual', () => {
  it('у ручного провайдера webhook-а нет — приём был бы дырой', () => {
    expect(parseWebhook('manual', { id: 'x' })).toEqual({
      ok: false,
      reason: 'provider_has_no_webhook',
    })
  })
})
