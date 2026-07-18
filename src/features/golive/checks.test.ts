import { describe, it, expect } from 'vitest'
import { goLiveBlocked, goLiveConfirmed, goLiveGaps } from './checks'
import type { Location } from '../../types'

function loc(over: Partial<Location> = {}): Location {
  return {
    id: 'l1', org_id: 'o1', name: 'Точка', currency: 'ILS', vat_rate: 18,
    timezone: 'Asia/Jerusalem', service_mode: 'counter',
    receipt_business_name: 'בולוצ׳קה', receipt_address: null,
    receipt_tax_id: '123456789', receipt_phone: null, receipt_footer: null,
    logo_url: null, loyalty_mode: 'off', loyalty_stamps_goal: 10,
    loyalty_points_percent: 5, loyalty_points_min_redeem: 1000,
    settings: {}, created_at: '2026-01-01',
    ...over,
  } as Location
}

describe('go-live checks (P3-13)', () => {
  it('готовая точка: пробелов нет, продажа не блокируется', () => {
    expect(goLiveGaps(loc(), 5)).toEqual([])
    expect(goLiveBlocked(loc(), 5)).toBe(false)
  })

  it('нет имени бизнеса, ИНН или каталога — критические пробелы', () => {
    expect(goLiveGaps(loc({ receipt_business_name: null }), 5)).toEqual(['businessName'])
    expect(goLiveGaps(loc({ receipt_business_name: '  ' }), 5)).toEqual(['businessName'])
    expect(goLiveGaps(loc({ receipt_tax_id: null }), 5)).toEqual(['taxId'])
    expect(goLiveGaps(loc(), 0)).toEqual(['catalog'])
    expect(goLiveBlocked(loc({ receipt_tax_id: null }), 5)).toBe(true)
  })

  it('подтверждённая точка (wizard или grandfather 084) не блокируется даже с пробелами', () => {
    const confirmed = loc({
      receipt_tax_id: null,
      settings: { go_live: { confirmed_at: '2026-07-18T12:00:00Z', source: 'grandfather' } },
    })
    expect(goLiveConfirmed(confirmed)).toBe(true)
    expect(goLiveBlocked(confirmed, 0)).toBe(false)
  })

  it('до загрузки данных не блокируем: location undefined или itemsCount null', () => {
    expect(goLiveBlocked(undefined, 0)).toBe(false)
    // каталог ещё не загружен — пробела 'catalog' нет
    expect(goLiveGaps(loc({ receipt_tax_id: null }), null)).toEqual(['taxId'])
    expect(goLiveBlocked(loc(), null)).toBe(false)
  })
})
