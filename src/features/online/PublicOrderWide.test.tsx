import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import PublicOrderPage from './PublicOrderPage'
import {
  fetchPublicMenu,
  fetchPublicStatus,
  submitPublicOrder,
  type PublicItem,
  type PublicMenu,
} from './publicApi'
import { PUBLIC_MENU_WIDE_QUERY } from './wideLayout'

// Настоящие страница, корзина и React Query; синтетические только API и экран.
vi.mock('./publicApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('./publicApi')>(),
  fetchPublicMenu: vi.fn(),
  fetchPublicStatus: vi.fn(),
  submitPublicOrder: vi.fn(),
}))

const LOC = 'c1000000-0000-4000-8000-000000000001'
const TABLE = 'c2000000-0000-4000-8000-000000000001'
const COFFEE: PublicItem = {
  id: 'coffee', name: 'Coffee', price: 1400, description: null, image_url: null,
  variants: [], modifier_groups: [],
}
const CAKE: PublicItem = { ...COFFEE, id: 'cake', name: 'Cake', price: 2200 }
const menu: PublicMenu = {
  location: {
    id: LOC, name: 'Wide Cafe', currency: 'ILS', is_open: true, accepting: true,
    modules: { online_orders: true },
    links: { instagram: 'https://instagram.com/widecafe', facebook: null, google_review: null },
  },
  categories: [
    { id: 'drinks', name: 'Drinks', items: [COFFEE] },
    { id: 'food', name: 'Food', items: [CAKE] },
  ],
}
const tableMenu: PublicMenu = {
  ...menu,
  location: { ...menu.location, modules: { online_orders: true, table_service: true } },
  order_context: { kind: 'table', label: '7', zone: null },
}

let client: QueryClient

/** Экран планшета: matchMedia отвечает «да» только широкой раскладке. */
function landscapeTablet(wide = true) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: wide && query === PUBLIC_MENU_WIDE_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

function renderAt(url: string) {
  window.history.pushState({}, '', url)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/order/:locId" element={<PublicOrderPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function addFromSheet(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(t('he', 'pubAdd')) }))
}

const capsuleName = new RegExp(t('he', 'pubShowItems'))

beforeEach(() => {
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  landscapeTablet()
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('guest menu on a landscape tablet', () => {
  it('keeps categories in a side column and opens the cart from a capsule with the total', async () => {
    vi.mocked(fetchPublicMenu).mockResolvedValue(menu)
    renderAt(`/order/${LOC}`)

    fireEvent.click(await screen.findByRole('button', { name: 'להזמין' }))

    const rail = await screen.findByRole('navigation', { name: t('he', 'categories') })
    // Ссылок на соцсети и отзыв в меню нет.
    expect(document.querySelector('a[href="https://instagram.com/widecafe"]')).not.toBeInTheDocument()
    // Пустая корзина — капсулы нет.
    expect(screen.queryByRole('button', { name: capsuleName })).not.toBeInTheDocument()

    fireEvent.click(within(rail).getByRole('button', { name: 'Food' }))
    // Категорию показывает колонка; заголовок над плитками только для скринридера.
    const heading = await screen.findByRole('heading', { name: 'Food', level: 2 })
    expect(heading.parentElement).toHaveClass('sr-only')
    expect(within(rail).getByRole('button', { name: 'Food' })).toHaveAttribute('aria-current', 'true')

    await addFromSheet(CAKE.name)

    const capsule = await screen.findByRole('button', { name: capsuleName })
    expect(capsule).toHaveClass('public-menu-cart-capsule')
    expect(capsule).toHaveTextContent(formatMoney(CAKE.price, 'he'))

    fireEvent.click(capsule)
    expect(await screen.findByRole('heading', { name: t('he', 'pubYourOrder'), level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `${t('he', 'edit')}: ${CAKE.name}` })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('he', 'pubContinueToPayment')) }))
    expect(await screen.findByRole('heading', { name: t('he', 'pubPaymentTitle'), level: 1 })).toBeInTheDocument()

    // С оплаты «Назад» — снова корзина, как на телефоне.
    fireEvent.click(screen.getByRole('button', { name: t('he', 'back') }))
    expect(await screen.findByRole('heading', { name: t('he', 'pubYourOrder'), level: 1 })).toBeInTheDocument()
  })

  it('shows no capsule on a view-only menu', async () => {
    vi.mocked(fetchPublicMenu).mockResolvedValue(menu)
    renderAt(`/order/${LOC}?browse=1`)

    expect(await screen.findByRole('navigation', { name: t('he', 'categories') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: capsuleName })).not.toBeInTheDocument()
  })

  it('opens the table confirmation from the capsule and sends the order', async () => {
    vi.mocked(fetchPublicMenu).mockResolvedValue(tableMenu)
    vi.mocked(submitPublicOrder).mockResolvedValue({ online_id: 'order-1', total: COFFEE.price, duplicate: false })
    vi.mocked(fetchPublicStatus).mockResolvedValue({
      status: 'new',
      reject_reason: null,
      total: COFFEE.price,
      daily_number: null,
      order_status: null,
      table_label: '7',
      created_at: new Date().toISOString(),
    })
    renderAt(`/order/${LOC}?table=${TABLE}&source=table_qr`)

    expect(await screen.findByRole('navigation', { name: t('he', 'categories') })).toBeInTheDocument()
    await addFromSheet(COFFEE.name)
    fireEvent.click(await screen.findByRole('button', { name: capsuleName }))

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(t('he', 'pubConfirmTableOrder')) }))

    await waitFor(() => expect(submitPublicOrder).toHaveBeenCalledWith(expect.objectContaining({
      loc: LOC,
      table_token: TABLE,
      order_channel: 'table_qr',
      items: [expect.objectContaining({ menu_item_id: COFFEE.id, qty: 1 })],
    })))
    expect(await screen.findByTestId('table-live-order-summary')).toBeInTheDocument()
  })
})

describe('wide layout query', () => {
  it('covers tablets in both orientations but not a phone on its side', () => {
    // Условие проверяем по смыслу: ширина портретного iPad mini и высота,
    // которой нет у телефона, повёрнутого боком.
    expect(PUBLIC_MENU_WIDE_QUERY).toBe('(min-width: 46rem) and (min-height: 30rem)')
    expect(PUBLIC_MENU_WIDE_QUERY).not.toMatch(/orientation/)
  })
})

describe('menu only mode', () => {
  it('invites to the menu, shows no cart and no Add button on the dish card', async () => {
    // public-menu отдаёт modules.online_orders = false и для режима
    // «Только меню» (183), и для точки без купленного заказа.
    vi.mocked(fetchPublicMenu).mockResolvedValue({
      ...menu,
      location: { ...menu.location, modules: { online_orders: false } },
    })
    renderAt(`/order/${LOC}`)

    expect(screen.queryByRole('button', { name: 'להזמין' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: t('he', 'pubViewMenu') }))

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(COFFEE.name) }))
    expect(await screen.findByRole('heading', { name: COFFEE.name, level: 3 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: new RegExp(t('he', 'pubAdd')) })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: capsuleName })).not.toBeInTheDocument()
  })
})

describe('cart pill photos on a landscape tablet', () => {
  it('shows up to three item photos instead of the count, newest first', async () => {
    const photo = (id: string): PublicItem => ({
      ...COFFEE, id, name: `Dish ${id}`, image_url: `https://cdn.test/${id}.webp`,
    })
    const dishes = ['a', 'b', 'c', 'd'].map(photo)
    vi.mocked(fetchPublicMenu).mockResolvedValue({
      ...menu,
      categories: [{ id: 'drinks', name: 'Drinks', items: dishes }],
    })
    renderAt(`/order/${LOC}?view=menu`)

    for (const dish of dishes) await addFromSheet(dish.name)

    const capsule = await screen.findByRole('button', { name: capsuleName })
    const thumbs = [...capsule.querySelectorAll('.public-menu-cart-thumbs img')].map((img) => img.getAttribute('src'))
    expect(thumbs).toEqual(['https://cdn.test/d.webp', 'https://cdn.test/c.webp', 'https://cdn.test/b.webp'])
    expect(capsule.querySelector('.public-menu-checkout-submit-count')).not.toBeInTheDocument()
    // Количество не пропало: оно в доступном имени кнопки.
    expect(capsule).toHaveAccessibleName(new RegExp(`: 4, `))

    fireEvent.click(capsule)
    const pill = await screen.findByRole('button', { name: new RegExp(t('he', 'pubContinueToPayment')) })
    expect(pill.querySelectorAll('.public-menu-cart-thumbs img')).toHaveLength(3)
  })
})

describe('guest menu on a phone', () => {
  it('shows plain tiles and keeps the category and cart titles for screen readers only', async () => {
    vi.mocked(window.matchMedia).mockRestore()
    landscapeTablet(false)
    vi.mocked(fetchPublicMenu).mockResolvedValue(menu)
    renderAt(`/order/${LOC}?view=menu`)

    // Категорию показывает активный чип; крупный заголовок не рисуется.
    const heading = await screen.findByRole('heading', { name: 'Drinks', level: 2 })
    expect(heading.parentElement).toHaveClass('sr-only')
    expect(screen.queryByRole('navigation', { name: t('he', 'categories') })).not.toBeInTheDocument()
    expect(document.querySelector('a[href="https://instagram.com/widecafe"]')).not.toBeInTheDocument()

    // Плитка открывается тапом целиком — без кружка «+»/«···».
    const tile = screen.getByRole('button', { name: new RegExp(COFFEE.name) })
    expect(tile).not.toHaveTextContent('+')
    expect(tile).not.toHaveTextContent('⋯')

    await addFromSheet(COFFEE.name)
    fireEvent.click(await screen.findByRole('button', { name: capsuleName }))

    const cartTitle = await screen.findByRole('heading', { name: t('he', 'pubYourOrder'), level: 1 })
    expect(cartTitle.closest('.public-menu-checkout-intro')).toHaveClass('sr-only')
  })
})
