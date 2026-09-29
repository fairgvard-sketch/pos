import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../lib/i18n'
import PublicOrderPage from './PublicOrderPage'
import {
  fetchPublicMenu,
  fetchPublicStatus,
  submitPublicOrder,
  submitPublicServiceRequest,
  type PublicMenu,
} from './publicApi'
import { writePublicCart } from './publicCart'

vi.mock('./publicApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('./publicApi')>(),
  fetchPublicMenu: vi.fn(),
  fetchPublicStatus: vi.fn(),
  submitPublicOrder: vi.fn(),
  submitPublicServiceRequest: vi.fn(),
}))

const LOC = 'b1000000-0000-4000-8000-000000000001'
const TABLE = 'b2000000-0000-4000-8000-000000000001'
const CLIENT = 'b3000000-0000-4000-8000-000000000001'
const CLIENT_2 = 'b3000000-0000-4000-8000-000000000002'
const ORDER = 'b4000000-0000-4000-8000-000000000001'
const COFFEE = {
  id: 'coffee',
  name: 'Coffee',
  price: 1400,
  description: null,
  image_url: null,
  variants: [],
  modifier_groups: [],
}
const menu: PublicMenu = {
  location: {
    id: LOC,
    name: 'Casa Test',
    currency: 'ILS',
    is_open: true,
    accepting: true,
    logo_url: 'https://cdn.test/casa-test-logo.png',
    modules: { online_orders: true, table_service: true },
  },
  order_context: { kind: 'table', label: '12', zone: 'Main' },
  categories: [{ id: 'popular', name: 'Popular', items: [] }],
}

let client: QueryClient

beforeEach(() => {
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  vi.mocked(fetchPublicMenu).mockResolvedValue(menu)
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'vibrate')
})

function renderTable() {
  window.history.pushState({}, '', `/order/${LOC}?table=${TABLE}&source=table_qr`)
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/order/${LOC}?table=${TABLE}&source=table_qr`]}>
        <Routes><Route path="/order/:locId" element={<PublicOrderPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ANGLE Guest table service', () => {
  it('table QR opens the menu directly and exposes service without another hero tap', async () => {
    renderTable()

    expect(await screen.findByRole('heading', { name: 'Popular', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'להזמין' })).not.toBeInTheDocument()
    expect(document.querySelector('.angle-live-table-mark img')).toHaveAttribute(
      'src',
      menu.location.logo_url,
    )
    const search = screen.getByRole('searchbox', { name: t('he', 'guestSearchMenu') })
    fireEvent.change(search, { target: { value: 'missing dish' } })
    expect(screen.getByText(t('he', 'guestNoDishes'))).toBeInTheDocument()

    expect(screen.getAllByRole('tab')).toHaveLength(3)
    fireEvent.click(screen.getByRole('tab', { name: t('he', 'serviceTab') }))
    expect(await screen.findByRole('heading', { name: t('he', 'serviceCallWaiter'), level: 1 })).toBeInTheDocument()
    expect(screen.getByText(`${t('he', 'pubTable')} 12`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('he', 'serviceBread') })).not.toBeInTheDocument()
    expect(document.querySelectorAll('.angle-table-service-quick')).toHaveLength(3)
    expect(screen.getByRole('button', { name: t('he', 'serviceNextCourse') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('he', 'serviceHoldCourse') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('he', 'serviceBill') })).toBeInTheDocument()
  })

  it('uses the whole Live Table item row without a separate black action tile', async () => {
    vi.mocked(fetchPublicMenu).mockResolvedValue({
      ...menu,
      categories: [{
        id: 'popular',
        name: 'Popular',
        items: [{
          ...COFFEE,
          modifier_groups: [{
            id: 'milk',
            name: 'Milk',
            min_select: 0,
            max_select: 1,
            modifiers: [{
              id: 'oat',
              name: 'Oat milk',
              price_delta: 200,
              is_default: false,
            }],
          }],
        }],
      }],
    })
    renderTable()

    const itemRow = await screen.findByRole('button', { name: new RegExp(COFFEE.name) })
    expect(itemRow.querySelector('.public-menu-item-action')).not.toBeInTheDocument()

    fireEvent.click(itemRow)
    expect(await screen.findByText('Oat milk')).toBeInTheDocument()
  })

  it('opens the cart from Your Order, confirms it, and replaces it with status', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(CLIENT)
    vi.mocked(fetchPublicMenu).mockResolvedValue({
      ...menu,
      categories: [{ id: 'popular', name: 'Popular', items: [COFFEE] }],
    })
    writePublicCart(LOC, [{
      key: 'coffee::::',
      itemId: COFFEE.id,
      name: COFFEE.name,
      variantId: null,
      variantName: null,
      modIds: [],
      modNames: [],
      unitPrice: COFFEE.price,
      qty: 1,
    }])
    vi.mocked(submitPublicOrder).mockResolvedValue({
      online_id: ORDER,
      total: COFFEE.price,
      duplicate: false,
    })
    vi.mocked(fetchPublicStatus).mockResolvedValue({
      status: 'new',
      reject_reason: null,
      total: COFFEE.price,
      daily_number: null,
      order_status: null,
      table_label: '12',
      created_at: new Date().toISOString(),
    })
    renderTable()

    const orderTab = await screen.findByRole('tab', { name: t('he', 'pubYourOrder') })
    fireEvent.click(orderTab)

    expect(orderTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: t('he', 'pubYourOrder') })).toBeInTheDocument()
    expect(screen.getByText(COFFEE.name)).toBeInTheDocument()
    expect(screen.getByRole('button', {
      name: new RegExp(t('he', 'pubConfirmTableOrder')),
    })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: t('he', 'pubPaymentTitle') })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', {
      name: new RegExp(t('he', 'pubConfirmTableOrder')),
    }))

    await waitFor(() => expect(submitPublicOrder).toHaveBeenCalledWith(expect.objectContaining({
      loc: LOC,
      client_uuid: CLIENT,
      name: '',
      phone: '',
      table_token: TABLE,
      order_channel: 'table_qr',
      items: [{
        menu_item_id: COFFEE.id,
        variant_id: null,
        modifier_ids: [],
        qty: 1,
        notes: null,
      }],
    })))
    expect(await screen.findByTestId('table-live-order-summary')).toBeInTheDocument()
    expect(screen.getByText(`1 × ${COFFEE.name}`)).toBeInTheDocument()
    expect(screen.queryByText(t('he', 'pubWaiting'))).not.toBeInTheDocument()
    expect(screen.queryByLabelText(t('he', 'pubOrderProgress'))).not.toBeInTheDocument()
    expect(orderTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: t('he', 'pubNewOrder') })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: t('he', 'pubPaymentTitle') })).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('kassa-public-active') ?? '{}')).toMatchObject({
      clientUuid: CLIENT,
      locId: LOC,
      items: [{ itemId: COFFEE.id, qty: 1 }],
    })
  })

  it('restores the submitted item summary from the server after reload', async () => {
    localStorage.setItem('kassa-public-active', JSON.stringify({
      clientUuid: CLIENT,
      locId: LOC,
    }))
    vi.mocked(fetchPublicMenu).mockResolvedValue({
      ...menu,
      categories: [{ id: 'popular', name: 'Popular', items: [COFFEE] }],
    })
    vi.mocked(fetchPublicStatus).mockResolvedValue({
      status: 'accepted',
      reject_reason: null,
      total: COFFEE.price + 200,
      items: [{
        menu_item_id: COFFEE.id,
        variant_id: null,
        modifier_ids: ['oat'],
        qty: 1,
        notes: null,
        name: COFFEE.name,
        variant_name: null,
        unit_price: COFFEE.price + 200,
        line_total: COFFEE.price + 200,
        mods: [{ id: 'oat', name: 'Oat milk', price_delta: 200 }],
      }],
      daily_number: null,
      order_status: 'open',
      table_label: '12',
      created_at: new Date().toISOString(),
    })

    renderTable()
    fireEvent.click(await screen.findByRole('tab', {
      name: new RegExp(t('he', 'pubYourOrder')),
    }))

    expect(await screen.findByTestId('table-live-order-summary')).toBeInTheDocument()
    expect(screen.getByText(`1 × ${COFFEE.name}`)).toBeInTheDocument()
    expect(screen.getByText('Oat milk')).toBeInTheDocument()
    expect(screen.queryByLabelText(t('he', 'pubOrderProgress'))).not.toBeInTheDocument()
  })

  it('sends repeatable water requests with tactile feedback and no persistent status', async () => {
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate })
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(CLIENT)
      .mockReturnValueOnce(CLIENT_2)
    vi.mocked(submitPublicServiceRequest).mockResolvedValue({
      request_id: 'b4000000-0000-4000-8000-000000000001',
      client_uuid: CLIENT,
      status: 'new',
      duplicate: false,
    })
    renderTable()

    const serviceTab = await screen.findByRole('tab', { name: t('he', 'serviceTab') })
    fireEvent.click(serviceTab)
    const waterButton = screen.getByRole('button', { name: t('he', 'serviceWater') })
    expect(waterButton).toHaveAttribute('switch')
    expect(waterButton).toHaveAttribute('type', 'checkbox')
    fireEvent.click(waterButton)
    fireEvent.click(waterButton)

    expect(waterButton).not.toBeDisabled()
    expect(vibrate).toHaveBeenNthCalledWith(1, 18)
    expect(vibrate).toHaveBeenNthCalledWith(2, 18)
    await waitFor(() => expect(submitPublicServiceRequest).toHaveBeenCalledTimes(2))
    expect(submitPublicServiceRequest).toHaveBeenNthCalledWith(1, {
      loc: LOC,
      table_token: TABLE,
      client_uuid: CLIENT,
      kind: 'water',
    })
    expect(submitPublicServiceRequest).toHaveBeenNthCalledWith(2, {
      loc: LOC,
      table_token: TABLE,
      client_uuid: CLIENT_2,
      kind: 'water',
    })
    expect(screen.queryByText(t('he', 'serviceSentGuest'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('he', 'serviceAcceptedGuest'))).not.toBeInTheDocument()
    expect(document.querySelector('.angle-table-service-activity')).not.toBeInTheDocument()
    expect(serviceTab.querySelector('.angle-live-table-tab-count')).not.toBeInTheDocument()
  })

  it('ignores legacy tracked confirmations and keeps the service tab clean', async () => {
    localStorage.setItem('angle-table-service-requests-v1', JSON.stringify({
      locId: LOC,
      tableToken: TABLE,
      requests: [{
        client_uuid: CLIENT,
        kind: 'bill',
        status: 'completed',
        table_label: '12',
        created_at: new Date().toISOString(),
        accepted_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }],
    }))
    renderTable()

    const serviceButton = await screen.findByRole('tab', { name: t('he', 'serviceTab') })
    expect(serviceButton.querySelector('.angle-live-table-tab-count')).not.toBeInTheDocument()
    fireEvent.click(serviceButton)
    expect(await screen.findByRole('button', { name: t('he', 'serviceBill') })).toBeInTheDocument()
    expect(screen.queryByText(t('he', 'serviceCompletedGuest'))).not.toBeInTheDocument()
    expect(document.querySelector('.angle-table-service-activity')).not.toBeInTheDocument()
  })
})
