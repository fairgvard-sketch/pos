import { describe, expect, it } from 'vitest'
import { isViewOnlyMenu, type PublicMenu } from './publicApi'

const loc = (overrides: Partial<PublicMenu['location']> = {}): PublicMenu['location'] => ({
  id: 'l1',
  name: 'Точка',
  currency: 'ILS',
  is_open: false,
  ...overrides,
})

describe('isViewOnlyMenu', () => {
  it('организация без модуля online_orders — чистая витрина', () => {
    expect(isViewOnlyMenu(loc({ modules: { online_orders: false } }))).toBe(true)
  })

  it('модуль online_orders активен — обычный сценарий заказа', () => {
    expect(isViewOnlyMenu(loc({ modules: { online_orders: true } }))).toBe(false)
  })

  it('старая edge function без поля modules — поведение не меняется', () => {
    expect(isViewOnlyMenu(loc())).toBe(false)
    expect(isViewOnlyMenu(loc({ modules: {} }))).toBe(false)
  })

  it('меню ещё не загружено — не витрина (решение примет загрузка)', () => {
    expect(isViewOnlyMenu(undefined)).toBe(false)
  })
})
