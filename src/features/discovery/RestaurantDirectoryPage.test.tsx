import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  coordinates: { lat: 32.0913157, lng: 34.8841284 },
  cuisine: ['Bakery', 'Coffee'],
  summary: 'Fresh pastries and coffee.',
  hero_url: null,
  logo_url: null,
  price_level: 2,
  hours: {
    0: [['08:00', '20:00']],
    1: [['08:00', '20:00']],
    2: [['08:00', '20:00']],
    3: [['08:00', '20:00']],
    4: [['08:00', '20:00']],
    5: [['08:00', '20:00']],
    6: [['08:00', '20:00']],
  },
  timezone: 'Asia/Jerusalem',
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
  localStorage.clear()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(fetchPublicRestaurants).mockResolvedValue([bulochka])
  vi.mocked(fetchPublicRestaurant).mockResolvedValue(bulochka)
})
afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
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

    const restaurantLinks = await screen.findAllByRole('link', { name: /Bulochka/i })
    expect(restaurantLinks).toHaveLength(2)
    expect(restaurantLinks.every((link) => link.getAttribute('href') === '/restaurants/bulochka')).toBe(true)
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

  it('uses browser location only after a guest asks and then shows the distance', async () => {
    const getCurrentPosition = vi.fn().mockImplementation((onSuccess) => onSuccess({
      coords: { latitude: 32.09, longitude: 34.88 },
    }))
    const originalGeolocation = navigator.geolocation
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition },
    })

    try {
      renderAt('/')
      await screen.findByRole('heading', { name: 'Bulochka' })
      expect(getCurrentPosition).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: /Choose your location: Tel Aviv/i }))
      expect(screen.getByRole('dialog', { name: 'Choose your location' })).toBeInTheDocument()
      expect(getCurrentPosition).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Use my current location' }))

      expect(getCurrentPosition).toHaveBeenCalledTimes(1)
      expect(await screen.findByText(/km$/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Choose your location: My location/i })).toBeInTheDocument()
    } finally {
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: originalGeolocation,
      })
    }
  })

  it('lets a guest search and select any address explicitly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        place_id: 123,
        osm_type: 'way',
        osm_id: 456,
        lat: '32.0631',
        lon: '34.7738',
        display_name: 'Rothschild Boulevard 1, Tel Aviv, Israel',
      }],
    })
    vi.stubGlobal('fetch', fetchMock)

    renderAt('/')
    await screen.findByRole('heading', { name: 'Bulochka' })
    fireEvent.click(screen.getByRole('button', { name: /Choose your location: Tel Aviv/i }))
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /Tel Aviv.*Israel/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add address' }))

    fireEvent.change(screen.getByRole('textbox', { name: 'Address' }), {
      target: { value: 'Rothschild 1, Tel Aviv' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Find address' }))

    const result = await screen.findByRole('button', {
      name: /Select address: Rothschild Boulevard 1/i,
    })
    fireEvent.click(result)

    expect(screen.getByRole('button', {
      name: /Choose your location: Rothschild Boulevard 1/i,
    })).toBeInTheDocument()
    expect(screen.getByText(/km$/i)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('q=Rothschild+1%2C+Tel+Aviv')
  })

  it('opens the venue page with distance, cuisine, hours and a working QR action', async () => {
    renderAt('/restaurants/bulochka')

    expect(await screen.findByRole('heading', { name: 'Bulochka' })).toBeInTheDocument()
    expect(screen.getByText(/km$/i)).toBeInTheDocument()
    expect(screen.getByText('Bakery · Coffee')).toBeInTheDocument()
    expect(screen.getByLabelText('Price level 2 / 4')).toHaveTextContent('₪₪')
    const hours = screen.getByLabelText('Opening hours')
    expect(within(hours).getByText('08:00–20:00')).toBeInTheDocument()
    const scanButton = screen.getByRole('button', { name: /Scan QR menu/i })
    expect(hours.compareDocumentPosition(scanButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('link', { name: /^Menu$/i }))
      .toHaveAttribute('href', '/order/bulochka?view=menu')
    expect(screen.getByRole('link', { name: /View menu/i }))
      .toHaveAttribute('href', '/order/bulochka?view=menu')
    expect(screen.getByText(/not Google reviews/i)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Reserve/i })).not.toBeInTheDocument()

    fireEvent.click(scanButton)
    expect(screen.getByRole('dialog', { name: 'Scan QR menu' })).toBeInTheDocument()
    expect(await screen.findByText(/not supported in this browser/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Scan from photo/i })).toBeInTheDocument()
    const photoInput = screen.getByLabelText('Scan from photo')
    expect(photoInput).toHaveAttribute('accept', 'image/*')
    expect(photoInput).toHaveAttribute('capture', 'environment')
  })
})
