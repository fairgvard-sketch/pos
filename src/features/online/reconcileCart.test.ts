import { describe, expect, it } from 'vitest'
import { reconcileCart } from './reconcileCart'
import type { PublicMenu } from './publicApi'
import type { StoredPublicCartLine } from './publicCart'

/**
 * Корзина живёт 6 часов и хранит снапшот цен. Сверка нужна, чтобы гость
 * узнал о подорожавшем или исчезнувшем товаре сразу, а не на последнем
 * шаге после заполнения контактов.
 */

const menu = (items: unknown[]): PublicMenu => ({
  location: {} as PublicMenu['location'],
  categories: [{ id: 'c1', name: 'Кофе', items }],
} as unknown as PublicMenu)

const line = (over: Partial<StoredPublicCartLine> = {}): StoredPublicCartLine => ({
  key: 'k1',
  itemId: 'i1',
  name: 'Латте',
  variantId: null,
  variantName: null,
  modIds: [],
  modNames: [],
  unitPrice: 1600,
  qty: 1,
  ...over,
})

const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  name: 'Латте',
  price: 1600,
  description: null,
  image_url: null,
  variants: [],
  modifier_groups: [],
  ...over,
})

describe('reconcileCart', () => {
  it('неизменившуюся корзину оставляет как есть', () => {
    const r = reconcileCart([line()], menu([item()]))
    expect(r.lines).toHaveLength(1)
    expect(r.removed).toEqual([])
    expect(r.repriced).toBe(false)
  })

  it('исчезнувший товар убирает и называет его', () => {
    const r = reconcileCart([line()], menu([]))
    expect(r.lines).toEqual([])
    expect(r.removed).toEqual(['Латте'])
  })

  it('подорожавший товар пересчитывает и поднимает флаг', () => {
    const r = reconcileCart([line()], menu([item({ price: 1800 })]))
    expect(r.lines[0].unitPrice).toBe(1800)
    expect(r.repriced).toBe(true)
    expect(r.removed).toEqual([])
  })

  it('цена берётся из выбранного варианта, а не базовая', () => {
    const withVariant = item({
      variants: [{ id: 'v1', name: 'Большой', price: 2200, is_default: false }],
    })
    const r = reconcileCart(
      [line({ variantId: 'v1', variantName: 'Большой', unitPrice: 2000 })],
      menu([withVariant]),
    )
    expect(r.lines[0].unitPrice).toBe(2200)
    expect(r.repriced).toBe(true)
  })

  it('исчезнувший вариант убирает строку — состав не додумываем', () => {
    const r = reconcileCart(
      [line({ variantId: 'v-gone', variantName: 'Большой' })],
      menu([item()]),
    )
    expect(r.lines).toEqual([])
    expect(r.removed).toEqual(['Латте'])
  })

  it('надбавки модификаторов входят в цену', () => {
    const withMods = item({
      modifier_groups: [{
        id: 'g1',
        name: 'Молоко',
        min_select: 0,
        max_select: 1,
        modifiers: [{ id: 'm1', name: 'Соевое', price_delta: 200, is_default: false }],
      }],
    })
    const r = reconcileCart(
      [line({ modIds: ['m1'], modNames: ['Соевое'], unitPrice: 1800 })],
      menu([withMods]),
    )
    // 1600 базовая + 200 надбавка
    expect(r.lines[0].unitPrice).toBe(1800)
    expect(r.repriced).toBe(false)
  })

  it('исчезнувший модификатор убирает строку', () => {
    const r = reconcileCart(
      [line({ modIds: ['m-gone'], modNames: ['Соевое'] })],
      menu([item()]),
    )
    expect(r.lines).toEqual([])
    expect(r.removed).toEqual(['Латте'])
  })

  it('переименованный товар обновляет название без флага цены', () => {
    const r = reconcileCart([line()], menu([item({ name: 'Латте на овсяном' })]))
    expect(r.lines[0].name).toBe('Латте на овсяном')
    expect(r.repriced).toBe(false)
  })
})
