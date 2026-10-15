import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PublicOrderPage from './PublicOrderPage'
import { writePublicCart, type StoredPublicCartLine } from './publicCart'
import { fetchPublicMenu, type PublicItem, type PublicMenu } from './publicApi'
import { t, type Lang } from '../../lib/i18n'

// Настоящие страница, React Query и корзина; только API — синтетика.
vi.mock('./publicApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('./publicApi')>(),
  fetchPublicMenu: vi.fn(), fetchPublicStatus: vi.fn(), submitPublicOrder: vi.fn(),
}))

const LOC = '22222222-2222-4222-8222-222222222222'
const cappuccino: PublicItem = {
  id: 'cap', name: 'קפוצ׳ינו', price: 1400, description: 'אספרסו וקצף חלב', image_url: null,
  translations: {
    en: { name: 'Cappuccino', description: 'Espresso with milk foam' },
    ru: { name: 'Капучино', description: 'Эспрессо с молочной пенкой' },
  },
  variants: [],
  modifier_groups: [],
}
const menu = (languages?: Lang[]): PublicMenu => ({
  location: {
    id: LOC, name: 'בולוצ׳קה', currency: 'ILS', is_open: true, accepting: true,
    modules: { online_orders: true }, languages,
  },
  categories: [{
    id: 'hot', name: 'משקאות חמים',
    translations: { en: { name: 'Hot drinks' }, ru: { name: 'Горячие напитки' } },
    items: [cappuccino],
  }],
})
const clients: QueryClient[] = []

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', `/order/${LOC}`)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected real network request') }))
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.lang = 'he'
  document.documentElement.dir = 'rtl'
})

function renderPage(current: PublicMenu, search = '') {
  window.history.replaceState({}, '', `/order/${LOC}${search}`)
  vi.mocked(fetchPublicMenu).mockResolvedValue(current)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/order/${LOC}${search}`]}>
        <Routes><Route path="/order/:locId" element={<PublicOrderPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('язык QR-меню', () => {
  it('гость выбирает английский на обложке и читает меню по-английски слева направо', async () => {
    renderPage(menu(['he', 'en', 'ru']))

    // Телефон jsdom — английский, и точка английский включила: догадка
    // применяется сразу после загрузки меню
    const switcher = await screen.findByRole('group', { name: t('en', 'guestLanguage') })
    expect(switcher).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Русский' }))
    expect(await screen.findByRole('button', { name: t('ru', 'pubOrderNow') })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    fireEvent.click(await screen.findByRole('button', { name: t('en', 'pubOrderNow') }))
    expect(document.documentElement.dir).toBe('ltr')
    expect(document.documentElement.lang).toBe('en')
    expect(await screen.findByRole('heading', { name: t('en', 'pubHowToEat') })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: t('en', 'pubTypeTakeaway') }))

    expect(await screen.findByRole('heading', { name: 'Hot drinks', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cappuccino/ })).toHaveTextContent('Espresso with milk foam')
    expect(localStorage.getItem('kassa-public-lang')).toBe('en')
  })

  it('смена языка в шапке переименовывает строки корзины, не трогая цену', async () => {
    const line: StoredPublicCartLine = {
      key: 'saved', itemId: 'cap', name: 'קפוצ׳ינו', variantId: null, variantName: null,
      modIds: [], modNames: [], unitPrice: 1400, qty: 1,
    }
    writePublicCart(LOC, [line])
    localStorage.setItem('kassa-public-lang', 'he')
    renderPage(menu(['he', 'en']), '?view=menu')

    await screen.findByRole('heading', { name: 'משקאות חמים', level: 2 })
    expect(document.documentElement.dir).toBe('rtl')
    fireEvent.click(screen.getByRole('button', { name: `${t('he', 'guestLanguage')}: עברית` }))
    // Русский точка не включила — в списке его нет
    expect(screen.queryByRole('menuitemradio', { name: 'Русский' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'English' }))

    await screen.findByRole('heading', { name: 'Hot drinks', level: 2 })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'pubShowItems')) }))
    await waitFor(() => {
      expect(document.querySelector('.public-menu-cart-lines')?.textContent).toContain('Cappuccino')
    })
    // Переименование — не изменение цены: гостю нечего сообщать
    expect(screen.queryByText(t('en', 'pubCartRepriced'))).not.toBeInTheDocument()
  })

  it('без включённых языков переключателя нет, а английский телефон не ломает RTL', async () => {
    renderPage(menu(undefined))

    expect(await screen.findByRole('button', { name: t('he', 'pubOrderNow') })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: t('he', 'guestLanguage') })).not.toBeInTheDocument()
    expect(document.documentElement.dir).toBe('rtl')
    expect(document.documentElement.lang).toBe('he')
  })

  it('киоск начинает на иврите и не запоминает выбор гостя', async () => {
    localStorage.setItem('kassa-public-lang', 'ru')
    renderPage(menu(['he', 'en', 'ru']), '?kiosk=1')

    expect(await screen.findByRole('button', { name: t('he', 'pubOrderNow') })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(await screen.findByRole('button', { name: t('en', 'pubOrderNow') })).toBeInTheDocument()
    expect(localStorage.getItem('kassa-public-lang')).toBe('ru')
  })

  it('язык из ссылки открывает меню сразу на нём', async () => {
    renderPage(menu(['he', 'en', 'ru']), '?lang=ru')

    expect(await screen.findByRole('button', { name: t('ru', 'pubOrderNow') })).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('ru')
  })
})
