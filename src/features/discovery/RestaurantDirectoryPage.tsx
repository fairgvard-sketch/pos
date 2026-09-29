import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  fetchPublicRestaurant,
  fetchPublicRestaurants,
  type PublicRestaurant,
} from '../online/publicApi'
import { searchAddresses, type AddressSearchResult } from './geocoding'

const fallbackHero = '/menu-backgrounds/ivory-food.webp'

const discoveryCopy = {
  en: {
    area: 'Current area: Tel Aviv', searchRegion: 'Find a restaurant',
    searchPlaceholder: 'Search restaurants, cuisine...', searchLabel: 'Search restaurants',
    filters: 'Restaurant filters', near: 'Near you', bookmarks: 'Bookmarks',
    reservations: 'Reservations', eyebrow: 'ANGLE restaurants', loading: 'Loading restaurants…',
    loadError: 'Restaurants could not be loaded.', retry: 'Try again',
    empty: 'No restaurants match this search.', navigation: 'Main navigation', home: 'Home',
    restaurants: 'Restaurants', profile: 'Profile', menuAvailable: 'Menu available',
    live: 'Live', map: 'Restaurant map', chooseLocation: 'Choose location',
    changeLocation: 'Change location', locating: 'Locating…', yourLocation: 'My location',
    locationUnavailable: 'Location unavailable', locationTitle: 'Choose your location',
    locationIntro: 'Use your current position or enter any address.', close: 'Close',
    useCurrentLocation: 'Use my current location', currentLocationNote: 'Uses your device location only after permission.',
    orEnterAddress: 'or enter an address', addressLabel: 'Address',
    addressPlaceholder: 'Street, city or place', findAddress: 'Find address',
    searchingAddresses: 'Searching…', addressEmpty: 'No matching address found.',
    addressError: 'Address search is unavailable. Try again.', selectAddress: 'Select address',
    addressPrivacy: 'The search text is sent to OpenStreetMap only after you press Find.',
    kilometres: 'km',
    restaurant: 'Restaurant', demo: 'Demo', priceLevel: 'Price level', back: 'Back',
    logo: 'logo', sections: 'Restaurant sections', menu: 'Menu', liveTable: 'Live Table',
    photos: 'Photos', reviews: 'Reviews', info: 'Info', favourite: 'Save restaurant',
    reserve: 'Reserve', availableAtTable: 'Available at your table', pilot: 'Live Table pilot',
    scan: 'Scan the QR at your table', liveAvailable:
      'Order, follow every dish, call a waiter and request the bill from one screen.',
    livePilot: 'The menu is live now. Waiter requests and table service will appear here when the venue switches to table mode.',
    demoNote: (rating: string) => `★ The ${rating} rating and review count are demo data for the ANGLE prototype, not Google reviews.`,
    viewMenu: 'View menu', reserveTable: 'Reserve a table', loadingOne: 'Loading restaurant…',
    unavailable: 'This restaurant is not available.', backToRestaurants: 'Back to restaurants',
  },
  he: {
    area: 'האזור הנוכחי: תל אביב', searchRegion: 'חיפוש מסעדה',
    searchPlaceholder: 'חיפוש מסעדה או סוג מטבח...', searchLabel: 'חיפוש מסעדות',
    filters: 'מסנני מסעדות', near: 'קרוב אליי', bookmarks: 'שמורים',
    reservations: 'הזמנות', eyebrow: 'מסעדות ANGLE', loading: 'טוענים מסעדות…',
    loadError: 'לא הצלחנו לטעון את המסעדות.', retry: 'נסו שוב',
    empty: 'לא נמצאו מסעדות שמתאימות לחיפוש.', navigation: 'ניווט ראשי', home: 'בית',
    restaurants: 'מסעדות', profile: 'פרופיל', menuAvailable: 'התפריט זמין',
    live: 'פעיל', map: 'מפת מסעדות', chooseLocation: 'בחירת מיקום',
    changeLocation: 'שינוי מיקום', locating: 'מאתרים…', yourLocation: 'המיקום שלי',
    locationUnavailable: 'המיקום לא זמין', locationTitle: 'בחירת המיקום שלכם',
    locationIntro: 'אפשר להשתמש במיקום הנוכחי או להזין כל כתובת.', close: 'סגירה',
    useCurrentLocation: 'שימוש במיקום הנוכחי', currentLocationNote: 'המיקום מהמכשיר משמש רק לאחר אישור.',
    orEnterAddress: 'או הזינו כתובת', addressLabel: 'כתובת',
    addressPlaceholder: 'רחוב, עיר או מקום', findAddress: 'חיפוש כתובת',
    searchingAddresses: 'מחפשים…', addressEmpty: 'לא נמצאה כתובת מתאימה.',
    addressError: 'חיפוש הכתובות אינו זמין. נסו שוב.', selectAddress: 'בחירת כתובת',
    addressPrivacy: 'טקסט החיפוש נשלח ל-OpenStreetMap רק לאחר לחיצה על חיפוש.',
    kilometres: 'ק״מ',
    restaurant: 'מסעדה', demo: 'דמו', priceLevel: 'רמת מחיר', back: 'חזרה',
    logo: 'לוגו', sections: 'אפשרויות במסעדה', menu: 'תפריט', liveTable: 'השולחן שלי',
    photos: 'תמונות', reviews: 'ביקורות', info: 'מידע', favourite: 'שמירת מסעדה',
    reserve: 'הזמנת שולחן', availableAtTable: 'זמין בשולחן שלכם', pilot: 'Live Table בפיילוט',
    scan: 'סרקו את הקוד שעל השולחן', liveAvailable:
      'מזמינים, עוקבים אחרי המנות, קוראים למלצר ומבקשים חשבון במסך אחד.',
    livePilot: 'התפריט כבר פעיל. בקשות למלצר ושירות לשולחן יופיעו כאן כשהמקום יעבור למצב שולחנות.',
    demoNote: (rating: string) => `★ הדירוג ${rating} ומספר הביקורות הם נתוני דמו של ANGLE, ולא ביקורות Google.`,
    viewMenu: 'לתפריט', reserveTable: 'הזמנת שולחן', loadingOne: 'טוענים את המסעדה…',
    unavailable: 'המסעדה אינה זמינה כרגע.', backToRestaurants: 'חזרה למסעדות',
  },
} as const

function useDiscoveryLocale() {
  const isRtl = typeof navigator !== 'undefined'
    && navigator.language.toLocaleLowerCase().startsWith('he')
  return { copy: isRtl ? discoveryCopy.he : discoveryCopy.en, dir: isRtl ? 'rtl' as const : 'ltr' as const }
}

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

const SearchIcon = () => (
  <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>
)

const PinIcon = () => (
  <Icon size={17}><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></Icon>
)

const ArrowIcon = () => (
  <Icon><path d="m15 18-6-6 6-6" /></Icon>
)

const MenuIcon = () => (
  <Icon><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h5" /></Icon>
)

const TableIcon = () => (
  <Icon><path d="M5 11h14M7 11V7h10v4M6 11v9M18 11v9M4 20h4M16 20h4" /></Icon>
)

const CalendarIcon = () => (
  <Icon><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Icon>
)

const HomeIcon = () => (
  <Icon><path d="m3 11 9-8 9 8" /><path d="M5 10v11h14V10M9 21v-7h6v7" /></Icon>
)

const RestaurantsIcon = () => (
  <Icon><path d="M7 3v7M4 3v4a3 3 0 0 0 6 0V3M7 10v11" /><path d="M16 3v18M16 3c3 1 4 4 4 7h-4" /></Icon>
)

const ProfileIcon = () => (
  <Icon><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Icon>
)

const HeartIcon = () => (
  <Icon><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /></Icon>
)

const PhotoIcon = () => (
  <Icon><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 20" /></Icon>
)

const ReviewsIcon = () => (
  <Icon><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></Icon>
)

const InfoIcon = () => (
  <Icon><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></Icon>
)

const LocateIcon = () => (
  <Icon size={17}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="8" /></Icon>
)

const CloseIcon = () => (
  <Icon><path d="m6 6 12 12M18 6 6 18" /></Icon>
)

type GuestPosition = { lat: number; lng: number }
type LocationStatus = 'idle' | 'locating' | 'ready' | 'unavailable'

function distanceKm(from: GuestPosition, to: GuestPosition) {
  const radians = (degrees: number) => degrees * Math.PI / 180
  const latDelta = radians(to.lat - from.lat)
  const lngDelta = radians(to.lng - from.lng)
  const fromLat = radians(from.lat)
  const toLat = radians(to.lat)
  const haversine = Math.sin(latDelta / 2) ** 2
    + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(lngDelta / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

function formatDistance(value: number) {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString()
}

function Rating({ restaurant, demo, compact = false }: {
  restaurant: PublicRestaurant
  demo: string
  compact?: boolean
}) {
  if (!restaurant.rating) return null
  return (
    <span className={`angle-discovery-rating${compact ? ' is-compact' : ''}`}>
      <span aria-hidden="true">★</span>
      <strong>{restaurant.rating.value.toFixed(1)}</strong>
      <span>({restaurant.rating.count.toLocaleString('en-US')})</span>
      <small>{demo}</small>
    </span>
  )
}

function PriceLevel({ value, label }: { value: number | null; label: string }) {
  if (!value) return null
  return <span aria-label={`${label} ${value} / 4`}>{'₪'.repeat(value)}</span>
}

function RestaurantCard({ restaurant, copy, distance }: {
  restaurant: PublicRestaurant
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he
  distance?: number
}) {
  return (
    <Link className="angle-restaurant-card" to={`/restaurants/${restaurant.slug}`}>
      <div className="angle-restaurant-card__media">
        <img src={restaurant.hero_url || fallbackHero} alt="" />
      </div>
      <div className="angle-restaurant-card__body">
        <div className="angle-restaurant-card__heading">
          <h2>{restaurant.name}</h2>
          <span className="angle-restaurant-card__availability">
            <i aria-hidden="true" /> {copy.live}
          </span>
        </div>
        <p>{restaurant.cuisine.join(' · ') || copy.restaurant}</p>
        <Rating restaurant={restaurant} demo={copy.demo} compact />
        <div className="angle-restaurant-card__meta">
          <span>{restaurant.address || restaurant.city || 'Tel Aviv'}</span>
          <span className="angle-restaurant-card__distance">
            {restaurant.coordinates && distance != null
              ? `${formatDistance(distance)} ${copy.kilometres}`
              : <PriceLevel value={restaurant.price_level} label={copy.priceLevel} />}
          </span>
        </div>
      </div>
    </Link>
  )
}

function RestaurantMap({ restaurants, copy, guestPosition, locationStatus, onChooseLocation }: {
  restaurants: PublicRestaurant[]
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he
  guestPosition: GuestPosition | null
  locationStatus: LocationStatus
  onChooseLocation: () => void
}) {
  const located = restaurants.filter((restaurant) => restaurant.coordinates)
  const first = located[0]?.coordinates ?? null
  const nearbyGuest = first && guestPosition && distanceKm(first, guestPosition) <= 50
    ? guestPosition
    : null
  // Keep the guest coordinate in the browser: the third-party map request is
  // framed only by public venue coordinates. The blue dot is a local overlay.
  const visiblePoints = located.map((restaurant) => restaurant.coordinates as GuestPosition)
  const centre = first ?? { lat: 32.0853, lng: 34.7818 }
  const latValues = visiblePoints.length ? visiblePoints.map((point) => point.lat) : [centre.lat]
  const lngValues = visiblePoints.length ? visiblePoints.map((point) => point.lng) : [centre.lng]
  const rawLatSpan = Math.max(...latValues) - Math.min(...latValues)
  const rawLngSpan = Math.max(...lngValues) - Math.min(...lngValues)
  const latPadding = Math.max(.009, rawLatSpan * .35)
  const lngPadding = Math.max(.014, rawLngSpan * .35)
  const bounds = {
    minLat: Math.min(...latValues) - latPadding,
    maxLat: Math.max(...latValues) + latPadding,
    minLng: Math.min(...lngValues) - lngPadding,
    maxLng: Math.max(...lngValues) + lngPadding,
  }
  const place = (point: GuestPosition) => ({
    insetInlineStart: `${Math.max(6, Math.min(94, (point.lng - bounds.minLng) / (bounds.maxLng - bounds.minLng) * 100))}%`,
    top: `${Math.max(6, Math.min(94, (bounds.maxLat - point.lat) / (bounds.maxLat - bounds.minLat) * 100))}%`,
  })
  const mapUrl = first
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${bounds.minLng}%2C${bounds.minLat}%2C${bounds.maxLng}%2C${bounds.maxLat}&layer=mapnik&marker=${first.lat}%2C${first.lng}`
    : null
  const locateLabel = locationStatus === 'locating'
    ? copy.locating
    : locationStatus === 'ready'
      ? copy.changeLocation
      : copy.chooseLocation
  return (
    <section className={`angle-discovery-map${mapUrl ? ' has-live-map' : ''}`} aria-label={copy.map}>
      {mapUrl && (
        <iframe
          className="angle-discovery-map-frame"
          src={mapUrl}
          title={copy.map}
          loading="lazy"
          tabIndex={-1}
        />
      )}
      <button
        type="button"
        className="angle-discovery-locate"
        onClick={onChooseLocation}
        disabled={locationStatus === 'locating'}
      >
        <LocateIcon /> <span>{locateLabel}</span>
      </button>
      {nearbyGuest && (
        <span className="angle-discovery-current-location" style={place(nearbyGuest)} aria-hidden="true"><i /></span>
      )}
      {located.slice(0, 4).map((restaurant) => (
        <Link
          key={restaurant.id}
          className="angle-discovery-map-marker"
          style={place(restaurant.coordinates as GuestPosition)}
          to={`/restaurants/${restaurant.slug}`}
          aria-label={`${restaurant.name}: ${copy.menuAvailable}`}
        >
          <img src={restaurant.hero_url || fallbackHero} alt="" />
        </Link>
      ))}
      {mapUrl && (
        <a
          className="angle-discovery-map-attribution"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >© OpenStreetMap</a>
      )}
    </section>
  )
}

function LocationPicker({ copy, status, onClose, onUseCurrent, onSelectAddress }: {
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he
  status: LocationStatus
  onClose: () => void
  onUseCurrent: () => void
  onSelectAddress: (result: AddressSearchResult) => void
}) {
  const [addressQuery, setAddressQuery] = useState('')
  const [addressResults, setAddressResults] = useState<AddressSearchResult[]>([])
  const [addressStatus, setAddressStatus] = useState<'idle' | 'searching' | 'empty' | 'error'>('idle')

  const handleAddressSearch = async (event: FormEvent) => {
    event.preventDefault()
    if (addressQuery.trim().length < 3 || addressStatus === 'searching') return
    setAddressStatus('searching')
    try {
      const results = await searchAddresses(addressQuery, navigator.language)
      setAddressResults(results)
      setAddressStatus(results.length > 0 ? 'idle' : 'empty')
    } catch {
      setAddressResults([])
      setAddressStatus('error')
    }
  }

  return (
    <div className="angle-location-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        className="angle-location-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="angle-location-title"
      >
        <header>
          <div>
            <h2 id="angle-location-title">{copy.locationTitle}</h2>
            <p>{copy.locationIntro}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={copy.close}><CloseIcon /></button>
        </header>

        <button
          type="button"
          className="angle-location-current"
          onClick={onUseCurrent}
          disabled={status === 'locating'}
          aria-label={copy.useCurrentLocation}
        >
          <span><LocateIcon /></span>
          <span>
            <strong>{status === 'locating' ? copy.locating : copy.useCurrentLocation}</strong>
            <small>{status === 'unavailable' ? copy.locationUnavailable : copy.currentLocationNote}</small>
          </span>
        </button>

        <div className="angle-location-divider"><span>{copy.orEnterAddress}</span></div>

        <form className="angle-location-form" onSubmit={handleAddressSearch}>
          <label htmlFor="angle-location-address">{copy.addressLabel}</label>
          <div>
            <input
              id="angle-location-address"
              value={addressQuery}
              onChange={(event) => {
                setAddressQuery(event.target.value)
                if (addressStatus !== 'idle') setAddressStatus('idle')
              }}
              placeholder={copy.addressPlaceholder}
              autoComplete="street-address"
            />
            <button
              type="submit"
              disabled={addressQuery.trim().length < 3 || addressStatus === 'searching'}
            >
              {addressStatus === 'searching' ? copy.searchingAddresses : copy.findAddress}
            </button>
          </div>
        </form>

        {addressStatus === 'empty' && <p className="angle-location-feedback">{copy.addressEmpty}</p>}
        {addressStatus === 'error' && <p className="angle-location-feedback is-error">{copy.addressError}</p>}

        {addressResults.length > 0 && (
          <div className="angle-location-results" aria-live="polite">
            {addressResults.map((result) => (
              <button
                key={result.id}
                type="button"
                onClick={() => onSelectAddress(result)}
                aria-label={`${copy.selectAddress}: ${result.label}`}
              >
                <span><PinIcon /></span>
                <span>{result.label}</span>
              </button>
            ))}
          </div>
        )}

        <p className="angle-location-privacy">
          {copy.addressPrivacy}{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
        </p>
      </section>
    </div>
  )
}

function DirectoryState({ children }: { children: ReactNode }) {
  return <div className="angle-discovery-state">{children}</div>
}

export function RestaurantDirectoryHome() {
  const [query, setQuery] = useState('')
  const [guestPosition, setGuestPosition] = useState<GuestPosition | null>(null)
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle')
  const [locationLabel, setLocationLabel] = useState('Tel Aviv, Israel')
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false)
  const { copy, dir } = useDiscoveryLocale()
  const restaurants = useQuery({
    queryKey: ['public-restaurants'],
    queryFn: fetchPublicRestaurants,
  })

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const matching = needle
      ? (restaurants.data ?? []).filter((restaurant) => [
        restaurant.name,
        restaurant.city,
        restaurant.address,
        ...restaurant.cuisine,
      ].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
      : restaurants.data ?? []
    if (!guestPosition) return matching
    return [...matching].sort((left, right) => {
      const leftDistance = left.coordinates ? distanceKm(guestPosition, left.coordinates) : Number.POSITIVE_INFINITY
      const rightDistance = right.coordinates ? distanceKm(guestPosition, right.coordinates) : Number.POSITIVE_INFINITY
      return leftDistance - rightDistance
    })
  }, [guestPosition, query, restaurants.data])

  const distances = useMemo(() => new Map(filtered.flatMap((restaurant) =>
    guestPosition && restaurant.coordinates
      ? [[restaurant.id, distanceKm(guestPosition, restaurant.coordinates)] as const]
      : [],
  )), [filtered, guestPosition])

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus('unavailable')
      return
    }
    setLocationStatus('locating')
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setGuestPosition({ lat: coords.latitude, lng: coords.longitude })
        setLocationLabel(copy.yourLocation)
        setLocationStatus('ready')
        setIsLocationPickerOpen(false)
      },
      () => setLocationStatus('unavailable'),
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 300_000 },
    )
  }

  const selectAddress = (result: AddressSearchResult) => {
    setGuestPosition({ lat: result.lat, lng: result.lng })
    setLocationLabel(result.label)
    setLocationStatus('ready')
    setIsLocationPickerOpen(false)
  }

  return (
    <main className="angle-discovery" dir={dir}>
      <div className="angle-discovery-panel">
        <header className="angle-discovery-header">
          <div className="angle-discovery-wordmark">ANGLE</div>
          <button
            className="angle-discovery-location"
            type="button"
            aria-label={`${copy.locationTitle}: ${locationLabel}`}
            onClick={() => setIsLocationPickerOpen(true)}
          >
            <PinIcon />
            <span>{locationLabel}</span>
            <span aria-hidden="true">⌄</span>
          </button>
        </header>

        <section className="angle-discovery-search" aria-label={copy.searchRegion}>
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.searchPlaceholder}
            aria-label={copy.searchLabel}
          />
        </section>

        <nav className="angle-discovery-filters" aria-label={copy.filters}>
          <button type="button" className="is-active">{copy.near}</button>
          <button type="button" disabled>{copy.bookmarks}</button>
          <button type="button" disabled>{copy.reservations}</button>
        </nav>
      </div>

      <RestaurantMap
        restaurants={filtered}
        copy={copy}
        guestPosition={guestPosition}
        locationStatus={locationStatus}
        onChooseLocation={() => setIsLocationPickerOpen(true)}
      />

      <section className="angle-discovery-list" aria-labelledby="nearby-heading">
        <div className="angle-discovery-section-title">
          <div>
            <p>{copy.eyebrow}</p>
            <h1 id="nearby-heading">{copy.near}</h1>
          </div>
          <span>{filtered.length}</span>
        </div>

        {restaurants.isPending && <DirectoryState>{copy.loading}</DirectoryState>}
        {restaurants.isError && (
          <DirectoryState>
            <p>{copy.loadError}</p>
            <button type="button" onClick={() => restaurants.refetch()}>{copy.retry}</button>
          </DirectoryState>
        )}
        {!restaurants.isPending && !restaurants.isError && filtered.length === 0 && (
          <DirectoryState>{copy.empty}</DirectoryState>
        )}
        {filtered.map((restaurant) => (
          <RestaurantCard
            key={restaurant.id}
            restaurant={restaurant}
            copy={copy}
            distance={distances.get(restaurant.id)}
          />
        ))}
      </section>

      <nav className="angle-discovery-bottom" aria-label={copy.navigation}>
        <Link className="is-active" to="/"><HomeIcon /><small>{copy.home}</small></Link>
        <Link to="/"><RestaurantsIcon /><small>{copy.restaurants}</small></Link>
        <span aria-disabled="true"><CalendarIcon /><small>{copy.reservations}</small></span>
        <span aria-disabled="true"><ProfileIcon /><small>{copy.profile}</small></span>
      </nav>

      {isLocationPickerOpen && (
        <LocationPicker
          copy={copy}
          status={locationStatus}
          onClose={() => setIsLocationPickerOpen(false)}
          onUseCurrent={requestLocation}
          onSelectAddress={selectAddress}
        />
      )}
    </main>
  )
}

function RestaurantDetailContent({ restaurant }: { restaurant: PublicRestaurant }) {
  const navigate = useNavigate()
  const { copy, dir } = useDiscoveryLocale()

  return (
    <main className="angle-venue" dir={dir}>
      <section className="angle-venue-hero" id="venue-gallery">
        <img src={restaurant.hero_url || fallbackHero} alt="" />
        <button type="button" className="angle-venue-back" onClick={() => navigate(-1)} aria-label={copy.back}>
          <ArrowIcon />
        </button>
        <button type="button" className="angle-venue-favourite" aria-label={copy.favourite}>
          <HeartIcon />
        </button>
      </section>

      <section className="angle-venue-sheet">
        {restaurant.logo_url && (
          <img className="angle-venue-logo" src={restaurant.logo_url} alt={`${restaurant.name} ${copy.logo}`} />
        )}
        <h1>{restaurant.name}</h1>
        <div className="angle-venue-rating-line" id="venue-reviews">
          <Rating restaurant={restaurant} demo={copy.demo} />
          <PriceLevel value={restaurant.price_level} label={copy.priceLevel} />
        </div>
        <p className="angle-venue-address">
          <PinIcon /> {restaurant.address || [restaurant.city, restaurant.country_code].filter(Boolean).join(', ')}
        </p>
        <div className="angle-venue-tags">
          {restaurant.cuisine.map((label) => <span key={label}>{label}</span>)}
        </div>

        <nav className="angle-venue-actions" aria-label={copy.sections}>
          <Link to={`/order/${restaurant.slug}`}><MenuIcon /><span>{copy.menu}</span></Link>
          <a href="#venue-gallery"><PhotoIcon /><span>{copy.photos}</span></a>
          <a href="#venue-reviews"><ReviewsIcon /><span>{copy.reviews}</span></a>
          <a href="#venue-info"><InfoIcon /><span>{copy.info}</span></a>
        </nav>

        {restaurant.summary && <p className="angle-venue-summary" id="venue-info">{restaurant.summary}</p>}

        <section className="angle-venue-live" id="live-table">
          <div className="angle-venue-live__icon"><TableIcon /></div>
          <div>
            <p>{restaurant.features.table_service ? copy.availableAtTable : copy.pilot}</p>
            <h2>{copy.scan}</h2>
            <span>
              {restaurant.features.table_service
                ? copy.liveAvailable
                : copy.livePilot}
            </span>
          </div>
        </section>

        {restaurant.rating?.source === 'demo' && (
          <p className="angle-venue-demo-note">
            {copy.demoNote(restaurant.rating.value.toFixed(1))}
          </p>
        )}

        <Link className="angle-venue-primary" to={`/order/${restaurant.slug}`}>
          {copy.viewMenu}
          <span aria-hidden="true">→</span>
        </Link>
        {restaurant.features.reservations && (
          <Link className="angle-venue-secondary" to={`/reserve/${restaurant.slug}`}>
            {copy.reserveTable}
          </Link>
        )}
      </section>
    </main>
  )
}

export function RestaurantDetailPage() {
  const { slug = '' } = useParams()
  const { copy, dir } = useDiscoveryLocale()
  const restaurant = useQuery({
    queryKey: ['public-restaurant', slug],
    queryFn: () => fetchPublicRestaurant(slug),
    enabled: Boolean(slug),
  })

  if (restaurant.isPending) {
    return <main className="angle-discovery" dir={dir}><DirectoryState>{copy.loadingOne}</DirectoryState></main>
  }
  if (restaurant.isError || !restaurant.data) {
    return (
      <main className="angle-discovery" dir={dir}>
        <DirectoryState>
          <p>{copy.unavailable}</p>
          <Link to="/">{copy.backToRestaurants}</Link>
        </DirectoryState>
      </main>
    )
  }
  return <RestaurantDetailContent restaurant={restaurant.data} />
}
