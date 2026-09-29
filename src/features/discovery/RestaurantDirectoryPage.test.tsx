import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RestaurantDetailPage,
  RestaurantDirectoryHome,
} from './RestaurantDirectoryPage'
import {
  fetchPublicRestaurant,
  fetchPublicRestaurants,
  type PublicRestaurant,
} from '../online/publicApi'

vi.mock('../online/publicApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../online/publicApi')>(),
  fetchPublicRestaurant: vi.fn(),
  fetchPublicRestaurants: vi.fn(),
}))

const bulochka: PublicRestaurant = {
  id: 'fe2eebf0-65e3-45b4-a81f-331359d71955',
  slug: 'bulochka',
  name: 'Bulochka',
  address: 'Pinsker 29, Tel Aviv',
  city: 'Tel Aviv',
  country_code: 'IL',
  cuisine: ['Bakery', 'Coffee'],
  summary: 'Fresh pastries and coffee.',
  hero_url: null,
  logo_url: null,
  price_level: 2,
  rating: { value: 4.8, count: 320, source: 'demo' },
  features: {
    menu: true,
    ordering: true,
    table_service: false,
    reservations: false,
  },
}

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(fetchPublicRestaurants).mockResolvedValue([bulochka])
  vi.mocked(fetchPublicRestaurant).mockResolvedValue(bulochka)
})
afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.clearAllMocks()
})

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<RestaurantDirectoryHome />} />
          <Route path="/restaurants/:slug" element={<RestaurantDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ANGLE restaurant directory', () => {
  it('lists the existing Bulochka location and labels synthetic ratings as demo', async () => {
    renderAt('/')

    const card = await screen.findByRole('link', { name: /Bulochka/i })
    expect(card).toHaveAttribute('href', '/restaurants/bulochka')
    expect(screen.getByText('Demo')).toBeInTheDocument()
    expect(screen.getByText('Pinsker 29, Tel Aviv')).toBeInTheDocument()
  })

  it('filters by restaurant and cuisine without another server request', async () => {
    renderAt('/')
    await screen.findByRole('heading', { name: 'Bulochka' })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search restaurants' }), {
      target: { value: 'sushi' },
    })
    expect(screen.queryByRole('heading', { name: 'Bulochka' })).not.toBeInTheDocument()
    expect(screen.getByText('No restaurants match this search.')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search restaurants' }), {
      target: { value: 'coffee' },
    })
    expect(screen.getByRole('heading', { name: 'Bulochka' })).toBeInTheDocument()
    expect(fetchPublicRestaurants).toHaveBeenCalledTimes(1)
  })

  it('opens the venue page, links to the real menu and never presents demo data as Google', async () => {
    renderAt('/restaurants/bulochka')

    expect(await screen.findByRole('heading', { name: 'Bulochka' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View menu/i }))
      .toHaveAttribute('href', '/order/bulochka')
    expect(screen.getByText(/not Google reviews/i)).toBeInTheDocument()
    expect(screen.getByText('Live Table pilot')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Reserve/i })).not.toBeInTheDocument()
  })
})
