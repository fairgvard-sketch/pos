import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../lib/i18n'
import PublicOrderPage from './PublicOrderPage'
import {
  fetchPublicMenu,
  fetchPublicStatus,
  fetchPublicServiceRequest,
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
  fetchPublicServiceRequest: vi.fn(),
  submitPublicServiceRequest: vi.fn(),
}))

const LOC = 'b1000000-0000-4000-8000-000000000001'
const TABLE = 'b2000000-0000-4000-8000-000000000001'
const CLIENT = 'b3000000-0000-4000-8000-000000000001'
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
    const search = screen.getByRole('searchbox', { name: t('he', 'guestSearchMenu') })
    fireEvent.change(search, { target: { value: 'missing dish' } })
    expect(screen.getByText(t('he', 'guestNoDishes'))).toBeInTheDocument()

    expect(screen.getAllByRole('tab')).toHaveLength(3)
    fireEvent.click(screen.getByRole('tab', { name: t('he', 'serviceTab') }))
    expect(await screen.findByRole('heading', { name: t('he', 'serviceCallWaiter'), level: 1 })).toBeInTheDocument()
    expect(screen.getByText(`${t('he', 'pubTable')} 12`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('he', 'serviceBread') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('he', 'serviceNextCourse') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('he', 'serviceHoldCourse') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('he', 'serviceBill') })).toBeInTheDocument()
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
    expect(await screen.findByText(t('he', 'pubWaiting'))).toBeInTheDocument()
    expect(orderTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: t('he', 'pubNewOrder') })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: t('he', 'pubPaymentTitle') })).not.toBeInTheDocument()
  })

  it('sends water optimistically and then shows the accepted server state', async () => {
    let resolveSubmit!: (value: Awaited<ReturnType<typeof submitPublicServiceRequest>>) => void
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(CLIENT)
    vi.mocked(submitPublicServiceRequest).mockImplementation(() => new Promise((resolve) => {
      resolveSubmit = resolve
    }))
    vi.mocked(fetchPublicServiceRequest).mockResolvedValue({
      client_uuid: CLIENT,
      kind: 'water',
      status: 'accepted',
      table_label: '12',
      created_at: new Date().toISOString(),
      accepted_at: new Date().toISOString(),
      completed_at: null,
    })
    renderTable()

    fireEvent.click(await screen.findByRole('tab', { name: t('he', 'serviceTab') }))
    fireEvent.click(screen.getByRole('button', { name: t('he', 'serviceWater') }))

    expect(screen.getByText(t('he', 'serviceSentGuest'))).toBeInTheDocument()
    await act(async () => {
      resolveSubmit({
        request_id: 'b4000000-0000-4000-8000-000000000001',
        client_uuid: CLIENT,
        status: 'new',
        duplicate: false,
      })
    })
    await waitFor(() => expect(screen.getAllByText(t('he', 'serviceAcceptedGuest'))).not.toHaveLength(0))
    expect(submitPublicServiceRequest).toHaveBeenCalledWith({
      loc: LOC,
      table_token: TABLE,
      client_uuid: CLIENT,
      kind: 'water',
    })
  })

  it('keeps the completed confirmation visible without counting it as active', async () => {
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
    expect(serviceButton).not.toHaveTextContent('1')
    fireEvent.click(serviceButton)
    expect(await screen.findByText(t('he', 'serviceCompletedGuest'))).toBeInTheDocument()
  })
})
