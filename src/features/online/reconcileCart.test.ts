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

  const modifier = (id: string, name = id) => ({ id, name, price_delta: 100, is_default: false })
  const group = (min = 0, max = 0) => ({
    id: 'g1', name: 'Добавки', min_select: min, max_select: max,
    modifiers: [modifier('m1'), modifier('m2')],
  })

  it('сохраняет массив и строку по ссылке, если ничего не изменилось', () => {
    const original = [line()]
    expect(reconcileCart(original, menu([item()])).lines).toBe(original)
  })

  it('обновляет все подписи без смены ID, порядка, количества и цены', () => {
    const original = line({ variantId: 'v1', variantName: 'Старый размер',
      modIds: ['m2', 'm1'], modNames: ['Старая добавка 2', 'Старая добавка 1'],
      unitPrice: 2200, qty: 3 })
    const r = reconcileCart([original], menu([item({ name: 'Новое имя',
      variants: [{ id: 'v1', name: 'Новый размер', price: 2000, is_default: false }],
      modifier_groups: [group()],
    })]))
    expect(r.lines).toEqual([{ ...original, name: 'Новое имя',
      variantName: 'Новый размер', modNames: ['m2', 'm1'] }])
    expect(r.repriced).toBe(false)
    expect(original.variantName).toBe('Старый размер')
    expect(original.modNames).toEqual(['Старая добавка 2', 'Старая добавка 1'])
    expect(reconcileCart(r.lines, menu([item({ name: 'Новое имя',
      variants: [{ id: 'v1', name: 'Новый размер', price: 2000, is_default: false }],
      modifier_groups: [group()],
    })])).lines).toBe(r.lines)
  })

  it('убирает строку при появлении обязательного выбора размера', () => {
    const r = reconcileCart([line()], menu([item({
      variants: [{ id: 'v1', name: 'Размер', price: 1600, is_default: true }],
    })]))
    expect(r.lines).toEqual([])
    expect(r.removed).toEqual(['Латте'])
  })

  it.each([
    { name: 'новая обязательная группа', min: 1, max: 1, ids: [] },
    { name: 'повышенный минимум', min: 2, max: 0, ids: ['m1'] },
    { name: 'пониженный максимум', min: 0, max: 1, ids: ['m1', 'm2'] },
    { name: 'повтор одного ID не заменяет два выбора', min: 2, max: 2, ids: ['m1', 'm1'] },
  ])('убирает несовместимую строку: $name', ({ min, max, ids }) => {
    const r = reconcileCart([line({ modIds: ids })], menu([item({ modifier_groups: [group(min, max)] })]))
    expect(r.lines).toEqual([])
    expect(r.removed).toEqual(['Латте'])
    expect(r.repriced).toBe(false)
  })

  it.each([
    { name: 'пустая необязательная группа', min: 0, max: 1, ids: [] },
    { name: 'ровно минимум и максимум', min: 2, max: 2, ids: ['m1', 'm2'] },
    { name: 'нулевой максимум — без ограничения', min: 1, max: 0, ids: ['m1', 'm2'] },
  ])('сохраняет допустимый состав: $name', ({ min, max, ids }) => {
    const original = [line({ modIds: ids, modNames: ids, unitPrice: 1600 + 100 * ids.length })]
    const r = reconcileCart(original, menu([item({ modifier_groups: [group(min, max)] })]))
    expect(r.lines).toBe(original)
    expect(r.removed).toEqual([])
    expect(r.repriced).toBe(false)
  })

  it('проверяет минимум каждой группы отдельно, а не общее число добавок', () => {
    const r = reconcileCart([line({ modIds: ['m1', 'm2'] })], menu([item({ modifier_groups: [
      group(0, 0), { id: 'g2', name: 'Молоко', min_select: 1, max_select: 1, modifiers: [modifier('m3')] },
    ] })]))
    expect(r.lines).toEqual([])
  })

  it('удаление плохой строки не теряет соседа и его пересчёт', () => {
    const original = [line({ key: 'bad', modIds: ['gone'] }), line({ key: 'good', qty: 2 })]
    const r = reconcileCart(original, menu([item({ price: 1800 })]))
    expect(r.lines).toEqual([{ ...original[1], unitPrice: 1800 }])
    expect(r.removed).toEqual(['Латте'])
    expect(r.repriced).toBe(true)
    expect(original[1].unitPrice).toBe(1600)
  })
})
