import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PublicOrderPage from './PublicOrderPage'
import { readPublicCart, writePublicCart, type StoredPublicCartLine } from './publicCart'
import { fetchPublicMenu, type PublicItem, type PublicMenu } from './publicApi'
import { t } from '../../lib/i18n'

// Настоящие страница, React Query, корзина и persistence; только API — синтетика.
vi.mock('./publicApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('./publicApi')>(),
  fetchPublicMenu: vi.fn(), fetchPublicStatus: vi.fn(), submitPublicOrder: vi.fn(),
}))

const LOC = '11111111-1111-4111-8111-111111111111'
const item: PublicItem = {
  id: 'coffee', name: 'Coffee', price: 1600, description: null, image_url: null,
  variants: [{ id: 'large', name: 'Large', price: 2000, is_default: true }],
  modifier_groups: [{ id: 'milk', name: 'Milk', min_select: 0, max_select: 1,
    modifiers: [{ id: 'oat', name: 'Oat', price_delta: 200, is_default: false }] }],
}
const stored: StoredPublicCartLine = {
  key: 'saved', itemId: item.id, name: item.name, variantId: 'large', variantName: 'Large',
  modIds: ['oat'], modNames: ['Oat'], unitPrice: 2200, qty: 2,
}
const menu = (current = item): PublicMenu => ({
  location: { id: LOC, name: 'Synthetic Cafe', currency: 'ILS', is_open: true,
    accepting: true, modules: { online_orders: true } },
  categories: [{ id: 'drinks', name: 'Drinks', items: [current] }],
})
const clients: QueryClient[] = []

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected real network request') }))
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function openCart(current = item, lines = [stored]) {
  writePublicCart(LOC, lines)
  vi.mocked(fetchPublicMenu).mockResolvedValue(menu(current))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/order/${LOC}`]}>
        <Routes><Route path="/order/:locId" element={<PublicOrderPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'להזמין' }))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(t('he', 'pubShowItems')) }))
  await screen.findByRole('heading', { name: t('he', 'pubYourOrder'), level: 1 })
  return { ...view, client }
}

function updateMenu(client: QueryClient, current: PublicItem) {
  act(() => { client.setQueryData(['public_menu', LOC, null], menu(current)) })
}
const cartText = () => document.querySelector('.public-menu-cart-lines')?.textContent ?? ''

describe('открытая гостевая корзина после обновления каталога', () => {
  it('возврат из меню на hero начинает новый заказ с пустой корзиной', async () => {
    await openCart()

    // Корзина → меню: заказ ещё сохраняется, чтобы можно было добавить позиции.
    fireEvent.click(screen.getByRole('button', { name: t('he', 'back') }))
    await screen.findByRole('heading', { name: 'Drinks', level: 2 })
    expect(readPublicCart(LOC)).toHaveLength(1)

    // Меню → hero: пользователь явно покинул заказ, поэтому он сбрасывается.
    fireEvent.click(screen.getByRole('button', { name: t('he', 'back') }))
    await screen.findByRole('button', { name: 'להזמין' })
    await waitFor(() => expect(readPublicCart(LOC)).toEqual([]))

    fireEvent.click(screen.getByRole('button', { name: 'להזמין' }))
    await screen.findByRole('heading', { name: 'Drinks', level: 2 })
    expect(screen.queryByRole('button', { name: new RegExp(t('he', 'pubShowItems')) }))
      .not.toBeInTheDocument()
  })

  it('восстановление обновляет имя товара даже без новой цены и сохраняет его на диск', async () => {
    const view = await openCart({ ...item, name: 'Renamed coffee' })
    expect(cartText()).toContain('Renamed coffee')
    expect(readPublicCart(LOC)).toEqual([{ ...stored, name: 'Renamed coffee' }])
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    view.unmount()
    await openCart({ ...item, name: 'Renamed coffee' }, readPublicCart(LOC))
    expect(cartText()).toContain('Renamed coffee')
  })

  it('реальное обновление Query меняет только подписи размеров и добавок в открытой корзине', async () => {
    const { client } = await openCart()
    expect(cartText()).toContain('Large · Oat') // положительный контроль до обновления
    updateMenu(client, { ...item,
      variants: [{ ...item.variants[0], name: 'Very large' }],
      modifier_groups: [{ ...item.modifier_groups[0],
        modifiers: [{ ...item.modifier_groups[0].modifiers[0], name: 'Oat milk' }] }],
    })
    await waitFor(() => expect(cartText()).toContain('Very large · Oat milk'))
    expect(readPublicCart(LOC)).toEqual([{ ...stored, variantName: 'Very large', modNames: ['Oat milk'] }])
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('новая обязательная группа удаляет несовместимую строку и объясняет изменение', async () => {
    const { client } = await openCart()
    expect(cartText()).toContain('Coffee')
    updateMenu(client, { ...item, modifier_groups: [...item.modifier_groups, {
      id: 'sugar', name: 'Sugar', min_select: 1, max_select: 1,
      modifiers: [{ id: 'none', name: 'No sugar', price_delta: 0, is_default: true }],
    }] })
    await waitFor(() => expect(cartText()).not.toContain('Coffee'))
    expect(readPublicCart(LOC)).toEqual([])
    expect(screen.getByRole('status')).toHaveTextContent(t('he', 'pubCartRemoved').replace('{items}', 'Coffee'))
    // Наличие default не разрешает выбирать за гостя.
    expect(cartText()).not.toContain('No sugar')
  })

  it('изменение цены пересчитывает строку с сохранением количества и показывает уведомление', async () => {
    const { client } = await openCart()
    expect(readPublicCart(LOC)[0].unitPrice).toBe(2200)
    updateMenu(client, { ...item, variants: [{ ...item.variants[0], price: 2500 }] })
    await waitFor(() => expect(readPublicCart(LOC)[0].unitPrice).toBe(2700))
    expect(readPublicCart(LOC)[0].qty).toBe(2)
    expect(screen.getByRole('status')).toHaveTextContent(t('he', 'pubCartRepriced'))
  })
})
