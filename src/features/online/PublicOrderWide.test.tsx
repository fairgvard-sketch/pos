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

/** Экран альбомного планшета: matchMedia отвечает «да» только широкой раскладке. */
function landscapeTablet() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query === PUBLIC_MENU_WIDE_QUERY,
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
    // Пустая корзина — капсулы нет.
    expect(screen.queryByRole('button', { name: capsuleName })).not.toBeInTheDocument()

    fireEvent.click(within(rail).getByRole('button', { name: 'Food' }))
    expect(await screen.findByRole('heading', { name: 'Food', level: 2 })).toBeInTheDocument()
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
