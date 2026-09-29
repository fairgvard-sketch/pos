import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  fetchPublicRestaurant,
  fetchPublicRestaurants,
  type PublicRestaurant,
} from '../online/publicApi'

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
    restaurant: 'Restaurant', demo: 'Demo', priceLevel: 'Price level', back: 'Back',
    logo: 'logo', sections: 'Restaurant sections', menu: 'Menu', liveTable: 'Live Table',
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
    restaurant: 'מסעדה', demo: 'דמו', priceLevel: 'רמת מחיר', back: 'חזרה',
    logo: 'לוגו', sections: 'אפשרויות במסעדה', menu: 'תפריט', liveTable: 'השולחן שלי',
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

function RestaurantCard({ restaurant, copy }: {
  restaurant: PublicRestaurant
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he
}) {
  return (
    <Link className="angle-restaurant-card" to={`/restaurants/${restaurant.slug}`}>
      <div className="angle-restaurant-card__media">
        <img src={restaurant.hero_url || fallbackHero} alt="" />
        <span className="angle-restaurant-card__availability">{copy.menuAvailable}</span>
      </div>
      <div className="angle-restaurant-card__body">
        <div>
          <h2>{restaurant.name}</h2>
          <p>{restaurant.cuisine.join(' · ') || copy.restaurant}</p>
        </div>
        <Rating restaurant={restaurant} demo={copy.demo} compact />
        <div className="angle-restaurant-card__meta">
          <span>{restaurant.address || restaurant.city || 'Tel Aviv'}</span>
          <PriceLevel value={restaurant.price_level} label={copy.priceLevel} />
        </div>
      </div>
    </Link>
  )
}

function DirectoryState({ children }: { children: ReactNode }) {
  return <div className="angle-discovery-state">{children}</div>
}

export function RestaurantDirectoryHome() {
  const [query, setQuery] = useState('')
  const { copy, dir } = useDiscoveryLocale()
  const restaurants = useQuery({
    queryKey: ['public-restaurants'],
    queryFn: fetchPublicRestaurants,
  })

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return restaurants.data ?? []
    return (restaurants.data ?? []).filter((restaurant) => [
      restaurant.name,
      restaurant.city,
      restaurant.address,
      ...restaurant.cuisine,
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
  }, [query, restaurants.data])

  return (
    <main className="angle-discovery" dir={dir}>
      <header className="angle-discovery-header">
        <div className="angle-discovery-wordmark">ANGLE</div>
        <button className="angle-discovery-location" type="button" aria-label={copy.area}>
          <PinIcon />
          <span>Tel Aviv, Israel</span>
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
          <RestaurantCard key={restaurant.id} restaurant={restaurant} copy={copy} />
        ))}
      </section>

      <nav className="angle-discovery-bottom" aria-label={copy.navigation}>
        <Link className="is-active" to="/">{copy.home}</Link>
        <Link to="/">{copy.restaurants}</Link>
        <span aria-disabled="true">{copy.reservations}</span>
        <span aria-disabled="true">{copy.profile}</span>
      </nav>
    </main>
  )
}

function RestaurantDetailContent({ restaurant }: { restaurant: PublicRestaurant }) {
  const navigate = useNavigate()
  const { copy, dir } = useDiscoveryLocale()

  return (
    <main className="angle-venue" dir={dir}>
      <section className="angle-venue-hero">
        <img src={restaurant.hero_url || fallbackHero} alt="" />
        <button type="button" className="angle-venue-back" onClick={() => navigate(-1)} aria-label={copy.back}>
          <ArrowIcon />
        </button>
      </section>

      <section className="angle-venue-sheet">
        {restaurant.logo_url && (
          <img className="angle-venue-logo" src={restaurant.logo_url} alt={`${restaurant.name} ${copy.logo}`} />
        )}
        <h1>{restaurant.name}</h1>
        <div className="angle-venue-rating-line">
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
          <a href="#live-table"><TableIcon /><span>{copy.liveTable}</span></a>
          {restaurant.features.reservations && (
            <Link to={`/reserve/${restaurant.slug}`}><CalendarIcon /><span>{copy.reserve}</span></Link>
          )}
        </nav>

        {restaurant.summary && <p className="angle-venue-summary">{restaurant.summary}</p>}

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
