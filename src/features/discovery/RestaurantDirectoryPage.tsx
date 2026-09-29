import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  fetchPublicRestaurant,
  fetchPublicRestaurants,
  type PublicRestaurant,
} from '../online/publicApi'
import { searchAddresses, type AddressSearchResult } from './geocoding'

const fallbackHero = '/menu-backgrounds/ivory-food.webp'

let qrScannerModule: Promise<typeof import('qr-scanner')> | null = null

function loadQrScanner() {
  qrScannerModule ??= import('qr-scanner')
  return qrScannerModule
}

const discoveryCopy = {
  en: {
    area: 'Current area: Tel Aviv', searchRegion: 'Find a restaurant',
    searchPlaceholder: 'Search', searchLabel: 'Search restaurants',
    filters: 'Restaurant filters', near: 'Nearby restaurants', bookmarks: 'Favourites',
    filterRestaurants: 'Filters', sortRestaurants: 'Sort restaurants', topRestaurants: 'Top restaurants',
    newRestaurants: 'New restaurants',
    openNow: 'Open now', favouritesOnly: 'Favourites only', filterTitle: 'Filter restaurants',
    sortTitle: 'Sort restaurants', nearest: 'Nearest', highestRated: 'Highest rated',
    mostReviewed: 'Most reviewed', priceFilter: 'Price level', clearFilters: 'Clear filters',
    reservations: 'Reservations', loading: 'Loading restaurants…',
    loadError: 'Restaurants could not be loaded.', retry: 'Try again',
    empty: 'No restaurants match this search.', navigation: 'Main navigation', home: 'Home',
    restaurants: 'Restaurants', profile: 'Profile', menuAvailable: 'Menu available',
    live: 'Live', chooseLocation: 'Choose location',
    discoverTitle: 'Good places, close to you',
    browseCuisine: 'Browse by cuisine', recent: 'Recently visited',
    searchResults: 'Search results', removeFavourite: 'Remove restaurant from favourites',
    changeLocation: 'Change location', locating: 'Locating…', yourLocation: 'My location',
    locationUnavailable: 'Location unavailable', locationTitle: 'Choose your location', close: 'Close',
    useCurrentLocation: 'Use my current location', currentLocationNote: 'Uses your device location only after permission.',
    selectedArea: 'Selected area', allAddresses: 'All addresses',
    allAddressesNote: 'Search by street, city or place', addAddress: 'Add address',
    addressTitle: 'Add an address', addressIntro: 'Enter a street, city or place.',
    backToLocations: 'Back to locations', addressLabel: 'Address',
    addressPlaceholder: 'Street, city or place', findAddress: 'Find address',
    searchingAddresses: 'Searching…', addressEmpty: 'No matching address found.',
    addressError: 'Address search is unavailable. Try again.', selectAddress: 'Select address',
    addressPrivacy: 'The search text is sent to OpenStreetMap only after you press Find.',
    kilometres: 'km', today: 'Today', openAllDay: 'Open 24 hours', closedToday: 'Closed today',
    workingHours: 'Opening hours',
    restaurant: 'Restaurant', demo: 'Demo', priceLevel: 'Price level', back: 'Back',
    logo: 'logo', sections: 'Restaurant sections', menu: 'Menu', liveTable: 'Live Table',
    photos: 'Photos', reviews: 'Reviews', info: 'Info', favourite: 'Save restaurant',
    reserve: 'Reserve', scanQrMenu: 'Scan QR menu', scanQrHint: 'Scan the code on your table to join and order',
    scannerTitle: 'Scan QR menu', scannerStarting: 'Starting camera…',
    scannerHint: 'Point the camera at the QR code on your table.',
    scannerUnsupported: 'QR scanning is not supported in this browser. Open your camera app and scan the code there.',
    scannerDenied: 'Camera access is unavailable. Allow camera access or scan the code with your camera app.',
    scannerInvalid: 'This is not an ANGLE menu QR code.',
    scannerPhoto: 'Scan from photo', scannerPhotoHint: 'Take a photo of the QR code or choose one from your library.',
    demoNote: (rating: string) => `★ The ${rating} rating and review count are demo data for the ANGLE prototype, not Google reviews.`,
    reserveTable: 'Reserve a table', loadingOne: 'Loading restaurant…',
    unavailable: 'This restaurant is not available.', backToRestaurants: 'Back to restaurants',
  },
  he: {
    area: 'האזור הנוכחי: תל אביב', searchRegion: 'חיפוש מסעדה',
    searchPlaceholder: 'חיפוש', searchLabel: 'חיפוש מסעדות',
    filters: 'מסנני מסעדות', near: 'מסעדות קרובות', bookmarks: 'מועדפים',
    filterRestaurants: 'סינון', sortRestaurants: 'מיון מסעדות', topRestaurants: 'מסעדות מובילות',
    newRestaurants: 'מסעדות חדשות',
    openNow: 'פתוח עכשיו', favouritesOnly: 'מועדפים בלבד', filterTitle: 'סינון מסעדות',
    sortTitle: 'מיון מסעדות', nearest: 'הקרובות ביותר', highestRated: 'הדירוג הגבוה ביותר',
    mostReviewed: 'מספר הביקורות', priceFilter: 'רמת מחיר', clearFilters: 'איפוס סינון',
    reservations: 'הזמנות', loading: 'טוענים מסעדות…',
    loadError: 'לא הצלחנו לטעון את המסעדות.', retry: 'נסו שוב',
    empty: 'לא נמצאו מסעדות שמתאימות לחיפוש.', navigation: 'ניווט ראשי', home: 'בית',
    restaurants: 'מסעדות', profile: 'פרופיל', menuAvailable: 'התפריט זמין',
    live: 'פעיל', chooseLocation: 'בחירת מיקום',
    discoverTitle: 'מקומות טובים, קרוב אליכם',
    browseCuisine: 'חיפוש לפי מטבח', recent: 'ביקרתם לאחרונה',
    searchResults: 'תוצאות חיפוש', removeFavourite: 'הסרת המסעדה מהמועדפים',
    changeLocation: 'שינוי מיקום', locating: 'מאתרים…', yourLocation: 'המיקום שלי',
    locationUnavailable: 'המיקום לא זמין', locationTitle: 'בחירת המיקום שלכם', close: 'סגירה',
    useCurrentLocation: 'שימוש במיקום הנוכחי', currentLocationNote: 'המיקום מהמכשיר משמש רק לאחר אישור.',
    selectedArea: 'האזור שנבחר', allAddresses: 'כל הכתובות',
    allAddressesNote: 'חיפוש לפי רחוב, עיר או מקום', addAddress: 'הוספת כתובת',
    addressTitle: 'הוספת כתובת', addressIntro: 'הזינו רחוב, עיר או מקום.',
    backToLocations: 'חזרה למיקומים', addressLabel: 'כתובת',
    addressPlaceholder: 'רחוב, עיר או מקום', findAddress: 'חיפוש כתובת',
    searchingAddresses: 'מחפשים…', addressEmpty: 'לא נמצאה כתובת מתאימה.',
    addressError: 'חיפוש הכתובות אינו זמין. נסו שוב.', selectAddress: 'בחירת כתובת',
    addressPrivacy: 'טקסט החיפוש נשלח ל-OpenStreetMap רק לאחר לחיצה על חיפוש.',
    kilometres: 'ק״מ', today: 'היום', openAllDay: 'פתוח 24 שעות', closedToday: 'סגור היום',
    workingHours: 'שעות פתיחה',
    restaurant: 'מסעדה', demo: 'דמו', priceLevel: 'רמת מחיר', back: 'חזרה',
    logo: 'לוגו', sections: 'אפשרויות במסעדה', menu: 'תפריט', liveTable: 'השולחן שלי',
    photos: 'תמונות', reviews: 'ביקורות', info: 'מידע', favourite: 'שמירת מסעדה',
    reserve: 'הזמנת שולחן', scanQrMenu: 'סריקת תפריט QR', scanQrHint: 'סרקו את הקוד שעל השולחן כדי להצטרף ולהזמין',
    scannerTitle: 'סריקת תפריט QR', scannerStarting: 'מפעילים את המצלמה…',
    scannerHint: 'כוונו את המצלמה לקוד ה־QR שעל השולחן.',
    scannerUnsupported: 'הדפדפן הזה לא תומך בסריקת QR. פתחו את אפליקציית המצלמה וסרקו שם.',
    scannerDenied: 'הגישה למצלמה אינה זמינה. אשרו גישה או סרקו דרך אפליקציית המצלמה.',
    scannerInvalid: 'זה אינו קוד QR של תפריט ANGLE.',
    scannerPhoto: 'סריקה מתמונה', scannerPhotoHint: 'צלמו את קוד ה־QR או בחרו תמונה מהספרייה.',
    demoNote: (rating: string) => `★ הדירוג ${rating} ומספר הביקורות הם נתוני דמו של ANGLE, ולא ביקורות Google.`,
    reserveTable: 'הזמנת שולחן', loadingOne: 'טוענים את המסעדה…',
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

const HeartIcon = ({ filled = false }: { filled?: boolean }) => (
  <Icon><path fill={filled ? 'currentColor' : 'none'} d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /></Icon>
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

const CheckIcon = () => (
  <Icon><path d="m5 12 4 4L19 6" /></Icon>
)

const ListIcon = () => (
  <Icon><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></Icon>
)

const PlusIcon = () => (
  <Icon><path d="M12 5v14M5 12h14" /></Icon>
)

const ClockIcon = () => (
  <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
)

const SlidersIcon = () => (
  <Icon><path d="M4 6h5M15 6h5M4 12h9M17 12h3M4 18h2M12 18h8" /><circle cx="12" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></Icon>
)

const SortIcon = () => (
  <Icon><path d="M8 4v16M5 7l3-3 3 3M16 20V4M13 17l3 3 3-3" /></Icon>
)

function cuisineArtwork(cuisine: string) {
  const value = cuisine.toLocaleLowerCase()
  if (/(coffee|café|cafe|קפה)/.test(value)) return '/discovery/cuisines/coffee.jpg'
  if (/(bakery|pastry|dessert|מאפ|מאפה|קונדיט)/.test(value)) return '/discovery/cuisines/bakery.jpg'
  if (/(italian|pizza|איטלק|פיצה)/.test(value)) return '/discovery/cuisines/pizza.jpg'
  if (/(asian|sushi|japanese|thai|אסי|יפנ|סושי|תאיל)/.test(value)) return '/discovery/cuisines/asian.jpg'
  return '/discovery/cuisines/all.jpg'
}

function CuisineArtwork({ cuisine }: { cuisine: string }) {
  return <img src={cuisineArtwork(cuisine)} alt="" aria-hidden="true" />
}

const QrIcon = () => (
  <Icon size={24}>
    <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" />
    <path d="M14 14h2v2h-2zM18 14h2v4h-2zM14 18h4v2h-4zM20 20h.01" />
  </Icon>
)

type GuestPosition = { lat: number; lng: number }
type LocationStatus = 'idle' | 'locating' | 'ready' | 'unavailable'
type LocationSource = 'default' | 'device' | 'address'
type StoredGuestLocation = {
  position: GuestPosition
  label: string
  source: LocationSource
}

const DEFAULT_GUEST_LOCATION: StoredGuestLocation = {
  position: { lat: 32.0853, lng: 34.7818 },
  label: 'Tel Aviv, Israel',
  source: 'default',
}
const GUEST_LOCATION_STORAGE_KEY = 'angle:guest-location'
const FAVOURITE_RESTAURANTS_STORAGE_KEY = 'angle:favourite-restaurants'
const RECENT_RESTAURANTS_STORAGE_KEY = 'angle:recent-restaurants'
const MAX_RECENT_RESTAURANTS = 8

function readStoredRestaurantIds(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string').slice(0, MAX_RECENT_RESTAURANTS)
      : []
  } catch {
    return []
  }
}

function saveStoredRestaurantIds(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // Discovery remains usable when local storage is unavailable.
  }
}

function readGuestLocation(): StoredGuestLocation {
  try {
    const stored = localStorage.getItem(GUEST_LOCATION_STORAGE_KEY)
    if (!stored) return DEFAULT_GUEST_LOCATION
    const parsed = JSON.parse(stored) as Partial<StoredGuestLocation>
    const lat = parsed.position?.lat
    const lng = parsed.position?.lng
    if (typeof lat !== 'number' || !Number.isFinite(lat)
      || typeof lng !== 'number' || !Number.isFinite(lng)
      || typeof parsed.label !== 'string'
      || !['device', 'address'].includes(parsed.source ?? '')) return DEFAULT_GUEST_LOCATION
    return { position: { lat, lng }, label: parsed.label, source: parsed.source as LocationSource }
  } catch {
    return DEFAULT_GUEST_LOCATION
  }
}

function saveGuestLocation(location: StoredGuestLocation) {
  try {
    localStorage.setItem(GUEST_LOCATION_STORAGE_KEY, JSON.stringify(location))
  } catch {
    // The page still works when storage is disabled; distance falls back to the selected session.
  }
}

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

function dayOfWeekInTimezone(timezone?: string | null) {
  try {
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: timezone || undefined,
    }).format(new Date())
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
  } catch {
    return new Date().getDay()
  }
}

function todayHours(
  hours: PublicRestaurant['hours'],
  timezone: string | null | undefined,
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he,
) {
  if (!hours || Object.keys(hours).length === 0) return copy.openAllDay
  const windows = hours[String(dayOfWeekInTimezone(timezone))] ?? []
  if (windows.length === 0) return copy.closedToday
  return windows.map(([from, to]) => `${from}–${to}`).join(' · ')
}

function timeInTimezone(timezone?: string | null) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      timeZone: timezone || undefined,
    }).formatToParts(new Date())
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
    return {
      day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday')),
      minutes: Number(value('hour')) * 60 + Number(value('minute')),
    }
  } catch {
    const now = new Date()
    return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() }
  }
}

function restaurantIsOpenNow(restaurant: PublicRestaurant) {
  if (!restaurant.hours || Object.keys(restaurant.hours).length === 0) return true
  const { day, minutes } = timeInTimezone(restaurant.timezone)
  const parse = (value: string) => {
    const [hour, minute] = value.split(':').map(Number)
    return hour * 60 + minute
  }
  const todayOpen = (restaurant.hours[String(day)] ?? []).some(([from, to]) => {
    const start = parse(from)
    const end = parse(to)
    return end > start ? minutes >= start && minutes < end : minutes >= start
  })
  if (todayOpen) return true
  const previousDay = (day + 6) % 7
  return (restaurant.hours[String(previousDay)] ?? []).some(([from, to]) => {
    const start = parse(from)
    const end = parse(to)
    return end <= start && minutes < end
  })
}

function QrScannerDialog({ copy, onClose, onNavigate }: {
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he
  onClose: () => void
  onNavigate: (value: string) => boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<'starting' | 'ready' | 'unsupported' | 'denied' | 'invalid'>('starting')

  useEffect(() => {
    let active = true
    let scanner: { start: () => Promise<void>; stop: () => void; destroy: () => void } | null = null

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unsupported')
        return
      }
      const video = videoRef.current
      if (!video) return
      try {
        const { default: QrScanner } = await loadQrScanner()
        if (!active) return
        scanner = new QrScanner(video, (result) => {
          if (!active) return
          if (onNavigate(result.data)) {
            scanner?.stop()
            return
          }
          setStatus('invalid')
        }, {
          preferredCamera: 'environment',
          maxScansPerSecond: 8,
          returnDetailedScanResult: true,
        })
        await scanner.start()
        if (!active) return
        setStatus('ready')
      } catch {
        if (active) setStatus('denied')
      }
    }
    void start()

    return () => {
      active = false
      scanner?.destroy()
    }
  }, [onNavigate])

  const scanPhoto = async (file: File | undefined) => {
    if (!file) return
    setStatus('starting')
    try {
      const { default: QrScanner } = await loadQrScanner()
      const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true })
      if (!onNavigate(result.data)) setStatus('invalid')
    } catch {
      setStatus('invalid')
    } finally {
      if (uploadRef.current) uploadRef.current.value = ''
    }
  }

  const feedback = status === 'starting'
    ? copy.scannerStarting
    : status === 'unsupported'
      ? copy.scannerUnsupported
      : status === 'denied'
        ? copy.scannerDenied
        : status === 'invalid'
          ? copy.scannerInvalid
          : copy.scannerHint

  return (
    <div className="angle-scanner-backdrop" role="presentation">
      <section className="angle-scanner" role="dialog" aria-modal="true" aria-labelledby="angle-scanner-title">
        <header>
          <h2 id="angle-scanner-title">{copy.scannerTitle}</h2>
          <button type="button" onClick={onClose} aria-label={copy.close}><CloseIcon /></button>
        </header>
        <div className={`angle-scanner-viewport is-${status}`}>
          <video ref={videoRef} muted playsInline aria-label={copy.scannerTitle} />
          <span aria-hidden="true" />
        </div>
        <p role="status">{feedback}</p>
        <button type="button" className="angle-scanner-upload" onClick={() => uploadRef.current?.click()}>
          <PhotoIcon />
          <span><strong>{copy.scannerPhoto}</strong><small>{copy.scannerPhotoHint}</small></span>
        </button>
        <input
          ref={uploadRef}
          className="angle-scanner-file"
          type="file"
          accept="image/*"
          capture="environment"
          aria-label={copy.scannerPhoto}
          onChange={(event) => void scanPhoto(event.target.files?.[0])}
        />
      </section>
    </div>
  )
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

function RestaurantCard({ restaurant, copy, distance, compact = false }: {
  restaurant: PublicRestaurant
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he
  distance?: number
  compact?: boolean
}) {
  return (
    <Link className={`angle-restaurant-card${compact ? ' is-compact' : ''}`} to={`/restaurants/${restaurant.slug}`}>
      <div className="angle-restaurant-card__media">
        <img src={restaurant.hero_url || fallbackHero} alt="" />
        {restaurant.coordinates && distance != null && (
          <span className="angle-restaurant-card__distance">
            {formatDistance(distance)} {copy.kilometres}
          </span>
        )}
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
          <PriceLevel value={restaurant.price_level} label={copy.priceLevel} />
        </div>
      </div>
    </Link>
  )
}

function splitLocationLabel(label: string) {
  const [title, ...rest] = label.split(',').map((part) => part.trim()).filter(Boolean)
  return { title: title || label, subtitle: rest.join(', ') }
}

function LocationPicker({ copy, status, selectedLabel, selectionSource, onClose, onUseCurrent, onSelectAddress }: {
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he
  status: LocationStatus
  selectedLabel: string
  selectionSource: LocationSource
  onClose: () => void
  onUseCurrent: () => void
  onSelectAddress: (result: AddressSearchResult) => void
}) {
  const [view, setView] = useState<'locations' | 'search'>('locations')
  const [addressQuery, setAddressQuery] = useState('')
  const [addressResults, setAddressResults] = useState<AddressSearchResult[]>([])
  const [addressStatus, setAddressStatus] = useState<'idle' | 'searching' | 'empty' | 'error'>('idle')
  const selectedAddress = splitLocationLabel(selectedLabel)

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
        <div className="angle-location-handle" aria-hidden="true" />
        <header className={`angle-location-header${view === 'search' ? ' is-search' : ''}`}>
          {view === 'search'
            ? <button type="button" onClick={() => setView('locations')} aria-label={copy.backToLocations}><ArrowIcon /></button>
            : <span aria-hidden="true" />}
          <h2 id="angle-location-title">{view === 'search' ? copy.addressTitle : copy.locationTitle}</h2>
          <button type="button" onClick={onClose} aria-label={copy.close}><CloseIcon /></button>
        </header>

        {view === 'locations' ? (
          <>
            <div className="angle-location-list">
              <button
                type="button"
                className={selectionSource === 'device' ? 'is-selected' : ''}
                onClick={onUseCurrent}
                disabled={status === 'locating'}
                aria-label={copy.useCurrentLocation}
              >
                <span className="angle-location-row-icon is-current"><LocateIcon /></span>
                <span className="angle-location-row-copy">
                  <strong>{status === 'locating' ? copy.locating : copy.useCurrentLocation}</strong>
                  <small>{status === 'unavailable' ? copy.locationUnavailable : copy.currentLocationNote}</small>
                </span>
                {selectionSource === 'device' && <span className="angle-location-row-check"><CheckIcon /></span>}
              </button>

              {selectionSource !== 'device' && (
                <button type="button" className="is-selected" onClick={onClose}>
                  <span className="angle-location-row-icon"><PinIcon /></span>
                  <span className="angle-location-row-copy">
                    <strong>{selectedAddress.title}</strong>
                    <small>{selectedAddress.subtitle || copy.selectedArea}</small>
                  </span>
                  <span className="angle-location-row-check"><CheckIcon /></span>
                </button>
              )}

              <button type="button" onClick={() => setView('search')}>
                <span className="angle-location-row-icon is-plain"><ListIcon /></span>
                <span className="angle-location-row-copy">
                  <strong>{copy.allAddresses}</strong>
                  <small>{copy.allAddressesNote}</small>
                </span>
              </button>
            </div>

            <button type="button" className="angle-location-add" onClick={() => setView('search')}>
              <PlusIcon /><span>{copy.addAddress}</span>
            </button>
          </>
        ) : (
          <div className="angle-location-search-view">
            <p>{copy.addressIntro}</p>
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
                  autoFocus
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
                {addressResults.map((result) => {
                  const address = splitLocationLabel(result.label)
                  return (
                    <button
                      key={result.id}
                      type="button"
                      onClick={() => onSelectAddress(result)}
                      aria-label={`${copy.selectAddress}: ${result.label}`}
                    >
                      <span className="angle-location-row-icon"><PinIcon /></span>
                      <span className="angle-location-row-copy">
                        <strong>{address.title}</strong>
                        <small>{address.subtitle}</small>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            <p className="angle-location-privacy">
              {copy.addressPrivacy}{' '}
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
            </p>
          </div>
        )}
      </section>
    </div>
  )
}

function DirectoryState({ children }: { children: ReactNode }) {
  return <div className="angle-discovery-state">{children}</div>
}

type DirectorySort = 'distance' | 'rating' | 'reviews' | 'newest'
type DirectoryControlsView = 'filters' | 'sort'

function DiscoveryControlsSheet({ view, copy, sort, onlyOpen, onlyFavourites, priceLevels, onSort,
  onOnlyOpen, onOnlyFavourites, onTogglePrice, onClear, onClose }: {
  view: DirectoryControlsView
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he
  sort: DirectorySort
  onlyOpen: boolean
  onlyFavourites: boolean
  priceLevels: number[]
  onSort: (sort: DirectorySort) => void
  onOnlyOpen: (value: boolean) => void
  onOnlyFavourites: (value: boolean) => void
  onTogglePrice: (value: number) => void
  onClear: () => void
  onClose: () => void
}) {
  const sortOptions: { value: DirectorySort; label: string }[] = [
    { value: 'distance', label: copy.nearest },
    { value: 'rating', label: copy.highestRated },
    { value: 'reviews', label: copy.mostReviewed },
    { value: 'newest', label: copy.newRestaurants },
  ]
  const title = view === 'sort' ? copy.sortTitle : copy.filterTitle
  return (
    <div className="angle-controls-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="angle-controls-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="angle-location-handle" aria-hidden="true" />
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label={copy.close}><CloseIcon /></button>
        </header>
        {view === 'sort' ? (
          <div className="angle-controls-options">
            {sortOptions.map((option) => (
              <button key={option.value} type="button" onClick={() => { onSort(option.value); onClose() }}>
                <span>{option.label}</span>
                {sort === option.value && <CheckIcon />}
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="angle-controls-options">
              <button type="button" aria-pressed={onlyOpen} onClick={() => onOnlyOpen(!onlyOpen)}>
                <span>{copy.openNow}</span>{onlyOpen && <CheckIcon />}
              </button>
              <button type="button" aria-pressed={onlyFavourites} onClick={() => onOnlyFavourites(!onlyFavourites)}>
                <span>{copy.favouritesOnly}</span>{onlyFavourites && <CheckIcon />}
              </button>
            </div>
            <div className="angle-controls-price">
              <strong>{copy.priceFilter}</strong>
              <div>
                {[1, 2, 3, 4].map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={priceLevels.includes(level) ? 'is-active' : ''}
                    aria-pressed={priceLevels.includes(level)}
                    onClick={() => onTogglePrice(level)}
                  >
                    {'₪'.repeat(level)}
                  </button>
                ))}
              </div>
            </div>
            <button className="angle-controls-clear" type="button" onClick={onClear}>{copy.clearFilters}</button>
          </>
        )}
      </section>
    </div>
  )
}

function RestaurantRail({ title, restaurants, copy, distances }: {
  title: string
  restaurants: PublicRestaurant[]
  copy: typeof discoveryCopy.en | typeof discoveryCopy.he
  distances: Map<string, number>
}) {
  const headingId = useId()
  if (restaurants.length === 0) return null
  return (
    <section className="angle-discovery-section" aria-labelledby={headingId}>
      <div className="angle-discovery-section-title">
        <h2 id={headingId}>{title}</h2>
      </div>
      <div className="angle-discovery-rail">
        {restaurants.map((restaurant) => (
          <RestaurantCard
            key={restaurant.id}
            restaurant={restaurant}
            copy={copy}
            distance={distances.get(restaurant.id)}
            compact
          />
        ))}
      </div>
    </section>
  )
}

export function RestaurantDirectoryHome() {
  const initialLocation = useMemo(() => readGuestLocation(), [])
  const [query, setQuery] = useState('')
  const [guestPosition, setGuestPosition] = useState<GuestPosition>(initialLocation.position)
  const [locationStatus, setLocationStatus] = useState<LocationStatus>(
    initialLocation.source === 'default' ? 'idle' : 'ready',
  )
  const [locationLabel, setLocationLabel] = useState(initialLocation.label)
  const [locationSource, setLocationSource] = useState<LocationSource>(initialLocation.source)
  const [isLocationPickerOpen, setIsLocationPickerOpen] = useState(false)
  const [activeCuisine, setActiveCuisine] = useState<string | null>(null)
  const [controlsView, setControlsView] = useState<DirectoryControlsView | null>(null)
  const [sort, setSort] = useState<DirectorySort>('distance')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [onlyFavourites, setOnlyFavourites] = useState(false)
  const [priceLevels, setPriceLevels] = useState<number[]>([])
  const [favouriteIds] = useState(() => readStoredRestaurantIds(FAVOURITE_RESTAURANTS_STORAGE_KEY))
  const [recentIds] = useState(() => readStoredRestaurantIds(RECENT_RESTAURANTS_STORAGE_KEY))
  const { copy, dir } = useDiscoveryLocale()
  const restaurants = useQuery({
    queryKey: ['public-restaurants'],
    queryFn: fetchPublicRestaurants,
  })

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const matchingSearch = needle
      ? (restaurants.data ?? []).filter((restaurant) => [
        restaurant.name,
        restaurant.city,
        restaurant.address,
        ...restaurant.cuisine,
      ].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
      : restaurants.data ?? []
    let matching = activeCuisine
      ? matchingSearch.filter((restaurant) => restaurant.cuisine.some(
        (cuisine) => cuisine.toLocaleLowerCase() === activeCuisine.toLocaleLowerCase(),
      ))
      : matchingSearch
    if (onlyOpen) matching = matching.filter(restaurantIsOpenNow)
    if (onlyFavourites) matching = matching.filter((restaurant) => favouriteIds.includes(restaurant.id))
    if (priceLevels.length > 0) {
      matching = matching.filter((restaurant) => restaurant.price_level != null
        && priceLevels.includes(restaurant.price_level))
    }
    return [...matching].sort((left, right) => {
      if (sort === 'rating') return (right.rating?.value ?? 0) - (left.rating?.value ?? 0)
      if (sort === 'reviews') return (right.rating?.count ?? 0) - (left.rating?.count ?? 0)
      if (sort === 'newest') {
        return Date.parse(right.added_at ?? '') - Date.parse(left.added_at ?? '') || 0
      }
      if (!guestPosition) return 0
      const leftDistance = left.coordinates ? distanceKm(guestPosition, left.coordinates) : Number.POSITIVE_INFINITY
      const rightDistance = right.coordinates ? distanceKm(guestPosition, right.coordinates) : Number.POSITIVE_INFINITY
      return leftDistance - rightDistance
    })
  }, [activeCuisine, favouriteIds, guestPosition, onlyFavourites, onlyOpen, priceLevels, query, restaurants.data, sort])

  const cuisines = useMemo(() => {
    const unique = new Map<string, string>()
    for (const restaurant of restaurants.data ?? []) {
      for (const cuisine of restaurant.cuisine) {
        const key = cuisine.trim().toLocaleLowerCase()
        if (key && !unique.has(key)) unique.set(key, cuisine.trim())
      }
    }
    return [...unique.values()].sort((left, right) => left.localeCompare(right))
  }, [restaurants.data])

  const distances = useMemo(() => new Map(filtered.flatMap((restaurant) =>
    guestPosition && restaurant.coordinates
      ? [[restaurant.id, distanceKm(guestPosition, restaurant.coordinates)] as const]
      : [],
  )), [filtered, guestPosition])

  const allDistances = useMemo(() => new Map((restaurants.data ?? []).flatMap((restaurant) =>
    guestPosition && restaurant.coordinates
      ? [[restaurant.id, distanceKm(guestPosition, restaurant.coordinates)] as const]
      : [],
  )), [guestPosition, restaurants.data])

  const restaurantsByStoredIds = (ids: string[]) => {
    const byId = new Map((restaurants.data ?? []).map((restaurant) => [restaurant.id, restaurant]))
    return ids.flatMap((id) => {
      const restaurant = byId.get(id)
      return restaurant ? [restaurant] : []
    })
  }
  const favourites = restaurantsByStoredIds(favouriteIds)
  const recent = restaurantsByStoredIds(recentIds)
  const hasFilters = onlyOpen || onlyFavourites || priceLevels.length > 0
  const isFiltering = query.trim().length > 0 || activeCuisine !== null || hasFilters || sort !== 'distance'
  const sortLabel = sort === 'rating' ? copy.highestRated
    : sort === 'reviews' ? copy.mostReviewed
      : sort === 'newest' ? copy.newRestaurants
        : copy.nearest

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus('unavailable')
      return
    }
    setLocationStatus('locating')
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const position = { lat: coords.latitude, lng: coords.longitude }
        setGuestPosition(position)
        setLocationLabel(copy.yourLocation)
        setLocationSource('device')
        setLocationStatus('ready')
        setIsLocationPickerOpen(false)
        saveGuestLocation({ position, label: copy.yourLocation, source: 'device' })
      },
      () => setLocationStatus('unavailable'),
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 300_000 },
    )
  }

  const selectAddress = (result: AddressSearchResult) => {
    const position = { lat: result.lat, lng: result.lng }
    setGuestPosition(position)
    setLocationLabel(result.label)
    setLocationSource('address')
    setLocationStatus('ready')
    setIsLocationPickerOpen(false)
    saveGuestLocation({ position, label: result.label, source: 'address' })
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

        <h1 className="sr-only">{copy.discoverTitle}</h1>

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
      </div>

      <section className="angle-discovery-cuisines" aria-label={copy.browseCuisine}>
        <div className="angle-discovery-cuisine-rail" role="group" aria-label={copy.filters}>
          {cuisines.map((cuisine) => (
            <button
              key={cuisine}
              type="button"
              className={activeCuisine === cuisine ? 'is-active' : ''}
              aria-pressed={activeCuisine === cuisine}
              onClick={() => setActiveCuisine((current) => current === cuisine ? null : cuisine)}
            >
              <span><CuisineArtwork cuisine={cuisine} /></span>
              <small>{cuisine}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="angle-discovery-controls" aria-label={copy.filters}>
        <div className="angle-discovery-controls-rail">
          <button
            className={`angle-discovery-control-icon${hasFilters ? ' is-active' : ''}`}
            type="button"
            aria-label={copy.filterRestaurants}
            onClick={() => setControlsView('filters')}
          >
            <SlidersIcon />
          </button>
          <button
            className={`angle-discovery-control-icon${sort !== 'distance' ? ' is-active' : ''}`}
            type="button"
            aria-label={`${copy.sortRestaurants}: ${sortLabel}`}
            onClick={() => setControlsView('sort')}
          >
            <SortIcon />
          </button>
          <button
            className={`angle-discovery-control-chip${sort === 'rating' ? ' is-active' : ''}`}
            type="button"
            aria-pressed={sort === 'rating'}
            onClick={() => setSort((current) => current === 'rating' ? 'distance' : 'rating')}
          >
            <span aria-hidden="true">★</span>{copy.topRestaurants}
          </button>
          <button
            className={`angle-discovery-control-chip${sort === 'newest' ? ' is-active' : ''}`}
            type="button"
            aria-pressed={sort === 'newest'}
            onClick={() => setSort((current) => current === 'newest' ? 'distance' : 'newest')}
          >
            {copy.newRestaurants}
          </button>
          <button
            className={`angle-discovery-control-chip${onlyOpen ? ' is-active' : ''}`}
            type="button"
            aria-pressed={onlyOpen}
            onClick={() => setOnlyOpen((current) => !current)}
          >
            <ClockIcon />{copy.openNow}
          </button>
        </div>
      </section>

      <div className="angle-discovery-content">

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
        {!restaurants.isPending && !restaurants.isError && filtered.length > 0 && (
          isFiltering ? (
            <section className="angle-discovery-section" aria-labelledby="results-heading">
              <div className="angle-discovery-section-title">
                <h2 id="results-heading">{activeCuisine || (sort !== 'distance' ? sortLabel : copy.searchResults)}</h2>
              </div>
              <div className="angle-discovery-grid">
                {filtered.map((restaurant) => (
                  <RestaurantCard
                    key={restaurant.id}
                    restaurant={restaurant}
                    copy={copy}
                    distance={distances.get(restaurant.id)}
                  />
                ))}
              </div>
            </section>
          ) : (
            <>
              <RestaurantRail
                title={copy.bookmarks}
                restaurants={favourites}
                copy={copy}
                distances={allDistances}
              />
              <RestaurantRail
                title={copy.recent}
                restaurants={recent}
                copy={copy}
                distances={allDistances}
              />
              <section className="angle-discovery-section" aria-labelledby="nearby-heading">
                <div className="angle-discovery-section-title">
                  <h2 id="nearby-heading">{copy.near}</h2>
                  <span>{locationLabel}</span>
                </div>
                <div className="angle-discovery-grid">
                  {filtered.map((restaurant) => (
                    <RestaurantCard
                      key={restaurant.id}
                      restaurant={restaurant}
                      copy={copy}
                      distance={distances.get(restaurant.id)}
                    />
                  ))}
                </div>
              </section>
            </>
          )
        )}
      </div>

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
          selectedLabel={locationLabel}
          selectionSource={locationSource}
          onClose={() => setIsLocationPickerOpen(false)}
          onUseCurrent={requestLocation}
          onSelectAddress={selectAddress}
        />
      )}
      {controlsView && (
        <DiscoveryControlsSheet
          view={controlsView}
          copy={copy}
          sort={sort}
          onlyOpen={onlyOpen}
          onlyFavourites={onlyFavourites}
          priceLevels={priceLevels}
          onSort={setSort}
          onOnlyOpen={setOnlyOpen}
          onOnlyFavourites={setOnlyFavourites}
          onTogglePrice={(level) => setPriceLevels((current) => current.includes(level)
            ? current.filter((value) => value !== level)
            : [...current, level])}
          onClear={() => {
            setOnlyOpen(false)
            setOnlyFavourites(false)
            setPriceLevels([])
          }}
          onClose={() => setControlsView(null)}
        />
      )}
    </main>
  )
}

function RestaurantDetailContent({ restaurant }: { restaurant: PublicRestaurant }) {
  const navigate = useNavigate()
  const { copy, dir } = useDiscoveryLocale()
  const [scannerOpen, setScannerOpen] = useState(false)
  const [isFavourite, setIsFavourite] = useState(
    () => readStoredRestaurantIds(FAVOURITE_RESTAURANTS_STORAGE_KEY).includes(restaurant.id),
  )
  const guestLocation = useMemo(() => readGuestLocation(), [])
  const distance = restaurant.coordinates
    ? distanceKm(guestLocation.position, restaurant.coordinates)
    : null
  const hours = todayHours(restaurant.hours, restaurant.timezone, copy)
  const menuHref = `/order/${restaurant.slug}?view=menu&browse=1`

  useEffect(() => {
    const recent = readStoredRestaurantIds(RECENT_RESTAURANTS_STORAGE_KEY)
    saveStoredRestaurantIds(
      RECENT_RESTAURANTS_STORAGE_KEY,
      [restaurant.id, ...recent.filter((id) => id !== restaurant.id)].slice(0, MAX_RECENT_RESTAURANTS),
    )
  }, [restaurant.id])

  const toggleFavourite = () => {
    setIsFavourite((current) => {
      const favourites = readStoredRestaurantIds(FAVOURITE_RESTAURANTS_STORAGE_KEY)
      const next = current
        ? favourites.filter((id) => id !== restaurant.id)
        : [restaurant.id, ...favourites.filter((id) => id !== restaurant.id)]
      saveStoredRestaurantIds(FAVOURITE_RESTAURANTS_STORAGE_KEY, next)
      return !current
    })
  }

  const openScannedMenu = (value: string) => {
    try {
      const url = new URL(value, window.location.origin)
      const trustedHost = url.host === window.location.host || url.host === 'menu.angle.co.il'
      if (!trustedHost || !url.pathname.startsWith('/order/')) return false
      navigate(`${url.pathname}${url.search}${url.hash}`)
      setScannerOpen(false)
      return true
    } catch {
      return false
    }
  }

  return (
    <main className="angle-venue" dir={dir}>
      <section className="angle-venue-hero" id="venue-gallery">
        <img src={restaurant.hero_url || fallbackHero} alt="" />
        <button type="button" className="angle-venue-back" onClick={() => navigate(-1)} aria-label={copy.back}>
          <ArrowIcon />
        </button>
        <button
          type="button"
          className={`angle-venue-favourite${isFavourite ? ' is-active' : ''}`}
          aria-label={isFavourite ? copy.removeFavourite : copy.favourite}
          aria-pressed={isFavourite}
          onClick={toggleFavourite}
        >
          <HeartIcon filled={isFavourite} />
        </button>
      </section>

      <section className="angle-venue-sheet">
        {restaurant.logo_url && (
          <img className="angle-venue-logo" src={restaurant.logo_url} alt={`${restaurant.name} ${copy.logo}`} />
        )}
        <h1>{restaurant.name}</h1>
        <div className="angle-venue-rating-line" id="venue-reviews">
          <Rating restaurant={restaurant} demo={copy.demo} />
          {distance != null && (
            <span className="angle-venue-distance"><PinIcon /> {formatDistance(distance)} {copy.kilometres}</span>
          )}
        </div>
        <p className="angle-venue-meta">
          <span>{restaurant.cuisine.join(' · ') || copy.restaurant}</span>
          {restaurant.price_level && <i aria-hidden="true">·</i>}
          <PriceLevel value={restaurant.price_level} label={copy.priceLevel} />
        </p>

        <nav className="angle-venue-actions" aria-label={copy.sections}>
          <Link to={menuHref}><MenuIcon /><span>{copy.menu}</span></Link>
          <a href="#venue-gallery"><PhotoIcon /><span>{copy.photos}</span></a>
          <a href="#venue-reviews"><ReviewsIcon /><span>{copy.reviews}</span></a>
          <a href="#venue-info"><InfoIcon /><span>{copy.info}</span></a>
        </nav>

        {restaurant.summary && <p className="angle-venue-summary" id="venue-info">{restaurant.summary}</p>}

        <section className="angle-venue-hours" aria-label={copy.workingHours}>
          <span className="angle-venue-hours__icon"><ClockIcon /></span>
          <div>
            <p>{copy.today}</p>
            <strong>{hours}</strong>
          </div>
        </section>

        <button type="button" className="angle-venue-scan" onClick={() => setScannerOpen(true)}>
          <span className="angle-venue-scan__icon"><QrIcon /></span>
          <span>
            <strong>{copy.scanQrMenu}</strong>
            <small>{copy.scanQrHint}</small>
          </span>
          <b aria-hidden="true">→</b>
        </button>

        {restaurant.features.reservations && (
          <Link className="angle-venue-secondary" to={`/reserve/${restaurant.slug}`}>
            {copy.reserveTable}
          </Link>
        )}

        {restaurant.rating?.source === 'demo' && (
          <p className="angle-venue-demo-note">
            {copy.demoNote(restaurant.rating.value.toFixed(1))}
          </p>
        )}
      </section>

      {scannerOpen && (
        <QrScannerDialog
          copy={copy}
          onClose={() => setScannerOpen(false)}
          onNavigate={openScannedMenu}
        />
      )}
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
