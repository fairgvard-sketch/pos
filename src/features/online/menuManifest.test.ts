import { describe, expect, it } from 'vitest'
import { GET } from '../../../api/menu-manifest'
import { buildMenuManifest } from './menuManifest'

const LOCATION_A = '10000000-0000-4000-8000-000000000001'
const LOCATION_B = '20000000-0000-4000-8000-000000000002'
const TABLE_TOKEN = '30000000-0000-4000-8000-000000000003'

describe('buildMenuManifest', () => {
  it('creates a distinct install identity for every menu', () => {
    const first = buildMenuManifest(new URLSearchParams({ loc: LOCATION_A, name: 'Café Alef' }))
    const second = buildMenuManifest(new URLSearchParams({ loc: LOCATION_B, name: 'Café Bet' }))

    expect(first).toMatchObject({
      id: `/order/${LOCATION_A}`,
      start_url: `/order/${LOCATION_A}`,
      name: 'Café Alef',
      scope: '/order/',
      orientation: 'portrait',
    })
    expect(second?.id).toBe(`/order/${LOCATION_B}`)
    expect(second?.id).not.toBe(first?.id)
  })

  it('keeps a table token and gives the table install its own identity', () => {
    const manifest = buildMenuManifest(new URLSearchParams({
      loc: LOCATION_A,
      table: TABLE_TOKEN,
      mode: 'delivery',
      source: 'social',
    }))

    expect(manifest?.id).toBe(`/order/${LOCATION_A}?table=${TABLE_TOKEN}`)
    expect(manifest?.start_url)
      .toBe(`/order/${LOCATION_A}?table=${TABLE_TOKEN}&source=table_qr`)
  })

  it('preserves only supported counter context values', () => {
    const manifest = buildMenuManifest(new URLSearchParams({
      loc: LOCATION_A,
      mode: 'takeaway',
      source: 'website',
      redirect: 'https://evil.example',
    }))

    expect(manifest?.start_url)
      .toBe(`/order/${LOCATION_A}?mode=takeaway&source=website`)
    expect(JSON.stringify(manifest)).not.toContain('evil.example')
  })

  it('builds an install identity from a human-readable slug (106)', () => {
    const manifest = buildMenuManifest(new URLSearchParams({ loc: 'bulochka', name: 'בולוצ׳קה' }))

    expect(manifest).toMatchObject({
      id: '/order/bulochka',
      start_url: '/order/bulochka',
      name: 'בולוצ׳קה',
      scope: '/order/',
    })
  })

  it('rejects slugs that do not match the location_slugs format', () => {
    // Дефис по краям, верхний регистр, спецсимволы и обход пути — всё это
    // попало бы прямо в start_url установленного приложения.
    for (const loc of ['-abc', 'abc-', 'AbCd', 'a', 'ab..cd', 'a/b', 'a'.repeat(41)]) {
      expect(buildMenuManifest(new URLSearchParams({ loc }))).toBeNull()
    }
  })

  it('rejects an invalid location and drops invalid optional values', () => {
    expect(buildMenuManifest(new URLSearchParams({ loc: '../setup' }))).toBeNull()

    const manifest = buildMenuManifest(new URLSearchParams({
      loc: LOCATION_A,
      table: 'not-a-token',
      mode: 'car',
      source: 'ad',
    }))
    expect(manifest?.start_url).toBe(`/order/${LOCATION_A}`)
  })

  it('serves a web-manifest response and rejects invalid requests', async () => {
    const response = GET(new Request(
      `https://pos.example/api/menu-manifest?loc=${LOCATION_A}&name=Coffee`,
    ))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/manifest+json')
    await expect(response.json()).resolves.toMatchObject({
      id: `/order/${LOCATION_A}`,
      name: 'Coffee',
    })

    // Не 'bad': короткое слово из латиницы — это валидный слаг точки (106)
    const invalid = GET(new Request('https://pos.example/api/menu-manifest?loc=..%2Fsetup'))
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get('cache-control')).toBe('no-store')
  })

  it('поверхность брони получает свой scope и start_url (118)', () => {
    const manifest = buildMenuManifest(
      new URLSearchParams(`loc=${LOCATION_A}&surface=reserve&name=Bulochka`),
    )
    expect(manifest?.start_url).toBe(`/reserve/${LOCATION_A}`)
    expect(manifest?.scope).toBe('/reserve/')
    expect(manifest?.id).toBe(`/reserve/${LOCATION_A}`)
    expect(manifest?.description).toBe('Table reservations')
  })

  it('поверхность по умолчанию — заказ; чужое значение не подставляется в путь', () => {
    const bogus = buildMenuManifest(
      new URLSearchParams(`loc=${LOCATION_A}&surface=..%2Fsetup`),
    )
    expect(bogus?.start_url).toBe(`/order/${LOCATION_A}`)
    expect(bogus?.scope).toBe('/order/')
  })
})
