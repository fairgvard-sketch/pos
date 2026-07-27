import { describe, expect, it } from 'vitest'
import { hmacSha256Hex, timingSafeEqual, verifyWebhookSignature } from './signature'

/**
 * Подпись webhook'а — единственное, что отличает настоящее уведомление
 * провайдера от подделки: возврат пользователя на success-страницу
 * оплатой не является. Поэтому проверка обязана быть fail closed на
 * каждом кривом входе, а не «пропустить, раз непонятно».
 */

const SECRET = 'whsec_test_secret'
const BODY = '{"id":"evt_1","type":"checkout.session.completed"}'

describe('verifyWebhookSignature', () => {
  it('верная подпись проходит', async () => {
    const sig = await hmacSha256Hex(SECRET, BODY)
    const r = await verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signatureHeader: sig,
    })
    expect(r.ok).toBe(true)
  })

  it('подделанное тело не проходит (подпись считается по сырым байтам)', async () => {
    const sig = await hmacSha256Hex(SECRET, BODY)
    const tampered = BODY.replace('evt_1', 'evt_hacked')
    const r = await verifyWebhookSignature({
      secret: SECRET,
      rawBody: tampered,
      signatureHeader: sig,
    })
    expect(r).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('чужой секрет не проходит', async () => {
    const sig = await hmacSha256Hex('whsec_attacker', BODY)
    const r = await verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signatureHeader: sig,
    })
    expect(r).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('без секрета функция выключена, а не открыта настежь', async () => {
    const r = await verifyWebhookSignature({
      secret: undefined,
      rawBody: BODY,
      signatureHeader: 'whatever',
    })
    expect(r).toEqual({ ok: false, reason: 'missing_secret' })
  })

  it('без заголовка подписи — отказ', async () => {
    const r = await verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signatureHeader: null,
    })
    expect(r).toEqual({ ok: false, reason: 'missing_signature' })
  })

  it('свежее уведомление с меткой времени проходит', async () => {
    const now = Date.now()
    const ts = Math.floor(now / 1000)
    const sig = await hmacSha256Hex(SECRET, `${ts}.${BODY}`)
    const r = await verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signatureHeader: sig,
      timestamp: ts,
      now,
    })
    expect(r.ok).toBe(true)
  })

  it('replay старого перехваченного уведомления отбивается', async () => {
    const now = Date.now()
    const ts = Math.floor(now / 1000) - 3600 // час назад
    const sig = await hmacSha256Hex(SECRET, `${ts}.${BODY}`)
    const r = await verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signatureHeader: sig,
      timestamp: ts,
      now,
    })
    expect(r).toEqual({ ok: false, reason: 'stale' })
  })

  it('подпись без метки времени не подходит к запросу с меткой', async () => {
    const now = Date.now()
    const ts = Math.floor(now / 1000)
    const sigWithoutTs = await hmacSha256Hex(SECRET, BODY)
    const r = await verifyWebhookSignature({
      secret: SECRET,
      rawBody: BODY,
      signatureHeader: sigWithoutTs,
      timestamp: ts,
      now,
    })
    expect(r).toEqual({ ok: false, reason: 'bad_signature' })
  })
})

describe('timingSafeEqual', () => {
  it('одинаковые хекс-строки равны', () => {
    expect(timingSafeEqual('a1b2c3', 'a1b2c3')).toBe(true)
  })

  it('разные значения и длины не равны', () => {
    expect(timingSafeEqual('a1b2c3', 'a1b2c4')).toBe(false)
    expect(timingSafeEqual('a1b2', 'a1b2c3')).toBe(false)
  })

  it('мусор вместо хекса не проходит (и не бросает)', () => {
    expect(timingSafeEqual('zzzz', 'a1b2')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(false)
    expect(timingSafeEqual('abc', 'abc')).toBe(false) // нечётная длина
  })
})
