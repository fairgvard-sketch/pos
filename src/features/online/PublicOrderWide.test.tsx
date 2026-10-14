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
  it('shows categories as a column and the order as a panel that goes straight to payment', async () => {
    vi.mocked(fetchPublicMenu).mockResolvedValue(menu)
    renderAt(`/order/${LOC}`)

    fireEvent.click(await screen.findByRole('button', { name: 'להזמין' }))

    const rail = await screen.findByRole('navigation', { name: t('he', 'categories') })
    const panel = screen.getByRole('complementary', { name: t('he', 'pubYourOrder') })
    expect(within(panel).getByText(t('he', 'pubPanelEmpty'))).toBeInTheDocument()
    // Нижней кнопки корзины нет: её роль у панели.
    expect(screen.queryByRole('button', { name: new RegExp(t('he', 'pubShowItems')) })).not.toBeInTheDocument()

    fireEvent.click(within(rail).getByRole('button', { name: 'Food' }))
    expect(await screen.findByRole('heading', { name: 'Food', level: 2 })).toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: 'Food' })).toHaveAttribute('aria-current', 'true')

    await addFromSheet(CAKE.name)

    expect(await within(panel).findByRole('button', { name: `${t('he', 'edit')}: ${CAKE.name}` })).toBeInTheDocument()
    expect(within(panel).getAllByText(formatMoney(CAKE.price, 'he')).length).toBeGreaterThan(0)

    fireEvent.click(within(panel).getByRole('button', { name: t('he', 'pubContinueToPayment') }))

    // Шаг корзины пропущен: она уже была на экране в панели.
    expect(await screen.findByRole('heading', { name: t('he', 'pubPaymentTitle'), level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: t('he', 'pubYourOrder'), level: 1 })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: t('he', 'back') }))
    const panelAgain = await screen.findByRole('complementary', { name: t('he', 'pubYourOrder') })
    expect(within(panelAgain).getByRole('button', { name: `${t('he', 'edit')}: ${CAKE.name}` })).toBeInTheDocument()
  })

  it('has no order panel on a view-only menu', async () => {
    vi.mocked(fetchPublicMenu).mockResolvedValue(menu)
    renderAt(`/order/${LOC}?browse=1`)

    expect(await screen.findByRole('navigation', { name: t('he', 'categories') })).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: t('he', 'pubYourOrder') })).not.toBeInTheDocument()
  })

  it('sends a table order from the panel and gives the next order a new client_uuid', async () => {
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

    await addFromSheet(COFFEE.name)
    const panel = await screen.findByRole('complementary', { name: t('he', 'pubYourOrder') })
    fireEvent.click(within(panel).getByRole('button', { name: t('he', 'pubConfirmTableOrder') }))

    await waitFor(() => expect(submitPublicOrder).toHaveBeenCalledTimes(1))
    const first = vi.mocked(submitPublicOrder).mock.calls[0][0]
    expect(first).toMatchObject({
      loc: LOC,
      table_token: TABLE,
      order_channel: 'table_qr',
      items: [expect.objectContaining({ menu_item_id: COFFEE.id, qty: 1 })],
    })
    expect(await screen.findByTestId('table-live-order-summary')).toBeInTheDocument()

    // Дозаказ: панель собрана заново, поэтому UUID новый — иначе сервер
    // по идемпотентности вернул бы первую заявку вместо второй.
    fireEvent.click(screen.getByRole('tab', { name: t('he', 'guestMenuTab') }))
    await addFromSheet(COFFEE.name)
    const panelAgain = await screen.findByRole('complementary', { name: t('he', 'pubYourOrder') })
    fireEvent.click(within(panelAgain).getByRole('button', { name: t('he', 'pubConfirmTableOrder') }))

    await waitFor(() => expect(submitPublicOrder).toHaveBeenCalledTimes(2))
    const second = vi.mocked(submitPublicOrder).mock.calls[1][0]
    expect(second.client_uuid).not.toBe(first.client_uuid)
  })
})
