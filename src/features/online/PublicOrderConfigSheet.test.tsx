import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PublicOrderPage from './PublicOrderPage'
import { readPublicCart } from './publicCart'
import { fetchPublicMenu, type PublicItem, type PublicMenu } from './publicApi'
import { t } from '../../lib/i18n'

// Настоящие страница, React Query и корзина; синтетика только в API.
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
const other: PublicItem = {
  id: 'tea', name: 'Tea', price: 1200, description: null, image_url: null,
  variants: [], modifier_groups: [],
}
const menu = (items: PublicItem[] = [item, other]): PublicMenu => ({
  location: { id: LOC, name: 'Synthetic Cafe', currency: 'ILS', is_open: true,
    accepting: true, modules: { online_orders: true } },
  categories: [{ id: 'drinks', name: 'Drinks', items }],
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

/** Открыть карточку настройки товара так, как это делает гость. */
async function openConfigSheet(name = 'Coffee') {
  vi.mocked(fetchPublicMenu).mockResolvedValue(menu())
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/order/${LOC}`]}>
        <Routes><Route path="/order/:locId" element={<PublicOrderPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'להזמין' }))
  const card = (await screen.findAllByRole('button'))
    .find((button) => button.className.includes('public-menu-item-card')
      && button.textContent?.includes(name))
  if (!card) throw new Error(`карточка товара ${name} не найдена`)
  fireEvent.click(card)
  await screen.findByRole('dialog')
  return { client }
}

/**
 * Обновление каталога прямо во время открытой карточки (staleTime/refetch).
 * React Query уведомляет подписчиков асинхронно, поэтому ждём, пока страница
 * действительно применит новое меню: иначе клик «Добавить» успевает пройти
 * раньше обновления, и сверка корзины прячет гонку вместо её воспроизведения.
 */
async function updateMenu(client: QueryClient, items: PublicItem[]) {
  await act(async () => {
    client.setQueryData(['public_menu', LOC, null], menu(items))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
/**
 * Кнопка добавления — последняя в полосе отправки. По тексту её искать
 * нельзя: когда состав неполный, она подписана «выберите …», а не «добавить».
 */
const addButton = () => {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.public-menu-item-submit button')
  return buttons[buttons.length - 1]
}
const sheetText = () => document.querySelector('.public-menu-item-sheet')?.textContent ?? ''

describe('открытая карточка настройки во время обновления каталога', () => {
  it('положительный контроль: без обновления каталога состав и цена добавляются как есть', async () => {
    await openConfigSheet()
    expect(sheetText()).toContain('Large')
    fireEvent.click(addButton()!)
    await waitFor(() => expect(readPublicCart(LOC)).toHaveLength(1))
    expect(readPublicCart(LOC)[0]).toMatchObject({
      itemId: 'coffee', name: 'Coffee', variantId: 'large', variantName: 'Large', unitPrice: 2000,
    })
  })

  it('новая цена из каталога попадает в корзину, а не снимок открытой карточки', async () => {
    const { client } = await openConfigSheet()
    await updateMenu(client, [{ ...item, variants: [{ ...item.variants[0], price: 2500 }] }, other])
    fireEvent.click(addButton()!)
    await waitFor(() => expect(readPublicCart(LOC)).toHaveLength(1))
    expect(readPublicCart(LOC)[0].unitPrice).toBe(2500)
  })

  it('переименование товара в каталоге доезжает до добавленной строки', async () => {
    const { client } = await openConfigSheet()
    await updateMenu(client, [{ ...item, name: 'Filter coffee' }, other])
    fireEvent.click(addButton()!)
    await waitFor(() => expect(readPublicCart(LOC)).toHaveLength(1))
    expect(readPublicCart(LOC)[0].name).toBe('Filter coffee')
  })

  it('исчезнувший товар нельзя добавить: карточка объясняет это и не закрывается сама', async () => {
    const { client } = await openConfigSheet()
    await updateMenu(client, [other])
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(
      t('he', 'pubItemGone').replace('{item}', 'Coffee')))
    // Карточку закрывает гость, а не мы: добавить больше нечего, но и
    // выбор состава с ценой исчезнувшего товара не показывается
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(document.querySelector('.public-menu-item-submit')).toBeNull()
    expect(readPublicCart(LOC)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: t('he', 'close') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(readPublicCart(LOC)).toEqual([])
  })

  it('исчезнувший размер не уезжает в корзину и выбор остаётся за гостем', async () => {
    const { client } = await openConfigSheet()
    await updateMenu(client, [{ ...item,
      variants: [{ id: 'medium', name: 'Medium', price: 1800, is_default: false }] }, other])
    await waitFor(() => expect(sheetText()).toContain('Medium'))
    // Размер за гостя не выбираем: пока выбора нет, добавление недоступно
    expect(addButton()!).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Medium/ }))
    fireEvent.click(addButton()!)
    await waitFor(() => expect(readPublicCart(LOC)).toHaveLength(1))
    expect(readPublicCart(LOC)[0]).toMatchObject({ variantId: 'medium', unitPrice: 1800 })
  })

  it('исчезнувшая добавка не уезжает в корзину', async () => {
    const { client } = await openConfigSheet()
    fireEvent.click(screen.getByRole('button', { name: /Oat/ }))
    expect(sheetText()).toContain('Oat')
    await updateMenu(client, [{ ...item,
      modifier_groups: [{ ...item.modifier_groups[0],
        modifiers: [{ id: 'soy', name: 'Soy', price_delta: 300, is_default: false }] }] }, other])
    await waitFor(() => expect(sheetText()).toContain('Soy'))
    fireEvent.click(addButton()!)
    await waitFor(() => expect(readPublicCart(LOC)).toHaveLength(1))
    expect(readPublicCart(LOC)[0].modIds).toEqual([])
    expect(readPublicCart(LOC)[0].unitPrice).toBe(2000)
  })

  it('новая обязательная группа требует выбора гостя, а не добавляется молча', async () => {
    const { client } = await openConfigSheet()
    await updateMenu(client, [{ ...item, modifier_groups: [...item.modifier_groups, {
      id: 'sugar', name: 'Sugar', min_select: 1, max_select: 1,
      modifiers: [{ id: 'none', name: 'No sugar', price_delta: 0, is_default: true }],
    }] }, other])
    await waitFor(() => expect(sheetText()).toContain('Sugar'))
    expect(addButton()!).toBeDisabled()
    expect(readPublicCart(LOC)).toEqual([])
  })
})
