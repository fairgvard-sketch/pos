import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { t, formatTime, type Lang } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import {
  fetchPublicMenu, fetchPublicStatus, submitPublicOrder, PublicApiError, isViewOnlyMenu,
  type PublicItem, type PublicMenu, type PublicStatus, type PublicOrderType,
} from './publicApi'
import { parsePublicOrderQuery } from './orderContext'
import { readPublicCart, writePublicCart } from './publicCart'
import { updateInstalledMenuName } from './menuManifest'
import {
  menuBackgroundThemeColor,
  menuBackgroundUsesDarkUi,
  resolveMenuBackgroundUrl,
} from './menuBackgrounds'

/**
 * Публичная страница «закажи и забери» (050): меню → корзина → заявка →
 * ожидание подтверждения кассой. Оплата на кассе при получении.
 * Мобильная, he по умолчанию (гости кофейни), язык переключается.
 * Никакого Supabase-клиента: только Edge Functions с anon-ключом.
 */

const ACTIVE_KEY = 'kassa-public-active' // {clientUuid, locId} — текущая заявка
const BRANDED_HERO_VIDEOS: Record<string, string> = {
  // Developer showcase account: uploaded settings still take precedence.
  'fe2eebf0-65e3-45b4-a81f-331359d71955': '/brand/bulochka/hero.mp4',
}

/** «~20–35 мин» / «~20 мин» / '' — вилка приготовления для гостя (061) */
function formatPrepRange(lang: Lang, min: number, max: number): string {
  const hi = Math.max(min, max)
  if (hi <= 0) return ''
  const lo = min > 0 ? min : hi
  const num = lo === hi ? `${hi}` : `${lo}–${hi}`
  return `~${num} ${t(lang, 'minShort')}`
}

interface CartLine {
  key: string
  itemId: string
  name: string
  variantId: string | null
  variantName: string | null
  modIds: string[]
  modNames: string[]
  unitPrice: number // агороты, оценка для показа (сервер пересчитает)
  qty: number
}

function readActive(locId: string): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { clientUuid: string; locId: string }
    return parsed.locId === locId ? parsed.clientUuid : null
  } catch {
    return null
  }
}

export default function PublicOrderPage() {
  const { locId = '' } = useParams()
  const queryContext = useMemo(() => parsePublicOrderQuery(window.location.search), [])
  // Гостевая страница — всегда иврит (заказ he-first), без переключения языка.
  const lang: Lang = 'he'
  useEffect(() => {
    // <html lang> решает RTL в проде: start/end скомпилированы через :lang(he)
    document.documentElement.lang = lang
  }, [])
  const isRtl = true

  // Незавершённая заявка переживает перезагрузку страницы
  const [activeUuid, setActiveUuid] = useState<string | null>(() => readActive(locId))

  const [cart, setCart] = useState<CartLine[]>(() => readPublicCart(locId))
  const [view, setView] = useState<'menu' | 'checkout'>('menu')
  const [configItem, setConfigItem] = useState<PublicItem | null>(null)
  const [search, setSearch] = useState('')
  // null = экран плиток категорий; id = экран позиций категории
  const [activeCat, setActiveCat] = useState<string | null>(null)
  useEffect(() => { window.scrollTo(0, 0) }, [activeCat, view])

  const { data: menu, isLoading, isError } = useQuery({
    queryKey: ['public_menu', locId, queryContext.tableToken],
    queryFn: () => fetchPublicMenu(locId, queryContext.tableToken),
    staleTime: 30_000,
  })
  const menuBackground = resolveMenuBackgroundUrl(menu?.location.background_url)
  const installedMenuName = menu?.location.business_name || menu?.location.name
  useEffect(() => {
    if (!installedMenuName) return
    const previousTitle = document.title
    document.title = installedMenuName
    updateInstalledMenuName(installedMenuName)
    return () => { document.title = previousTitle }
  }, [installedMenuName])

  // Safari рисует safe-area и rubber-band из canvas документа. Поэтому
  // единственный экземпляр изображения живёт на <html>: он продолжается
  // под Dynamic Island и остаётся общим для всего сценария.
  useEffect(() => {
    if (!menuBackground) return

    const root = document.documentElement
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    const previousThemeColor = themeMeta?.content

    root.classList.add('public-menu-themed')
    root.classList.toggle('public-menu-dark', menuBackgroundUsesDarkUi(menuBackground))
    root.style.setProperty('--public-menu-background-image', `url(${JSON.stringify(menuBackground)})`)
    root.style.setProperty('--public-menu-theme-color', menuBackgroundThemeColor(menuBackground))
    themeMeta?.setAttribute('content', menuBackgroundThemeColor(menuBackground))

    return () => {
      root.classList.remove('public-menu-themed', 'public-menu-dark')
      root.style.removeProperty('--public-menu-background-image')
      root.style.removeProperty('--public-menu-theme-color')
      if (themeMeta && previousThemeColor) themeMeta.content = previousThemeColor
    }
  }, [menuBackground])

  const cartCount = cart.reduce((s, l) => s + l.qty, 0)
  const cartTotal = cart.reduce((s, l) => s + l.unitPrice * l.qty, 0)
  useEffect(() => { writePublicCart(locId, cart) }, [locId, cart])

  const normalizedSearch = search.trim().toLocaleLowerCase()
  const searchResults = useMemo(() => {
    if (!menu || !normalizedSearch) return []
    return menu.categories.flatMap((category) =>
      category.items
        .filter((item) =>
          `${item.name} ${item.description ?? ''}`.toLocaleLowerCase().includes(normalizedSearch)
        )
        .map((item) => ({ item, categoryName: category.name }))
    )
  }, [menu, normalizedSearch])
  const recommendations = useMemo(() => {
    if (!menu || cart.length === 0) return []
    const cartIds = new Set(cart.map((line) => line.itemId))
    const usedCategoryIds = new Set(
      menu.categories
        .filter((category) => category.items.some((item) => cartIds.has(item.id)))
        .map((category) => category.id)
    )
    const crossCategory = menu.categories
      .filter((category) => !usedCategoryIds.has(category.id))
      .flatMap((category) => category.items.slice(0, 1))
      .filter((item) => !cartIds.has(item.id))
    const fallback = menu.categories
      .flatMap((category) => category.items)
      .filter((item) => !cartIds.has(item.id) && !crossCategory.some((candidate) => candidate.id === item.id))
    return [...crossCategory, ...fallback].slice(0, 3)
  }, [menu, cart])

  // Пульс кнопки корзины при добавлении товара: key={bumpSeq} перезапускает
  // CSS-анимацию на каждом добавлении. bumping гаснет по таймауту (не по
  // animationend: в скрытой вкладке событие не приходит, класс бы «застрял»
  // и пульс проигрывался при каждом remount экрана)
  const [bumpSeq, setBumpSeq] = useState(0)
  const [bumping, setBumping] = useState(false)
  const prevCount = useRef(0)
  useEffect(() => {
    if (cartCount > prevCount.current) {
      setBumpSeq((s) => s + 1)
      setBumping(true)
    }
    prevCount.current = cartCount
  }, [cartCount])
  useEffect(() => {
    if (!bumping) return
    const timer = setTimeout(() => setBumping(false), 400) // анимация 0.28s + запас
    return () => clearTimeout(timer)
  }, [bumping, bumpSeq])

  function addLine(line: Omit<CartLine, 'key' | 'qty'>) {
    setCart((prev) => {
      const same = prev.find(
        (l) =>
          l.itemId === line.itemId &&
          l.variantId === line.variantId &&
          l.modIds.length === line.modIds.length &&
          l.modIds.every((id, i) => id === line.modIds[i])
      )
      if (same) return prev.map((l) => (l.key === same.key ? { ...l, qty: l.qty + 1 } : l))
      return [...prev, { ...line, key: Math.random().toString(36).slice(2), qty: 1 }]
    })
  }

  function updateQty(key: string, qty: number) {
    setCart((prev) => (qty <= 0 ? prev.filter((l) => l.key !== key) : prev.map((l) => (l.key === key ? { ...l, qty } : l))))
  }

  function startNewOrder() {
    localStorage.removeItem(ACTIVE_KEY)
    setActiveUuid(null)
    setCart([])
    setView('menu')
  }

  function openItem(item: PublicItem) {
    // Карточка товара — часть витрины: любой товар сначала раскрывается
    // крупно с фото, описанием и ценой. Это сохраняет предсказуемый UX и
    // не добавляет простые позиции в корзину неожиданно по тапу по карточке.
    setConfigItem(item)
  }

  // ── Экран статуса активной заявки ──────────────────────────
  if (activeUuid) {
    return (
      <Shell
        isRtl={isRtl}
        title={menu?.location.business_name || menu?.location.name}
        logo={menu?.location.logo_url}
        bgImg={menuBackground}
      >
        <StatusScreen lang={lang} clientUuid={activeUuid} onNewOrder={startNewOrder} />
      </Shell>
    )
  }

  // Сплэш Angle держится, пока грузится меню (done=false), и растворяется,
  // когда данные пришли. Первым ребёнком фрагмента во всех трёх ветках —
  // React сохраняет его состояние и анимация не перезапускается.
  if (isLoading) {
    return (
      <Shell isRtl={isRtl}>
        <MenuSkeleton lang={lang} />
      </Shell>
    )
  }
  if (isError || !menu) {
    return (
      <Shell isRtl={isRtl}>
        <div className="min-h-[70vh] px-6 flex items-center justify-center text-center">
          <div>
            <div className="w-12 h-12 mx-auto rounded-2xl bg-rose-50 text-rose-700 flex items-center justify-center text-2xl font-black" aria-hidden>!</div>
            <p className="mt-4 text-lg font-bold text-gray-900">{t(lang, 'pubMenuError')}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 h-12 px-6 rounded-2xl bg-gray-900 text-white font-bold active:scale-[0.98] transition-transform"
            >
              {t(lang, 'pubRetry')}
            </button>
          </div>
        </div>
      </Shell>
    )
  }
  // Организация без модуля online_orders (100): чистая витрина. Меню видно
  // всегда — без корзины, чекаута и баннеров «закрыто/пауза» (смены у
  // menu-only организации не бывает, вечное «закрыто» — ложь для гостя).
  const viewOnly = isViewOnlyMenu(menu.location)
  const orderTypes = menu.location.order_types ?? ['here', 'takeaway']
  const tableContext = menu.order_context?.kind === 'table' ? menu.order_context : null
  const requestedType = queryContext.requestedType
  const initialOrderType: PublicOrderType =
    tableContext
      ? 'here'
      : requestedType && orderTypes.includes(requestedType)
      ? requestedType
      : orderTypes[0] ?? 'takeaway'
  return (
    <Shell
      isRtl={isRtl}
      title={menu.location.business_name || menu.location.name}
      logo={menu.location.logo_url}
      hero={view === 'menu' && !activeCat}
      headerImg={menu.location.header_url}
      heroVideo={menu.location.hero_video_url ?? BRANDED_HERO_VIDEOS[locId] ?? null}
      bgImg={menuBackground}
      // Возврат в шапке: из чекаута → к меню, из категории → к плиткам
      onBack={
        view === 'checkout' ? () => setView('menu')
        : activeCat ? () => setActiveCat(null)
        : undefined
      }
      backLabel={t(lang, 'back')}
    >
      {viewOnly ? null : menu.location.accepting === false ? (
        <div className="mx-4 mt-4 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3">
          {/* Пауза с кассы (054) — говорим, когда приём вернётся */}
          {menu.location.paused_until
            ? `${t(lang, 'pubPausedUntil')} ${formatTime(menu.location.paused_until, lang)}`
            : t(lang, 'pubPaused')}
        </div>
      ) : !menu.location.is_open && (
        <div className="mx-4 mt-4 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3">
          {t(lang, 'pubClosed')}
        </div>
      )}
      {!viewOnly && menu.context_error && (
        <div className="mx-4 mt-4 rounded-2xl bg-rose-50 text-rose-800 text-sm font-semibold px-4 py-3">
          {t(lang, menu.context_error === 'table_ordering_disabled'
            ? 'pubTableOrderingDisabled'
            : 'pubTableQrExpired')}
        </div>
      )}

      {view === 'menu' && !activeCat && (
        // Главный экран: сетка плиток фикс. пропорции (aspect-4/3 — ряды ровные),
        // распорка flex-1 толкает подвал к низу экрана при коротком меню
        <>
          <div className="public-menu-home-tools px-4">
            {menu.order_context?.kind === 'table' ? (
              <OrderContextPill
                label={menu.order_context.label}
                zone={menu.order_context.zone}
                lang={lang}
              />
            ) : viewOnly ? null : (
              <PickupContextPill
                lang={lang}
                type={initialOrderType}
                requiresChoice={orderTypes.length > 1}
              />
            )}
            <SearchField value={search} onChange={setSearch} lang={lang} />
          </div>

          {normalizedSearch ? (
            <div className="px-4 mt-4 pb-24">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-gray-600">
                  {t(lang, 'pubSearchResults')} · {searchResults.length}
                </h2>
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="h-11 px-4 rounded-xl text-sm font-semibold text-gray-600 bg-white/90 ring-1 ring-black/10 active:scale-[0.97] transition-all"
                >
                  {t(lang, 'pubClear')}
                </button>
              </div>
              {searchResults.length > 0 ? (
                <div className="space-y-2">
                  {searchResults.map(({ item, categoryName }) => (
                    <div key={item.id}>
                      <div className="text-xs font-semibold text-gray-500 mb-1 px-1">{categoryName}</div>
                      <ItemRow item={item} lang={lang} onTap={() => openItem(item)} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl bg-white/90 ring-1 ring-black/10 px-5 py-10 text-center text-sm font-semibold text-gray-500">
                  {t(lang, 'pubSearchEmpty')}
                </div>
              )}
            </div>
          ) : (
            <div className="public-menu-category-grid px-4 mt-4">
              {menu.categories.map((cat, index) => {
                // Обложка плитки (080): своя картинка категории, иначе фото первого товара
                const cover = cat.cover_url ?? cat.items.find((i) => i.image_url)?.image_url
                return (
                  <button
                    key={cat.id}
                    onClick={() => setActiveCat(cat.id)}
                    className={`public-menu-category-card${index === 0 ? ' is-featured' : ''}`}
                  >
                    {cover && <CategoryCover src={cover} />}
                    <span className="public-menu-category-shade" />
                    <span className="public-menu-category-copy">
                      <strong>{cat.name}</strong>
                      <small>{cat.items.length}</small>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          <div className="flex-1" />
          {!normalizedSearch && <SocialFooter links={menu.location.links} lang={lang} padForCart={cartCount > 0} />}
        </>
      )}

      {view === 'menu' && activeCat && (() => {
        const cat = menu.categories.find((c) => c.id === activeCat)
        if (!cat) return null
        return (
          <>
            {/* Чипы быстрого перехода между категориями (возврат к плиткам — стрелка в шапке) */}
            <CategoryChips categories={menu.categories} activeCat={activeCat} onSelect={setActiveCat} />
            <div className="public-menu-products-section px-4 pb-32">
              <div className="public-menu-section-heading">
                <h2 className="public-menu-section-title">{cat.name}</h2>
                <span className="public-menu-section-count">{cat.items.length}</span>
              </div>
              <div className="public-menu-product-grid">
                {cat.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    lang={lang}
                    layout="grid"
                    onTap={() => openItem(item)}
                  />
                ))}
              </div>
            </div>
          </>
        )
      })()}

      {view === 'menu' && cartCount > 0 && (
        <CartBar
          key={bumpSeq}
          lang={lang}
          count={cartCount}
          total={cartTotal}
          bumping={bumping}
          onOpen={() => setView('checkout')}
        />
      )}

      {view === 'checkout' && (
        <CheckoutScreen
          lang={lang}
          locId={locId}
          isOpen={menu.location.is_open && menu.location.accepting !== false}
          prepMin={menu.location.prep_min ?? 0}
          prepMax={menu.location.prep_max ?? 0}
          orderTypes={tableContext ? ['here'] : orderTypes}
          initialOrderType={initialOrderType}
          tableContext={tableContext}
          tableToken={tableContext ? queryContext.tableToken : null}
          orderChannel={queryContext.channel}
          recommendations={recommendations}
          cart={cart}
          total={cartTotal}
          onQty={updateQty}
          onRecommend={openItem}
          onSubmitted={(clientUuid) => {
            localStorage.setItem(ACTIVE_KEY, JSON.stringify({ clientUuid, locId }))
            setActiveUuid(clientUuid)
            setCart([])
            setView('menu')
          }}
        />
      )}

      {configItem && (
        <ItemConfigSheet
          item={configItem}
          lang={lang}
          isRtl={isRtl}
          viewOnly={viewOnly}
          onClose={() => setConfigItem(null)}
          onAdd={(line) => {
            addLine(line)
            setConfigItem(null)
          }}
        />
      )}
    </Shell>
  )
}

/**
 * Каркас страницы. Два режима шапки:
 * hero — главный экран плиток: крупный логотип и название по центру;
 * компактная sticky-шапка (h-14) — категории/корзина/статус, к ней
 * привязаны чипы навигации (sticky top-14).
 * Оформление (Настройки → Онлайн-заказы): headerImg — баннер вместо
 * белой hero-шапки; bgImg — единый фон всего гостевого сценария:
 * категории, товары, корзина и статус заказа сохраняют выбранное оформление.
 * Фон находится на canvas документа, поэтому единым полотном проходит под
 * системной safe-area, заголовком, содержимым и подвалом. Внутри Shell нет
 * второго изображения или цветовой плёнки.
 */
function Shell({ isRtl, title, logo, hero, headerImg, heroVideo, bgImg, onBack, backLabel, children }: {
  isRtl: boolean
  title?: string
  logo?: string | null
  hero?: boolean
  headerImg?: string | null
  heroVideo?: string | null
  bgImg?: string | null
  /** Стрелка возврата в компактной шапке (не hero); заменяет in-body «Назад» */
  onBack?: () => void
  backLabel?: string
  children: React.ReactNode
}) {
  const hasBg = !!bgImg
  const reducedMotion = usePrefersReducedMotion()
  const hasHeroMedia = !!heroVideo || !!headerImg
  const openMenu = () => {
    document.getElementById('public-menu-content')?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'start',
    })
  }
  return (
    // ВАЖНО (iOS Safari): не вешать overflow-x-clip на корень — clip на
    // предке ломает position:fixed у потомков (иконка корзины и нижняя
    // панель скроллятся со страницей). И не гасить сдвиг через overflow-x
    // на html — это отключает заход контента под нижний тулбар Safari
    // (фон обрезается полосой). Сдвиг гасится overscroll-behavior-x
    // на html/body в index.css.
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className={`public-menu-shell min-h-screen ${hasBg ? 'bg-transparent' : 'bg-[#eceef1]'}`}
    >
      <div className={`public-menu-frame relative mx-auto min-h-screen flex flex-col ${hasBg ? '' : 'bg-white'}`}>
        {hero ? (
          <header className={`public-menu-hero${hasHeroMedia ? ' has-media' : ' is-brand-only'}`}>
            {heroVideo ? (
              <video
                key={heroVideo}
                src={heroVideo}
                poster={headerImg ?? undefined}
                autoPlay={!reducedMotion}
                muted
                loop
                playsInline
                preload={reducedMotion ? 'none' : 'metadata'}
                aria-hidden="true"
                className="public-menu-hero-media"
              />
            ) : headerImg ? (
              <img
                src={headerImg}
                alt=""
                className="public-menu-hero-media"
              />
            ) : null}
            <span className="public-menu-hero-scrim" />
            <div className="public-menu-hero-brand">
              {logo ? (
                <img src={logo} alt="" className="public-menu-hero-logo" />
              ) : (
                <span className="public-menu-hero-monogram" aria-hidden>
                  {(title ?? '').slice(0, 1)}
                </span>
              )}
            </div>
            <div className="public-menu-hero-copy">
              <h1 className="font-display">{title ?? ''}</h1>
            </div>
            <button
              type="button"
              className="public-menu-hero-scroll"
              onClick={openMenu}
              aria-label="פתיחת התפריט"
            >
              <span>לתפריט</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </header>
        ) : (
          <header
            className="public-menu-compact-header sticky top-0 z-10 bg-white border-b border-gray-100 px-4 flex items-center justify-center relative"
            style={{
              height: 'calc(3.5rem + env(safe-area-inset-top))',
              paddingTop: 'env(safe-area-inset-top)',
            }}
          >
            {/* У начала строки: стрелка возврата (если есть) либо логотип; название — по центру */}
            {onBack ? (
              <button
                onClick={onBack}
                aria-label={backLabel}
                className="public-menu-back-button absolute left-2 h-11 px-4 rounded-full bg-gray-900 text-white shadow-md shadow-black/15 flex items-center gap-1.5 text-sm font-bold active:scale-[0.96] transition-all"
              >
                {/* Пилюля возврата всегда слева (левый край экрана), стрелка смотрит влево */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                <span>{backLabel}</span>
              </button>
            ) : (
              logo && <img src={logo} alt="" className="absolute start-4 w-9 h-9 rounded-full object-cover" />
            )}
            <span className="public-menu-header-title font-display px-14 text-center font-bold text-xl text-gray-900 truncate">
              {title ?? ''}
            </span>
          </header>
        )}
        <div
          id={hero ? 'public-menu-content' : undefined}
          className={`flex-1 flex flex-col${hero ? ' public-menu-content-after-hero' : ''}`}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

/** Не запускаем декоративный hero, если пользователь отключил анимацию в ОС. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

function MenuSkeleton({ lang }: { lang: Lang }) {
  return (
    <div aria-busy="true" aria-label={t(lang, 'loading')} className="px-4 py-6 motion-reduce:[&_*]:animate-none">
      <div className="h-72 rounded-[2rem] bg-gray-200 animate-pulse" />
      <div className="h-12 mt-4 rounded-2xl bg-gray-200 animate-pulse" />
      <div className="grid grid-cols-2 gap-3 mt-4">
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <div key={item} className="aspect-[4/3] rounded-2xl bg-gray-200 animate-pulse" />
        ))}
      </div>
    </div>
  )
}

function PickupContextPill({ lang, type, requiresChoice }: {
  lang: Lang
  type: PublicOrderType
  requiresChoice: boolean
}) {
  const fulfilment = requiresChoice
    ? t(lang, 'pubChooseAtCheckout')
    : t(lang, type === 'delivery'
      ? 'pubDeliveryContext'
      : type === 'here'
        ? 'pubCounterHere'
        : 'pubCounterTakeaway')

  return (
    <div className="mb-3 min-h-12 rounded-2xl bg-white/90 ring-1 ring-black/10 shadow-sm px-4 py-3 flex items-center gap-3">
      <span className="w-9 h-9 rounded-xl bg-gray-900 text-white flex items-center justify-center shrink-0" aria-hidden>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 9h14l-1 11H6L5 9Z" strokeLinejoin="round" />
          <path d="M8 9V7a4 4 0 0 1 8 0v2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-gray-500">{t(lang, 'pubFulfilment')}</span>
        <span className="block font-bold text-gray-900 truncate">{fulfilment}</span>
      </span>
      <span className="ms-auto text-xs font-bold text-gray-700 bg-gray-100 rounded-full px-3 py-1.5 shrink-0">
        {t(lang, 'pubNoOnlinePayment')}
      </span>
    </div>
  )
}

function CartBar({ lang, count, total, bumping, onOpen }: {
  lang: Lang
  count: number
  total: number
  bumping: boolean
  onOpen: () => void
}) {
  return (
    <div className="fixed bottom-0 inset-x-0 z-30 pointer-events-none">
      <div
        className="public-menu-frame mx-auto px-4 pt-6 bg-gradient-to-t from-black/30 via-black/10 to-transparent"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${t(lang, 'pubShowItems')}: ${count}, ${formatMoney(total, lang)}`}
          className={`pointer-events-auto w-full min-h-14 rounded-2xl bg-gray-900 text-white ps-2 pe-5 flex items-center gap-3 active:scale-[0.98] transition-all shadow-xl shadow-black/20 ${bumping ? 'cart-bump' : ''}`}
        >
          <span className="w-10 h-10 shrink-0 rounded-xl bg-white text-gray-900 font-black flex items-center justify-center tabular-nums" aria-live="polite">
            {count}
          </span>
          <span className="font-bold">{t(lang, 'pubShowItems')}</span>
          <span className="ms-auto font-black text-lg tabular-nums" dir="ltr">{formatMoney(total, lang)}</span>
        </button>
      </div>
    </div>
  )
}

/**
 * Подвал главного экрана: Instagram / Facebook / отзыв в Google.
 * Ссылки настраиваются в кассе (Настройки → Обслуживание → Онлайн-заказы);
 * пустая ссылка = кнопки нет. padForCart — просвет под фиксированной
 * кнопкой корзины.
 *
 * Действия стоят прямо на общем фоне без отдельной полосы. Контраст даёт
 * собственная подложка каждой кнопки. После них идёт прозрачная safe-зона:
 * нижняя панель Safari перекрывает фон, а не ссылки и кнопку отзыва.
 */
/**
 * Обложка плитки категории. Горизонтальные фото заполняют карточку
 * (object-cover, стиль Wolt); вертикальные (стакан, бутылка) в cover-кропе
 * теряют верх и низ — такие показываем целиком на белом фоне: фото меню
 * студийные, на белом, поэтому подложка сливается с фоном снимка.
 */
/**
 * Полоса чипов категорий. Скроллбар скрыт (на десктопе рисовал линию под
 * чипами); вместо него прокрутка перетаскиванием самих чипов мышью —
 * на тач-экранах и так работает свайп. Клик после протяжки гасится,
 * чтобы drag не срабатывал как выбор категории. Активный чип сам
 * подъезжает в видимую зону.
 */
function OrderContextPill({ label, zone, lang }: {
  label: string
  zone: string | null
  lang: Lang
}) {
  return (
    <div className="mb-3 min-h-12 rounded-2xl bg-white/90 ring-1 ring-black/10 shadow-sm px-4 py-3 flex items-center gap-3">
      <span className="w-9 h-9 rounded-xl bg-gray-900 text-white flex items-center justify-center shrink-0" aria-hidden>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 10h16M6 10v8M18 10v8M8 6h8l2 4H6l2-4Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-gray-500">{t(lang, 'pubOrderingFor')}</span>
        <span className="block font-bold text-gray-900 truncate">
          {t(lang, 'pubTable')} {label}{zone ? ` · ${zone}` : ''}
        </span>
      </span>
      <span className="ms-auto text-xs font-bold text-emerald-700 bg-emerald-50 rounded-full px-3 py-1.5">
        {t(lang, 'pubDetected')}
      </span>
    </div>
  )
}

function SearchField({ value, onChange, lang }: {
  value: string
  onChange: (value: string) => void
  lang: Lang
}) {
  return (
    <label className="relative block">
      <span className="sr-only">{t(lang, 'pubSearch')}</span>
      <svg
        className="absolute start-4 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t(lang, 'pubSearch')}
        className="w-full h-12 rounded-2xl bg-white/95 ring-1 ring-black/10 shadow-sm ps-12 pe-4 text-base text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900/70"
      />
    </label>
  )
}

function CategoryChips({ categories, activeCat, onSelect }: {
  categories: PublicMenu['categories']
  activeCat: string
  onSelect: (id: string) => void
}) {
  const navRef = useRef<HTMLElement>(null)
  const drag = useRef({ down: false, moved: false, startX: 0, startLeft: 0 })

  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [activeCat])

  return (
    <nav
      ref={navRef}
      className="public-menu-category-nav sticky z-10 bg-white/95 backdrop-blur border-b border-gray-100 px-4 py-2 flex gap-2 overflow-x-auto select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ top: 'calc(3.5rem + env(safe-area-inset-top))' }}
      onMouseDown={(e) => {
        drag.current = { down: true, moved: false, startX: e.clientX, startLeft: navRef.current?.scrollLeft ?? 0 }
      }}
      onMouseMove={(e) => {
        if (!drag.current.down || !navRef.current) return
        const dx = e.clientX - drag.current.startX
        if (Math.abs(dx) > 4) drag.current.moved = true
        navRef.current.scrollLeft = drag.current.startLeft - dx
      }}
      onMouseUp={() => { drag.current.down = false }}
      onMouseLeave={() => { drag.current.down = false }}
      onClickCapture={(e) => {
        if (drag.current.moved) {
          e.preventDefault()
          e.stopPropagation()
          drag.current.moved = false
        }
      }}
    >
      {categories.map((c) => (
        <button
          key={c.id}
          data-active={c.id === activeCat || undefined}
          onClick={() => onSelect(c.id)}
          className={`public-menu-category-chip h-11 px-4 rounded-full text-sm font-semibold whitespace-nowrap transition-all active:scale-[0.96] shrink-0 ${
            c.id === activeCat ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
          }`}
        >
          {c.name}
        </button>
      ))}
    </nav>
  )
}

function CategoryCover({ src }: { src: string }) {
  const [contain, setContain] = useState(false)
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onLoad={(e) => {
        const img = e.currentTarget
        if (img.naturalHeight > img.naturalWidth) setContain(true)
      }}
      className={`absolute inset-0 w-full h-full ${contain ? 'object-contain bg-white p-2' : 'object-cover'}`}
    />
  )
}

function SocialFooter({ links, lang, padForCart }: {
  links?: PublicMenu['location']['links']
  lang: Lang
  padForCart: boolean
}) {
  const iconBtn =
    'w-12 h-12 shrink-0 rounded-full bg-black/75 ring-1 ring-white/15 text-white shadow-lg shadow-black/25 flex items-center justify-center active:scale-[0.94] transition-all'
  const hasAny = !!(links?.instagram || links?.facebook || links?.google_review)
  if (!hasAny) return padForCart ? <div className="pb-24" /> : null
  return (
    <>
      <footer className="mt-6 px-4 py-4">
        <div className="mx-auto flex max-w-md flex-wrap items-center justify-center gap-2.5">
          {(links?.instagram || links?.facebook) && (
            <div className="flex items-center gap-2">
              {links?.instagram && (
                <a href={links.instagram} target="_blank" rel="noopener noreferrer" aria-label="Instagram" className={iconBtn}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <rect x="3" y="3" width="18" height="18" rx="5" />
                    <circle cx="12" cy="12" r="4" />
                    <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" stroke="none" />
                  </svg>
                </a>
              )}
              {links?.facebook && (
                <a href={links.facebook} target="_blank" rel="noopener noreferrer" aria-label="Facebook" className={iconBtn}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
                    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
                  </svg>
                </a>
              )}
            </div>
          )}
          {links?.google_review && (
            <a
              href={links.google_review}
              target="_blank"
              rel="noopener noreferrer"
              className="h-12 max-w-full px-5 rounded-full bg-black/75 ring-1 ring-white/15 text-sm font-semibold text-white shadow-lg shadow-black/25 flex items-center justify-center gap-2 active:scale-[0.96] transition-all"
            >
              <svg className="shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
              </svg>
              <span className="truncate">{t(lang, 'pubReviewGoogle')}</span>
            </a>
          )}
        </div>
      </footer>
      <div
        aria-hidden
        className={padForCart ? 'h-28 shrink-0' : 'h-[calc(env(safe-area-inset-bottom)+3rem)] shrink-0'}
      />
    </>
  )
}

/**
 * Карточка товара — классический вид меню доставки: фото, название,
 * цена. Без фото — плейсхолдер с первой буквой названия,
 * чтобы список не «прыгал» по выравниванию.
 */
function ItemRow({ item, lang, onTap, layout = 'row' }: {
  item: PublicItem
  lang: Lang
  onTap: () => void
  layout?: 'row' | 'grid'
}) {
  const prices = item.variants.length > 0 ? item.variants.map((v) => v.price) : [item.price]
  const minPrice = Math.min(...prices)
  const hasRange = new Set(prices).size > 1
  return (
    <button
      onClick={onTap}
      className={`public-menu-item-card is-${layout}`}
    >
      <span className="public-menu-item-media">
        {item.image_url ? (
          <img src={item.image_url} alt="" loading="lazy" />
        ) : (
          <span className="public-menu-item-placeholder" aria-hidden>
            {item.name.slice(0, 1)}
          </span>
        )}
      </span>
      <span className="public-menu-item-body">
        <strong className="public-menu-item-primary">{item.name}</strong>
        {item.description && (
          <span className="public-menu-item-muted">{item.description}</span>
        )}
        <span className="public-menu-item-footer">
          <span className="public-menu-item-price">
            {hasRange && <span className="public-menu-item-price-prefix">{t(lang, 'pubFrom')} </span>}
            {/* dir=ltr: цена не пляшет в bidi-контексте ивритских названий */}
            <span dir="ltr">{formatMoney(minPrice, lang)}</span>
          </span>
          <span className="public-menu-item-action" aria-hidden>
            {item.variants.length > 0 || item.modifier_groups.length > 0 ? '⋯' : '+'}
          </span>
        </span>
      </span>
    </button>
  )
}

/** Конфигуратор позиции: размер, модификаторы (min/max по группе), количество */
function ItemConfigSheet({ item, lang, isRtl, viewOnly = false, onClose, onAdd }: {
  item: PublicItem
  lang: Lang
  isRtl: boolean
  /** Витрина без модуля заказов (100): карточка только показывает состав/цену */
  viewOnly?: boolean
  onClose: () => void
  onAdd: (line: Omit<CartLine, 'key' | 'qty'>) => void
}) {
  const defaultVariant = item.variants.find((v) => v.is_default) ?? item.variants[0] ?? null
  const [variantId, setVariantId] = useState<string | null>(defaultVariant?.id ?? null)
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Дефолтные модификаторы — предвыбраны (в пределах max_select группы)
    const initial = new Set<string>()
    for (const g of item.modifier_groups) {
      let picked = 0
      for (const m of g.modifiers) {
        if (m.is_default && (g.max_select === 0 || picked < g.max_select)) {
          initial.add(m.id)
          picked++
        }
      }
    }
    return initial
  })
  const [qty, setQty] = useState(1)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const variant = item.variants.find((v) => v.id === variantId) ?? null
  const base = variant?.price ?? item.price
  const modsDelta = item.modifier_groups
    .flatMap((g) => g.modifiers)
    .filter((m) => selected.has(m.id))
    .reduce((s, m) => s + m.price_delta, 0)
  const unit = base + modsDelta

  // min_select всех групп должен быть соблюдён
  const missingGroup = item.modifier_groups.find(
    (g) => g.modifiers.filter((m) => selected.has(m.id)).length < g.min_select
  )

  function toggleMod(groupId: string, modId: string) {
    const group = item.modifier_groups.find((g) => g.id === groupId)!
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(modId)) {
        next.delete(modId)
        return next
      }
      const inGroup = group.modifiers.filter((m) => next.has(m.id))
      if (group.max_select === 1) {
        // Радио-поведение: выбор заменяет предыдущий
        for (const m of inGroup) next.delete(m.id)
      } else if (group.max_select > 0 && inGroup.length >= group.max_select) {
        return next // лимит достигнут
      }
      next.add(modId)
      return next
    })
  }

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="public-menu-item-overlay fixed inset-0 z-40 flex items-end justify-center"
      onClick={onClose}
    >
      <div
        className="public-menu-item-sheet relative w-full bg-white overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-item-sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Крестик — плавающей кнопкой в верхнем углу карточки (над фото).
            start в RTL — правый край: закрытие под большим пальцем, не спорит
            с заголовком; фон полупрозрачный, читаем и на фото, и на белом */}
        <button
          onClick={onClose}
          aria-label={t(lang, 'close')}
          autoFocus
          className="public-menu-item-close"
        >
          ✕
        </button>

        <div className="public-menu-item-detail-hero">
          {item.image_url ? (
            <img src={item.image_url} alt="" className="public-menu-item-detail-image" />
          ) : (
            <span className="public-menu-item-detail-placeholder" aria-hidden>
              {item.name.slice(0, 1)}
            </span>
          )}
          <span className="public-menu-item-detail-fade" />
          <div className="public-menu-item-detail-copy">
            <h3 id="public-item-sheet-title">{item.name}</h3>
            <div className="public-menu-item-detail-price" dir="ltr">
              {formatMoney(unit, lang)}
            </div>
          </div>
        </div>

        <div className="public-menu-item-options">
          {item.description && (
            <p className="public-menu-item-detail-description">{item.description}</p>
          )}
          {item.variants.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {item.variants.map((v) => (
                <Chip key={v.id} active={variantId === v.id} onClick={() => setVariantId(v.id)}>
                  {v.name} · <span dir="ltr">{formatMoney(v.price, lang)}</span>
                </Chip>
              ))}
            </div>
          )}

          {item.modifier_groups.map((g) => (
            <div key={g.id}>
              <div className="text-sm font-bold text-gray-500 mb-2">
                {g.name}
                {g.min_select > 0 && <span className="text-gray-400 font-normal"> · {t(lang, 'pubRequired')}</span>}
              </div>
              <div className="flex gap-2 flex-wrap">
                {g.modifiers.map((m) => (
                  <Chip key={m.id} active={selected.has(m.id)} onClick={() => toggleMod(g.id, m.id)}>
                    {m.name}
                    {m.price_delta !== 0 && <span dir="ltr"> +{formatMoney(m.price_delta, lang)}</span>}
                  </Chip>
                ))}
              </div>
            </div>
          ))}

        </div>

        {!viewOnly && (
        <div className="public-menu-item-submit">
          {/* Количество + добавление — одна полоса: степпер слева, кнопка справа */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 shrink-0">
              <Stepper onClick={() => setQty((q) => Math.max(1, q - 1))}>−</Stepper>
              <span className="w-8 text-center font-bold tabular-nums text-gray-900">{qty}</span>
              <Stepper onClick={() => setQty((q) => Math.min(99, q + 1))}>+</Stepper>
            </div>
            <button
              disabled={!!missingGroup}
              onClick={() => {
                const mods = item.modifier_groups.flatMap((g) => g.modifiers).filter((m) => selected.has(m.id))
                for (let i = 0; i < qty; i++) {
                  onAdd({
                    itemId: item.id,
                    name: item.name,
                    variantId: variant?.id ?? null,
                    variantName: variant?.name ?? null,
                    modIds: mods.map((m) => m.id),
                    modNames: mods.map((m) => m.name),
                    unitPrice: unit,
                  })
                }
              }}
              className="flex-1 min-w-0 h-14 rounded-2xl bg-gray-900 text-white font-bold disabled:opacity-40
                         active:scale-[0.98] transition-all flex items-center justify-center gap-2 px-4"
            >
              {missingGroup ? (
                <span className="truncate">{`${t(lang, 'pubChoose')}: ${missingGroup.name}`}</span>
              ) : (
                <>
                  <span>{t(lang, 'pubAdd')}</span>
                  <span className="tabular-nums" dir="ltr">{formatMoney(unit * qty, lang)}</span>
                </>
              )}
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

/** Корзина + форма контактов + отправка заявки */
function CheckoutScreen({
  lang, locId, isOpen, prepMin, prepMax, orderTypes, initialOrderType,
  tableContext, tableToken, orderChannel, recommendations, cart, total,
  onQty, onRecommend, onSubmitted,
}: {
  lang: Lang
  locId: string
  isOpen: boolean
  /** Время приготовления — вилка мин–макс (061): 0/0 = не показывать */
  prepMin: number
  prepMax: number
  orderTypes: PublicOrderType[]
  initialOrderType: PublicOrderType
  tableContext: PublicMenu['order_context']
  tableToken: string | null
  orderChannel: 'link' | 'counter_qr' | 'table_qr' | 'website' | 'social'
  recommendations: PublicItem[]
  cart: CartLine[]
  total: number
  onQty: (key: string, qty: number) => void
  onRecommend: (item: PublicItem) => void
  onSubmitted: (clientUuid: string) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [asap, setAsap] = useState(true)
  const [time, setTime] = useState('')
  const [note, setNote] = useState('')
  // Тип заказа: первый включённый по умолчанию. Если включён один —
  // вопрос не показываем (нечего выбирать).
  const [orderType, setOrderType] = useState<PublicOrderType>(initialOrderType)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showValidation, setShowValidation] = useState(false)
  // client_uuid создаётся один раз на попытку оформления: ретрай после
  // сбоя сети не создаст дубликат (идемпотентность submit_online_order)
  const clientUuid = useMemo(() => crypto.randomUUID(), [])

  const phoneDigits = phone.replace(/\D/g, '')
  const isTableOrder = tableContext?.kind === 'table' && !!tableToken
  const addressOk = orderType !== 'delivery' || address.trim().length > 0
  const contactOk = isTableOrder || (name.trim().length > 0 && phoneDigits.length >= 9)
  const timeOk = isTableOrder || asap || time !== ''
  const valid = cart.length > 0 && contactOk && timeOk && addressOk
  const validationText = !name.trim() && !isTableOrder
    ? t(lang, 'pubErrName')
    : phoneDigits.length < 9 && !isTableOrder
      ? t(lang, 'pubErrPhone')
      : !addressOk
        ? t(lang, 'pubErrAddress')
        : !timeOk
          ? t(lang, 'pubErrTime')
          : cart.length === 0
            ? t(lang, 'pubErrEmptyCart')
            : null

  async function submit() {
    if (!valid) {
      setShowValidation(true)
      return
    }
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      let pickupIso: string | null = null
      if (!isTableOrder && !asap && time) {
        const [h, m] = time.split(':').map(Number)
        const d = new Date()
        d.setHours(h, m, 0, 0)
        // Время сегодняшнего дня; прошедшее сервер трактует как «как можно скорее»
        pickupIso = d.toISOString()
      }
      await submitPublicOrder({
        loc: locId,
        client_uuid: clientUuid,
        // За столом контакт не обязателен: проверенный table-token — контекст
        // доставки и ключ антиспама. Сервер снапшотит label сам.
        name: isTableOrder ? '' : name.trim(),
        phone: isTableOrder ? '' : phoneDigits,
        pickup_at: pickupIso,
        note: note.trim() || null,
        order_type: orderType,
        delivery_address: orderType === 'delivery' ? address.trim() : null,
        table_token: isTableOrder ? tableToken : null,
        order_channel: orderChannel,
        items: cart.map((l) => ({
          menu_item_id: l.itemId,
          variant_id: l.variantId,
          modifier_ids: l.modIds,
          qty: l.qty,
          notes: null,
        })),
      })
      onSubmitted(clientUuid)
    } catch (e) {
      const code = e instanceof PublicApiError ? e.code : 'unknown'
      const detail = e instanceof PublicApiError ? e.detail : undefined
      setError(publicErrorText(lang, code, detail))
      setBusy(false)
    }
  }

  return (
    <div className="public-menu-checkout px-4 pb-10 pt-5">
      <div className="public-menu-checkout-intro">
        <h1 className="text-2xl font-black text-gray-900">{t(lang, 'pubCart')}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {t(lang, isTableOrder ? 'pubTableCheckoutHint' : 'pubCounterCheckoutHint')}
        </p>
      </div>

      {isTableOrder && tableContext ? (
        <div className="public-menu-checkout-fulfilment bg-emerald-50 text-emerald-900">
          <span className="w-10 h-10 rounded-xl bg-white text-emerald-800 flex items-center justify-center font-black shrink-0">
            {tableContext.label}
          </span>
          <span>
            <span className="block text-xs font-semibold text-emerald-700">{t(lang, 'pubOrderingFor')}</span>
            <span className="block font-bold">
              {t(lang, 'pubTable')} {tableContext.label}
              {tableContext.zone ? ` · ${tableContext.zone}` : ''}
            </span>
          </span>
          <span className="ms-auto text-xs font-bold rounded-full bg-white/80 px-3 py-1.5">
            {t(lang, 'pubPayLater')}
          </span>
        </div>
      ) : (
        <div className="public-menu-checkout-fulfilment bg-gray-100 text-gray-900">
          <span className="w-10 h-10 rounded-xl bg-white flex items-center justify-center shrink-0" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 8h16v12H4V8Z" strokeLinejoin="round" />
              <path d="M7 4h10l2 4H5l2-4Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>
            <span className="block text-xs font-semibold text-gray-500">{t(lang, 'pubFulfilment')}</span>
            <span className="block font-bold">{t(lang, 'pubCounterCheckout')}</span>
          </span>
          <span className="ms-auto text-xs font-bold rounded-full bg-white px-3 py-1.5">
            {t(lang, 'pubPayLater')}
          </span>
        </div>
      )}

      <section className="public-menu-checkout-card public-menu-cart-card">
        <div>
          {cart.map((l) => (
            <div key={l.key} className="public-menu-cart-line">
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-gray-900 text-sm">{l.name}</div>
                {(l.variantName || l.modNames.length > 0) && (
                  <div className="text-xs text-gray-500 mt-0.5">{[l.variantName, ...l.modNames].filter(Boolean).join(' · ')}</div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Stepper onClick={() => onQty(l.key, l.qty - 1)}>−</Stepper>
                <span className="w-8 text-center font-bold tabular-nums text-sm text-gray-900">{l.qty}</span>
                <Stepper onClick={() => onQty(l.key, l.qty + 1)}>+</Stepper>
              </div>
              <span className="w-20 text-end tabular-nums font-semibold text-sm text-gray-900 shrink-0">
                <span dir="ltr">{formatMoney(l.unitPrice * l.qty, lang)}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="public-menu-cart-total">
          <span className="font-bold text-gray-900">{t(lang, 'pubTotal')}</span>
          <span className="font-black text-xl tabular-nums text-gray-900" dir="ltr">{formatMoney(total, lang)}</span>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          {t(lang, isTableOrder ? 'pubPayAtTable' : 'pubPayAtPickup')}
        </p>
      </section>

      <section className="public-menu-checkout-card public-menu-checkout-form">

      {/* Тип заказа (055): показываем вопрос только если вариантов >1 */}
      {!isTableOrder && orderTypes.length > 1 && (
        <>
          <h2 className="text-lg font-bold text-gray-900 mt-6 mb-3">{t(lang, 'pubOrderTypeTitle')}</h2>
          <div className="flex gap-2 flex-wrap">
            {orderTypes.map((tp) => (
              <Chip key={tp} active={orderType === tp} onClick={() => setOrderType(tp)}>
                {t(lang, tp === 'here' ? 'pubTypeHere' : tp === 'delivery' ? 'pubTypeDelivery' : 'pubTypeTakeaway')}
              </Chip>
            ))}
          </div>
        </>
      )}

      {/* Адрес доставки — обязателен только для доставки */}
      {orderType === 'delivery' && (
        <label className="block mt-4">
          <span className="block text-sm font-bold text-gray-900 mb-2">
            {t(lang, 'pubAddress')} <span className="text-gray-500">· {t(lang, 'pubRequired')}</span>
          </span>
          <input
            className={`w-full h-12 rounded-xl border px-4 text-base focus:outline-none focus:ring-2 focus:ring-gray-900/20 ${
              showValidation && !addressOk ? 'border-rose-500' : 'border-gray-200 focus:border-gray-900'
            }`}
            placeholder={t(lang, 'pubAddressPlaceholder')}
            value={address}
            aria-invalid={showValidation && !addressOk}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
      )}

      {!isTableOrder && (
        <>
          <h2 className="text-lg font-bold text-gray-900 mt-6 mb-3">{t(lang, 'pubContact')}</h2>
          <div className="space-y-3">
            <label className="block">
              <span className="block text-sm font-semibold text-gray-700 mb-2">
                {t(lang, 'pubYourName')} <span className="text-gray-500">· {t(lang, 'pubRequired')}</span>
              </span>
              <input
                className={`w-full h-12 rounded-xl border px-4 text-base focus:outline-none focus:ring-2 focus:ring-gray-900/20 ${
                  showValidation && !name.trim() ? 'border-rose-500' : 'border-gray-200 focus:border-gray-900'
                }`}
                autoComplete="name"
                value={name}
                aria-invalid={showValidation && !name.trim()}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="block text-sm font-semibold text-gray-700 mb-2">
                {t(lang, 'pubPhone')} <span className="text-gray-500">· {t(lang, 'pubRequired')}</span>
              </span>
              <input
                className={`w-full h-12 rounded-xl border px-4 text-base focus:outline-none focus:ring-2 focus:ring-gray-900/20 ${
                  showValidation && phoneDigits.length < 9 ? 'border-rose-500' : 'border-gray-200 focus:border-gray-900'
                }`}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                dir="ltr"
                value={phone}
                aria-invalid={showValidation && phoneDigits.length < 9}
                onChange={(e) => setPhone(e.target.value)}
              />
              <span className="block text-xs text-gray-500 mt-2">{t(lang, 'pubPhoneHint')}</span>
            </label>

            <div>
              <span className="block text-sm font-semibold text-gray-700 mb-2">{t(lang, 'pubPickupTime')}</span>
            <div className="flex flex-wrap gap-2">
              <Chip active={asap} onClick={() => setAsap(true)}>
                {t(lang, 'pubAsap')}
                {formatPrepRange(lang, prepMin, prepMax) && (
                  <span dir="ltr"> · {formatPrepRange(lang, prepMin, prepMax)}</span>
                )}
              </Chip>
              <Chip active={!asap} onClick={() => setAsap(false)}>{t(lang, 'pubAtTime')}</Chip>
              {!asap && (
                <input
                  type="time"
                  className="h-11 rounded-xl border border-gray-200 px-3 text-base focus:outline-none focus:border-gray-900"
                  value={time}
                  aria-invalid={showValidation && !timeOk}
                  onChange={(e) => setTime(e.target.value)}
                />
              )}
            </div>
            </div>
          </div>
        </>
      )}

      <label className="block mt-5">
        <span className="block text-sm font-semibold text-gray-700 mb-2">
          {t(lang, 'pubNote')} <span className="text-gray-500">· {t(lang, 'pubOptional')}</span>
        </span>
        <input
          className="w-full h-12 rounded-xl border border-gray-200 px-4 text-base focus:outline-none focus:border-gray-900 focus:ring-2 focus:ring-gray-900/20"
          placeholder={t(lang, 'pubNotePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      </section>

      {error && <div className="mt-4 rounded-2xl bg-red-50 text-red-600 text-sm font-semibold px-4 py-3">{error}</div>}
      {showValidation && validationText && (
        <div role="alert" className="mt-4 rounded-2xl bg-rose-50 text-rose-700 text-sm font-semibold px-4 py-3">
          {validationText}
        </div>
      )}
      {!isOpen && <div className="mt-4 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3">{t(lang, 'pubClosed')}</div>}

      <button
        disabled={busy || !isOpen}
        onClick={submit}
        className="w-full min-h-14 mt-4 rounded-2xl bg-gray-900 text-white px-5 font-bold disabled:opacity-40 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
      >
        <span>{busy ? t(lang, 'pubSubmitting') : t(lang, isTableOrder ? 'pubSubmitTable' : 'pubSubmitCounter')}</span>
        {!busy && <span aria-hidden>·</span>}
        {!busy && <span dir="ltr">{formatMoney(total, lang)}</span>}
      </button>
      <p className="text-center text-xs text-gray-500 mt-2">{t(lang, 'pubNoOnlinePaymentHint')}</p>

      {recommendations.length > 0 && (
        <section className="mt-8 pt-6 border-t border-gray-200">
          <h2 className="text-lg font-bold text-gray-900 mb-3">{t(lang, 'pubAlsoTry')}</h2>
          <div className="flex gap-3 overflow-x-auto pb-2 snap-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {recommendations.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onRecommend(item)}
                className="w-36 min-h-44 shrink-0 snap-start rounded-2xl overflow-hidden bg-white border border-gray-200 shadow-sm text-start active:scale-[0.98] transition-all"
              >
                {item.image_url ? (
                  <img src={item.image_url} alt="" className="w-full h-24 object-contain bg-gray-50" />
                ) : (
                  <span className="block w-full h-24 bg-gray-100" />
                )}
                <span className="block px-3 pt-2 text-sm font-bold text-gray-900 line-clamp-2">{item.name}</span>
                <span className="flex items-center justify-between gap-2 px-3 pb-3 pt-1">
                  <span className="text-sm font-semibold text-gray-700" dir="ltr">{formatMoney(item.price, lang)}</span>
                  <span className="w-8 h-8 rounded-full bg-gray-900 text-white flex items-center justify-center text-lg font-bold" aria-hidden>+</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** Статус заявки: поллинг каждые 5 секунд, пока не решена и не выдана */
function StatusScreen({ lang, clientUuid, onNewOrder }: {
  lang: Lang
  clientUuid: string
  onNewOrder: () => void
}) {
  const [status, setStatus] = useState<PublicStatus | null>(null)
  const [lost, setLost] = useState(false)

  useEffect(() => {
    let stopped = false
    async function poll() {
      try {
        const s = await fetchPublicStatus(clientUuid)
        if (!stopped) {
          setStatus(s)
          setLost(false)
        }
      } catch (e) {
        if (!stopped && e instanceof PublicApiError && e.code === 'not_found') setLost(true)
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [clientUuid])

  if (lost) {
    return (
      <CenterCard>
        <p className="font-bold text-gray-900">{t(lang, 'pubStatusLost')}</p>
        <NewOrderBtn lang={lang} onClick={onNewOrder} />
      </CenterCard>
    )
  }
  if (!status) {
    return <CenterCard><p className="text-gray-500">{t(lang, 'loading')}</p></CenterCard>
  }

  if (status.status === 'rejected') {
    return (
      <CenterCard>
        <p className="text-2xl font-black text-gray-900">{t(lang, 'pubRejectedTitle')}</p>
        <p className="text-sm text-gray-500 mt-2">{status.reject_reason || t(lang, 'pubRejectedHint')}</p>
        <NewOrderBtn lang={lang} onClick={onNewOrder} />
      </CenterCard>
    )
  }

  if (status.status === 'new') {
    return (
      <CenterCard>
        <div className="w-10 h-10 mx-auto rounded-full border-4 border-gray-200 border-t-gray-900 animate-spin motion-reduce:animate-none" />
        <p className="text-xl font-bold text-gray-900 mt-5">{t(lang, 'pubWaiting')}</p>
        <p className="text-sm text-gray-500 mt-2">{t(lang, 'pubWaitingHint')}</p>
        <StatusSteps lang={lang} active={0} />
      </CenterCard>
    )
  }

  // Принятые: POS-цикл судит по order_status настоящего заказа,
  // standalone-цикл (101) — по статусу самой заявки (order_id нет).
  const os = status.order_status
  if (os === 'voided' || status.status === 'cancelled') {
    return (
      <CenterCard>
        <p className="text-2xl font-black text-gray-900">{t(lang, 'pubCancelledTitle')}</p>
        <NewOrderBtn lang={lang} onClick={onNewOrder} />
      </CenterCard>
    )
  }
  const isDone = os === 'paid' || os === 'fulfilled'
    || status.status === 'ready' || status.status === 'completed'
  return (
    <CenterCard>
      {/* Номер дня есть только у POS-заказа; standalone-заявка живёт без него */}
      {status.daily_number != null && (
        <>
          <p className="text-sm font-bold text-gray-500 uppercase tracking-wide">{t(lang, 'pubOrderNumber')}</p>
          <p className="text-6xl font-black tabular-nums text-gray-900 mt-2">#{status.daily_number}</p>
        </>
      )}
      <StatusSteps lang={lang} active={isDone ? 2 : 1} />
      {/* Таймер в стиле Wolt (061): пока заказ готовится — обратный отсчёт
          до decided_at + prep_max. Готов → просто «Заказ выдан». */}
      {!isDone && status.decided_at && (status.prep_max ?? 0) > 0 && (
        <PrepTimer
          lang={lang}
          decidedAt={status.decided_at}
          prepMax={status.prep_max ?? 0}
        />
      )}
      <p className="text-xl font-bold text-gray-900 mt-5">
        {isDone ? t(lang, 'pubDone') : t(lang, 'pubAccepted')}
      </p>
      <p className="text-sm text-gray-500 mt-2">
        {isDone
          ? t(lang, status.table_label ? 'pubDoneTableHint' : 'pubDoneCounterHint')
          : status.table_label
            ? `${t(lang, 'pubTableAcceptedHint')} ${status.table_label}.`
            : t(lang, 'pubCounterAcceptedHint')}
      </p>
      <p className="text-lg font-bold tabular-nums text-gray-900 mt-3" dir="ltr">{formatMoney(status.total, lang)}</p>
      {/* Пока заказ не выдан — вторичная, чтобы случайно не потерять экран с номером */}
      <NewOrderBtn lang={lang} onClick={onNewOrder} secondary={!isDone} />
    </CenterCard>
  )
}

function StatusSteps({ lang, active }: { lang: Lang; active: 0 | 1 | 2 }) {
  const steps = [
    t(lang, 'pubStepSent'),
    t(lang, 'pubStepAccepted'),
    t(lang, 'pubStepReady'),
  ]

  return (
    <ol className="mt-7 flex items-start" aria-label={t(lang, 'pubOrderProgress')}>
      {steps.map((label, index) => (
        <li key={label} className="flex-1 min-w-0 relative">
          {index > 0 && (
            <span
              className={`absolute top-4 end-1/2 w-full h-0.5 ${index <= active ? 'bg-gray-900' : 'bg-gray-200'}`}
              aria-hidden
            />
          )}
          <span className={`relative z-[1] w-8 h-8 mx-auto rounded-full flex items-center justify-center text-xs font-black ${
            index <= active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500'
          }`}>
            {index < active ? '✓' : index + 1}
          </span>
          <span className={`block mt-2 px-1 text-xs font-semibold ${
            index <= active ? 'text-gray-900' : 'text-gray-500'
          }`}>
            {label}
          </span>
        </li>
      ))}
    </ol>
  )
}

/**
 * Обратный отсчёт до готовности (061, стиль Wolt): кольцо-прогресс
 * от момента принятия (decided_at) до decided_at + prep_max минут.
 * Тик раз в секунду. Дошли до нуля → «скоро будет готово» (заказ ещё
 * не отмечен выданным — реальная готовность придёт статусом paid).
 */
function PrepTimer({ lang, decidedAt, prepMax }: {
  lang: Lang
  decidedAt: string
  prepMax: number
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const startMs = Date.parse(decidedAt)
  const totalMs = prepMax * 60_000
  const endMs = startMs + totalMs
  const remainMs = Math.max(0, endMs - now)
  // Прогресс 0→1 (сколько прошло). Ограничиваем [0,1] на случай сдвига часов.
  const progress = totalMs > 0 ? Math.min(1, Math.max(0, (now - startMs) / totalMs)) : 1

  // Кольцо-прогресс: SVG, окружность r=52 → длина ≈ 326.7
  const R = 52
  const C = 2 * Math.PI * R
  const dash = C * progress

  const overdue = remainMs <= 0
  // Обратный отсчёт MM:SS до нуля.
  const totalSec = Math.ceil(remainMs / 1000)
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  const clock = `${mm}:${String(ss).padStart(2, '0')}`

  return (
    <div className="mt-6 flex flex-col items-center">
      <div className="relative w-32 h-32">
        <svg viewBox="0 0 120 120" className="w-32 h-32 -rotate-90">
          <circle cx="60" cy="60" r={R} fill="none" stroke="#e5e7eb" strokeWidth="8" />
          <circle
            cx="60" cy="60" r={R} fill="none" stroke="#111827" strokeWidth="8"
            strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C - dash}
            style={{ transition: 'stroke-dashoffset 1s linear' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {overdue ? (
            <span className="text-base font-bold text-gray-900 px-2 text-center leading-tight">{t(lang, 'pubAlmostReady')}</span>
          ) : (
            <span className="text-3xl font-black tabular-nums text-gray-900" dir="ltr">{clock}</span>
          )}
        </div>
      </div>
      {!overdue && (
        <p className="text-sm text-gray-500 mt-3">{t(lang, 'pubReadyIn')}</p>
      )}
    </div>
  )
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-6">
      <div className="text-center w-full">{children}</div>
    </div>
  )
}

function NewOrderBtn({ lang, onClick, secondary }: { lang: Lang; onClick: () => void; secondary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`mt-6 h-12 px-6 rounded-2xl font-bold active:scale-[0.98] transition-all ${
        secondary ? 'border border-gray-300 text-gray-900' : 'bg-gray-900 text-white'
      }`}
    >
      {t(lang, 'pubNewOrder')}
    </button>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.96] ${
        active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
      }`}
    >
      {children}
    </button>
  )
}

function Stepper({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-11 h-11 rounded-xl bg-white border border-gray-200 font-bold text-gray-700 active:scale-[0.94] transition-all"
    >
      {children}
    </button>
  )
}

/** Код ошибки публичного API → текст гостю */
function publicErrorText(lang: Lang, code: string, detail?: string): string {
  switch (code) {
    case 'disabled': return t(lang, 'pubPaused')
    case 'paused': return t(lang, 'pubPaused')
    case 'closed': return t(lang, 'pubErrClosed')
    case 'rate_limited': return t(lang, 'pubErrRate')
    case 'busy': return t(lang, 'pubErrBusy')
    case 'item_unavailable': return `${t(lang, 'pubErrUnavailable')}${detail ? `: ${detail}` : ''}`
    case 'invalid_phone': return t(lang, 'pubErrPhone')
    case 'invalid_address': return t(lang, 'pubErrAddress')
    case 'invalid_table': return t(lang, 'pubTableQrExpired')
    case 'table_ordering_disabled': return t(lang, 'pubTableOrderingDisabled')
    default: return t(lang, 'pubErrGeneric')
  }
}
