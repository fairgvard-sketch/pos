import { describe, expect, it } from 'vitest'
import {
  parsePublicOrderQuery,
  publicAppOrigin,
  publicOrderUrl,
  publicReservationUrl,
} from './orderContext'

const TABLE_TOKEN = '123e4567-e89b-42d3-a456-426614174000'

describe('parsePublicOrderQuery', () => {
  it('defaults an unscoped link without trusting arbitrary values', () => {
    expect(parsePublicOrderQuery('?mode=car&source=ad')).toEqual({
      tableToken: null,
      requestedType: null,
      channel: 'link',
      kiosk: false,
    })
  })

  it('maps pickup links to takeaway', () => {
    expect(parsePublicOrderQuery('?mode=pickup&source=website')).toEqual({
      tableToken: null,
      requestedType: 'takeaway',
      channel: 'website',
      kiosk: false,
    })
  })

  it('forces a valid table token into dine-in table context', () => {
    expect(parsePublicOrderQuery(`?table=${TABLE_TOKEN}&mode=delivery&source=social`)).toEqual({
      tableToken: TABLE_TOKEN,
      requestedType: 'here',
      channel: 'table_qr',
      kiosk: false,
    })
  })

  it('enables idle reset only for an explicit kiosk link', () => {
    expect(parsePublicOrderQuery('?source=counter_qr&kiosk=1')).toMatchObject({
      channel: 'counter_qr',
      kiosk: true,
    })
    expect(parsePublicOrderQuery('?source=counter_qr')).toMatchObject({ kiosk: false })
  })
})

describe('publicOrderUrl', () => {
  it('uses the canonical menu domain for backoffice links', () => {
    expect(publicAppOrigin()).toBe('https://menu.angle.co.il')
  })

  it('creates a stable counter QR URL', () => {
    expect(publicOrderUrl('https://pos.example', 'loc-1', { channel: 'counter_qr' }))
      .toBe('https://pos.example/order/loc-1?source=counter_qr')
  })

  it('does not combine table QR with a conflicting mode', () => {
    expect(publicOrderUrl('https://pos.example', 'loc-1', {
      tableToken: TABLE_TOKEN,
      channel: 'social',
      mode: 'delivery',
    })).toBe(`https://pos.example/order/loc-1?table=${TABLE_TOKEN}&source=table_qr`)
  })

  it('prefers the human-readable slug over the location id', () => {
    expect(publicOrderUrl('https://menu.angle.co.il', 'fe2eebf0-65e3-45b4-a81f-331359d71955', {
      slug: 'bulochka',
    })).toBe('https://menu.angle.co.il/order/bulochka')
  })

  it('keeps the slug on printed table QR links', () => {
    expect(publicOrderUrl('https://menu.angle.co.il', 'loc-1', {
      slug: 'bulochka',
      tableToken: TABLE_TOKEN,
    })).toBe(`https://menu.angle.co.il/order/bulochka?table=${TABLE_TOKEN}&source=table_qr`)
  })

  it('falls back to the id when no slug is configured', () => {
    expect(publicOrderUrl('https://menu.angle.co.il', 'loc-1', { slug: null }))
      .toBe('https://menu.angle.co.il/order/loc-1')
  })
})

describe('publicReservationUrl', () => {
  it('creates a reservation URL on the selected public origin', () => {
    expect(publicReservationUrl('https://menu.angle.co.il', 'loc-1'))
      .toBe('https://menu.angle.co.il/reserve/loc-1')
  })

  it('prefers the slug when the owner configured one', () => {
    expect(publicReservationUrl('https://menu.angle.co.il', 'loc-1', 'bulochka'))
      .toBe('https://menu.angle.co.il/reserve/bulochka')
  })
})
