import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { t, formatTime, type Lang } from '../../lib/i18n'
import { formatMoney, formatMoneyDelta } from '../../lib/money'
import {
  fetchPublicMenu, fetchPublicStatus, submitPublicOrder, PublicApiError, isViewOnlyMenu,
  type PublicItem, type PublicMenu, type PublicStatus, type PublicOrderType,
} from './publicApi'
import { parsePublicOrderQuery } from './orderContext'
import { useIdleReset } from './useIdleReset'
import StillHereDialog from './StillHereDialog'
import { reconcileCart } from './reconcileCart'
import { buildPickupSlots, type Hours } from './pickupSlots'
import PickupTimeSheet from './PickupTimeSheet'
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

type RouteDirection = 'forward' | 'back'
type RouteTransitionPhase = 'idle' | 'enter'
type RouteTransitionKind = 'hero' | 'route'

const ROUTE_ENTER_MS = 210
const HERO_ENTER_MS = 240
const ITEM_SHEET_EXIT_MS = 190

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
  const [checkoutStage, setCheckoutStage] = useState<'cart' | 'payment'>('cart')
  const [hasStarted, setHasStarted] = useState(false)
  const [configItem, setConfigItem] = useState<PublicItem | null>(null)
  const [configClosing, setConfigClosing] = useState(false)
  /** Правится строка корзины (её key), а не добавляется новая позиция */
  const [editingKey, setEditingKey] = useState<string | null>(null)
  // null = hero; id = экран позиций категории
  const [activeCat, setActiveCat] = useState<string | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const [routeTransition, setRouteTransition] = useState<{
    phase: RouteTransitionPhase
    direction: RouteDirection
    kind: RouteTransitionKind
  }>({ phase: 'idle', direction: 'forward', kind: 'route' })
  const routeTransitionBusy = useRef(false)
  const routeEnterTimer = useRef<number | undefined>(undefined)
  const itemCloseTimer = useRef<number | undefined>(undefined)
  const itemTrigger = useRef<HTMLElement | null>(null)

  useEffect(() => () => {
    if (routeEnterTimer.current !== undefined) window.clearTimeout(routeEnterTimer.current)
    if (itemCloseTimer.current !== undefined) window.clearTimeout(itemCloseTimer.current)
  }, [])

  /**
   * Переход коммитится сразу: отдельной exit-фазы и паузы между экранами
   * нет. Новый экран одним движением входит слева направо. Transform
   * применяется только к прокручиваемому контенту, не к предку
   * fixed-панелей: иначе CSS превращает viewport-fixed в «fixed
   * относительно длинной страницы».
   */
  const transitionTo = useCallback((
    direction: RouteDirection,
    kind: RouteTransitionKind,
    commit: () => void,
  ) => {
    if (routeTransitionBusy.current) return
    if (reducedMotion) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      commit()
      return
    }

    routeTransitionBusy.current = true
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    commit()
    setRouteTransition({ phase: 'enter', direction, kind })
    routeEnterTimer.current = window.setTimeout(() => {
      routeTransitionBusy.current = false
      setRouteTransition({ phase: 'idle', direction, kind })
      routeEnterTimer.current = undefined
    }, kind === 'hero' ? HERO_ENTER_MS : ROUTE_ENTER_MS)
  }, [reducedMotion])

  const finishConfigClose = useCallback(() => {
    setConfigItem(null)
    setEditingKey(null)
    setConfigClosing(false)
  }, [])

  useEffect(() => {
    if (configItem || !itemTrigger.current) return
    const trigger = itemTrigger.current
    const timer = window.setTimeout(() => {
      if (trigger.isConnected) trigger.focus({ preventScroll: true })
      itemTrigger.current = null
    }, 0)
    return () => window.clearTimeout(timer)
  }, [configItem])

  const closeConfigItem = useCallback(() => {
    if (itemCloseTimer.current !== undefined) return
    if (reducedMotion) {
      finishConfigClose()
      return
    }
    setConfigClosing(true)
    itemCloseTimer.current = window.setTimeout(() => {
      itemCloseTimer.current = undefined
      finishConfigClose()
    }, ITEM_SHEET_EXIT_MS)
  }, [finishConfigClose, reducedMotion])

  useEffect(() => {
    if (view === 'menu' && !hasStarted && routeTransition.phase === 'idle' && activeCat) {
      setActiveCat(null)
    }
  }, [activeCat, hasStarted, routeTransition.phase, view])

  /**
   * Киоск-режим: планшет на столе не должен хранить заказ ушедшего гостя.
   * Возврат на hero с полной очисткой корзины.
   *
   * Кроме экрана статуса: там номер готовящегося заказа, и выбросить с
   * него — значит лишить гостя единственного способа узнать свой номер.
   */
  const resetToStart = () => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    setCart([])
    setConfigItem(null)
    setConfigClosing(false)
    setActiveCat(null)
    setCheckoutStage('cart')
    setView('menu')
    setHasStarted(false)
  }
  /**
   * Автосброс включается только явным ?kiosk=1. Обычный QR открывается на
   * личном телефоне: там минута чтения состава не должна стирать корзину.
   */
  const { countdown, stayActive } = useIdleReset(
    queryContext.kiosk && !activeUuid && hasStarted,
    resetToStart,
  )

  const { data: menu, isLoading, isError } = useQuery({
    queryKey: ['public_menu', locId, queryContext.tableToken],
    queryFn: () => fetchPublicMenu(locId, queryContext.tableToken),
    staleTime: 30_000,
  })
  useEffect(() => {
    // Первый экран карточек готовим, пока гость смотрит hero. Остальные
    // изображения остаются lazy и не расходуют трафик заранее.
    for (const item of menu?.categories[0]?.items.slice(0, 4) ?? []) {
      if (!item.image_url) continue
      const image = new Image()
      image.decoding = 'async'
      image.src = item.image_url
    }
  }, [menu])
  /**
   * Сверка восстановленной корзины с меню. Корзина живёт до 6 часов и
   * хранит снапшот цен: товар мог подорожать или исчезнуть. Сервер это
   * поймает сам, но гость узнал бы на последнем шаге — после заполнения
   * контактов. Поэтому правим сразу и сообщаем, что изменилось.
   */
  const [cartNotice, setCartNotice] = useState<string | null>(null)
  const reconciledFor = useRef<PublicMenu | null>(null)
  useEffect(() => {
    if (!menu || reconciledFor.current === menu) return
    reconciledFor.current = menu
    setCart((current) => {
      if (current.length === 0) return current
      const { lines, removed, repriced } = reconcileCart(current, menu)
      if (removed.length > 0) {
        setCartNotice(t(lang, 'pubCartRemoved').replace('{items}', removed.join(', ')))
      } else if (repriced) {
        setCartNotice(t(lang, 'pubCartRepriced'))
      }
      return removed.length > 0 || repriced ? lines : current
    })
  }, [menu, lang])

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
    // 6 — максимум для планшета (2 ряда по 3). На телефоне лишние
    // скрываются в CSS: при повороте экрана ряд перестраивается сам,
    // без пересчёта списка.
    return [...crossCategory, ...fallback].slice(0, 6)
  }, [menu, cart])
  const itemImages = useMemo<Record<string, string | null>>(
    () => Object.fromEntries(
      menu?.categories.flatMap((category) => category.items.map((item) => [item.id, item.image_url ?? null])) ?? []
    ),
    [menu]
  )

  /** Начальный выбор для карточки, открытой правкой строки корзины */
  const editingLine = useMemo(() => {
    if (!editingKey) return null
    const line = cart.find((l) => l.key === editingKey)
    return line ? { variantId: line.variantId, modIds: line.modIds } : null
  }, [editingKey, cart])

  /**
   * Тап по строке корзины открывает карточку товара с текущим выбором.
   * Товар берём из меню: в строке лежит только снимок состава, а карточке
   * нужны все варианты и группы модификаторов. Если позиция исчезла из
   * меню, правку не открываем — сверка корзины скажет об этом отдельно.
   */
  function editCartLine(line: CartLine) {
    const item = menu?.categories
      .flatMap((category) => category.items)
      .find((candidate) => candidate.id === line.itemId)
    if (!item) return
    setEditingKey(line.key)
    setConfigItem(item)
  }

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

  /**
   * Замена строки после правки состава: количество сохраняем, а если
   * новый состав совпал с другой строкой корзины — сливаем их, иначе
   * получилось бы две одинаковые позиции.
   */
  function replaceLine(key: string, line: Omit<CartLine, 'key' | 'qty'>) {
    setCart((prev) => {
      const target = prev.find((l) => l.key === key)
      if (!target) return prev
      const twin = prev.find(
        (l) =>
          l.key !== key &&
          l.itemId === line.itemId &&
          l.variantId === line.variantId &&
          l.modIds.length === line.modIds.length &&
          l.modIds.every((id, i) => id === line.modIds[i])
      )
      if (twin) {
        return prev
          .filter((l) => l.key !== key)
          .map((l) => (l.key === twin.key ? { ...l, qty: l.qty + target.qty } : l))
      }
      return prev.map((l) => (l.key === key ? { ...l, ...line } : l))
    })
  }

  function updateQty(key: string, qty: number) {
    setCart((prev) => (qty <= 0 ? prev.filter((l) => l.key !== key) : prev.map((l) => (l.key === key ? { ...l, qty } : l))))
  }

  function startNewOrder() {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    localStorage.removeItem(ACTIVE_KEY)
    setActiveUuid(null)
    setCart([])
    setConfigItem(null)
    setConfigClosing(false)
    setView('menu')
    setHasStarted(false)
    setActiveCat(null)
  }

  function openItem(item: PublicItem) {
    // Карточка товара — часть витрины: любой товар сначала раскрывается
    // крупно с фото, описанием и ценой. Это сохраняет предсказуемый UX и
    // не добавляет простые позиции в корзину неожиданно по тапу по карточке.
    itemTrigger.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setConfigClosing(false)
    setConfigItem(item)
  }

  function selectCategory(id: string) {
    if (!menu || id === activeCat) return
    // Сбрасываем позицию до React-коммита: новый список сразу появляется
    // от заголовка, без кадра в старом scrollY и последующего прыжка.
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    setActiveCat(id)
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
  const routeKey = view === 'checkout'
    ? checkoutStage
    : hasStarted
      ? 'menu'
      : 'hero'
  return (
    <Shell
      isRtl={isRtl}
      title={menu.location.business_name || menu.location.name}
      logo={menu.location.logo_url}
      hero={view === 'menu' && !hasStarted}
      headerImg={menu.location.header_url}
      heroVideo={menu.location.hero_video_url ?? BRANDED_HERO_VIDEOS[locId] ?? null}
      bgImg={menuBackground}
      routeKey={routeKey}
      transitionPhase={routeTransition.phase}
      transitionDirection={routeTransition.direction}
      transitionKind={routeTransition.kind}
      onHeroStart={() => {
        transitionTo('forward', 'hero', () => {
          setHasStarted(true)
          setActiveCat(menu.categories[0]?.id ?? null)
        })
      }}
      // Возврат в шапке: из оплаты → к корзине, из корзины → к меню,
      // из меню → на заставку. Раньше на экране меню кнопки не было, и
      // гость, вошедший через «Начать», не мог вернуться назад.
      onBack={
        view === 'checkout'
          ? checkoutStage === 'payment'
            ? () => transitionTo('back', 'route', () => setCheckoutStage('cart'))
            : () => transitionTo('back', 'route', () => setView('menu'))
          : hasStarted
            ? () => transitionTo('back', 'hero', () => {
                setHasStarted(false)
              })
            : undefined
      }
      backLabel={t(lang, 'back')}
    >
      {view === 'menu' && activeCat && (() => {
        const cat = menu.categories.find((c) => c.id === activeCat)
        if (!cat) return null
        return (
          <div className="public-menu-route-motion">
            {/* Навигация не перемонтируется при смене категории: движется
                активный чип и обновляется только список товаров. */}
            <CategoryChips categories={menu.categories} activeCat={activeCat} onSelect={selectCategory} />
            <div
              key={activeCat}
              data-category-motion={routeTransition.phase === 'idle' ? 'on' : 'off'}
              className="public-menu-category-content"
            >
              <div className="public-menu-products-section px-4 pb-4">
                <div className="public-menu-section-heading">
                  <h2 className="public-menu-section-title public-menu-route-focus public-menu-route-heading" tabIndex={-1}>
                    {cat.name}
                  </h2>
                </div>
                <div className="public-menu-product-grid">
                  {cat.items.map((item, index) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      lang={lang}
                      layout="grid"
                      priority={index < 4}
                      onTap={() => openItem(item)}
                    />
                  ))}
                </div>
              </div>
              <SocialFooter links={menu.location.links} lang={lang} padForCart={cartCount > 0} />
            </div>
          </div>
        )
      })()}

      {view === 'menu' && hasStarted && cartCount > 0 && (
        <CartBar
          key={bumpSeq}
          lang={lang}
          count={cartCount}
          total={cartTotal}
          bumping={bumping}
          onOpen={() => {
            transitionTo('forward', 'route', () => {
              setCheckoutStage('cart')
              setView('checkout')
            })
          }}
        />
      )}

      {view === 'checkout' && (
        <CheckoutScreen
          lang={lang}
          locId={locId}
          openNow={menu.location.is_open && menu.location.accepting !== false}
          // Предзаказ (116): закрыто сейчас — не значит «закрыто вообще».
          // Пауза и выключенный приём запрещают и предзаказ: это ручное
          // «мы не принимаем», а не расписание. Старая edge function поля
          // не отдаёт — тогда поведение прежнее, по is_open.
          canPreorder={
            menu.location.accepting !== false
            && (menu.location.preorder ?? menu.location.is_open)
          }
          prepMin={menu.location.prep_min ?? 0}
          prepMax={menu.location.prep_max ?? 0}
          hours={menu.location.hours ?? null}
          timezone={menu.location.timezone ?? null}
          orderTypes={tableContext ? ['here'] : orderTypes}
          initialOrderType={initialOrderType}
          tableContext={tableContext}
          tableToken={tableContext ? queryContext.tableToken : null}
          orderChannel={queryContext.channel}
          recommendations={recommendations}
          itemImages={itemImages}
          cart={cart}
          total={cartTotal}
          stage={checkoutStage}
          availabilityMessage={
            menu.location.accepting === false
              ? menu.location.paused_until
                ? `${t(lang, 'pubPausedUntil')} ${formatTime(menu.location.paused_until, lang)}`
                : t(lang, 'pubPaused')
              : !menu.location.is_open
                // Закрыто сейчас, но предзаказ открыт (116): предупреждение
                // объясняет, что делать («выберите время»), а не сообщает
                // об отказе — оформление в этом состоянии доступно.
                ? t(lang, (menu.location.preorder ?? false)
                  ? 'pubClosedPreorder'
                  : 'pubClosed')
                : null
          }
          contextMessage={
            menu.context_error
              ? t(lang, menu.context_error === 'table_ordering_disabled'
                ? 'pubTableOrderingDisabled'
                : 'pubTableQrExpired')
              : null
          }
          onAddItems={() => transitionTo('back', 'route', () => setView('menu'))}
          onContinue={() => transitionTo('forward', 'route', () => setCheckoutStage('payment'))}
          onQty={updateQty}
          onEditLine={editCartLine}
          onRecommend={openItem}
          onSubmitted={(clientUuid) => {
            window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
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
          editing={editingLine}
          closing={configClosing}
          onClose={closeConfigItem}
          // Удаление позиции из самой шторки правки: гость, открывший
          // строку «передумать», ожидает найти здесь и «убрать», а не
          // закрывать карточку и жать «−» до нуля в корзине.
          onRemove={editingKey ? () => {
            updateQty(editingKey, 0)
            closeConfigItem()
          } : undefined}
          onAdd={(line) => {
            // Правка строки заменяет её состав; обычный сценарий добавляет
            if (editingKey) replaceLine(editingKey, line)
            else addLine(line)
            closeConfigItem()
          }}
        />
      )}

      {/* Корзина изменилась после сверки с меню — говорим об этом сразу,
          а не даём гостю дойти до оплаты со старой суммой */}
      {cartNotice && (
        <div className="public-menu-cart-notice" role="status">
          <span>{cartNotice}</span>
          <button type="button" onClick={() => setCartNotice(null)} aria-label={t(lang, 'close')}>
            ✕
          </button>
        </div>
      )}

      {countdown !== null && (
        <StillHereDialog lang={lang} secondsLeft={countdown} onStay={stayActive} />
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
function Shell({
  isRtl, title, logo, hero, headerImg, heroVideo, bgImg, onHeroStart, onBack, backLabel,
  routeKey, transitionPhase = 'idle', transitionDirection = 'forward',
  transitionKind = 'route', children,
}: {
  isRtl: boolean
  title?: string
  logo?: string | null
  hero?: boolean
  headerImg?: string | null
  heroVideo?: string | null
  bgImg?: string | null
  onHeroStart?: () => void
  /** Стрелка возврата в компактной шапке (не hero); заменяет in-body «Назад» */
  onBack?: () => void
  backLabel?: string
  /** Семантический экран для восстановления фокуса после перехода. */
  routeKey?: string
  transitionPhase?: RouteTransitionPhase
  transitionDirection?: RouteDirection
  transitionKind?: RouteTransitionKind
  children: React.ReactNode
}) {
  const hasBg = !!bgImg
  const reducedMotion = usePrefersReducedMotion()
  const hasHeroMedia = !!heroVideo || !!headerImg
  const frameRef = useRef<HTMLDivElement>(null)
  const focusedRoute = useRef(routeKey)
  const heroTransitionActive = transitionKind === 'hero' && transitionPhase === 'enter'
  const leavingHero = heroTransitionActive && !hero && transitionDirection === 'forward'
  const enteringHero = heroTransitionActive && !!hero && transitionDirection === 'back'
  const showHero = !!hero || leavingHero
  const showCompactHeader = !hero || enteringHero
  const heroTransitionRole = leavingHero ? 'leaving' : enteringHero ? 'entering' : 'idle'
  const compactTransitionRole = leavingHero ? 'entering' : enteringHero ? 'leaving' : 'idle'

  useEffect(() => {
    if (!routeKey || routeKey === focusedRoute.current || transitionPhase !== 'idle') return
    const timer = window.setTimeout(() => {
      frameRef.current
        ?.querySelector<HTMLElement>('.public-menu-route-focus')
        ?.focus({ preventScroll: true })
      focusedRoute.current = routeKey
    }, 0)
    return () => window.clearTimeout(timer)
  }, [routeKey, transitionPhase])

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
      <div
        ref={frameRef}
        className={`public-menu-frame relative mx-auto min-h-screen flex flex-col ${hasBg ? '' : 'bg-white'}`}
      >
        {showHero && (
          <header
            key="hero"
            data-transition-role={heroTransitionRole}
            data-nav={transitionDirection}
            className={`public-menu-hero${hasHeroMedia ? ' has-media' : ' is-brand-only'}${
              heroTransitionRole !== 'idle' ? ' is-transition-overlay' : ''
            }`}
          >
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
              className="public-menu-hero-scroll public-menu-route-focus"
              onClick={onHeroStart}
              aria-label="התחלה"
            >
              <span>התחל</span>
            </button>
          </header>
        )}
        {showCompactHeader && (
          <header
            key="compact"
            data-transition-role={compactTransitionRole}
            data-nav={transitionDirection}
            className="public-menu-compact-header sticky top-0 z-10 bg-white border-b border-gray-100 px-4 flex items-center justify-center relative"
            style={{
              height: 'calc(3.5rem + env(safe-area-inset-top))',
              paddingTop: 'env(safe-area-inset-top)',
            }}
          >
            {/* Возврат слева, логотип у начала строки — они на разных краях
                и показываются вместе: кнопка не должна стирать брендинг. */}
            {onBack && (
              <button
                onClick={onBack}
                aria-label={backLabel}
                className="public-menu-back-button absolute left-2 h-11 px-4 rounded-full flex items-center gap-1.5 text-sm font-bold active:scale-[0.96] transition-all"
              >
                {/* Пилюля возврата всегда слева (левый край экрана), стрелка смотрит влево */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                <span>{backLabel}</span>
              </button>
            )}
            {logo && <img src={logo} alt="" className="absolute start-4 w-9 h-9 rounded-full object-cover" />}
            <span className="public-menu-header-title font-display px-14 text-center font-bold text-xl text-gray-900 truncate">
              {title ?? ''}
            </span>
          </header>
        )}
        <div
          data-transition={transitionPhase}
          data-nav={transitionDirection}
          data-transition-kind={transitionKind}
          aria-busy={transitionPhase !== 'idle'}
          className="public-menu-screen flex-1 flex flex-col"
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

function CartBar({ lang, count, total, bumping, onOpen }: {
  lang: Lang
  count: number
  total: number
  bumping: boolean
  onOpen: () => void
}) {
  return (
    // Панель та же, что на чекауте: сплошная белая полоса, а не плавающая
    // кнопка на градиенте. Плитки меню не должны просвечивать под оплатой —
    // иначе на скролле под кнопкой ползёт каша из фото и цен.
    <div className="public-menu-checkout-submitbar is-cart">
      {/* Та же вёрстка, что и у кнопки перехода к оплате
          (.public-menu-checkout-submit): space-between прижимает сумму
          к краю, счётчик — белый квадрат. Иначе две нижние кнопки
          гостевого сценария выглядят как из разных приложений. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${t(lang, 'pubShowItems')}: ${count}, ${formatMoney(total, lang)}`}
        className={`public-menu-checkout-submit ${bumping ? 'cart-bump' : ''}`}
      >
        <span className="public-menu-checkout-submit-count" aria-live="polite">
          {count}
        </span>
        <span>{t(lang, 'pubShowItems')}</span>
        <strong dir="ltr">{formatMoney(total, lang)}</strong>
      </button>
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
          /* Активная категория — НЕ чёрная заливка: чёрный на гостевой
             странице зарезервирован за главным действием (корзина, оплата).
             Навигация лишь отмечает «вы здесь», поэтому активный чип светлый
             с контуром фирменного near-black. В тёмной теме он белый — там
             иерархия соблюдалась изначально (см. .public-menu-dark в CSS). */
          className={`public-menu-category-chip h-11 px-4 rounded-full text-sm font-semibold whitespace-nowrap transition-all active:scale-[0.96] shrink-0 ${
            c.id === activeCat
              /* Без shadow-sm: утилита Tailwind задаёт то же box-shadow и
                 перебивала бы зелёный контур — тень уже входит в него. */
              ? 'public-menu-category-chip-active bg-white text-gray-900'
              : 'bg-gray-100 text-gray-600'
          }`}
        >
          {c.name}
        </button>
      ))}
    </nav>
  )
}

function SocialFooter({ links, lang, padForCart }: {
  links?: PublicMenu['location']['links']
  lang: Lang
  padForCart: boolean
}) {
  // Сплошной near-black, а не bg-black/75: полупрозрачность задумывалась
  // под фоновое фото, но у точки без фона подвал лежит на белом — и кнопки
  // выцветали в серый (~#404040), читаясь как выключенные рядом с чёрными
  // «+» на карточках. Сплошной цвет одинаково работает и на фото, и на белом.
  const iconBtn =
    'w-12 h-12 shrink-0 rounded-full bg-gray-900 ring-1 ring-white/15 text-white shadow-lg shadow-black/25 flex items-center justify-center active:scale-[0.94] transition-all'
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
              className="h-12 max-w-full px-5 rounded-full bg-gray-900 ring-1 ring-white/15 text-sm font-semibold text-white shadow-lg shadow-black/25 flex items-center justify-center gap-2 active:scale-[0.96] transition-all"
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
function ItemRow({ item, lang, onTap, layout = 'row', priority = false }: {
  item: PublicItem
  lang: Lang
  onTap: () => void
  layout?: 'row' | 'grid'
  /** Первые видимые карточки загружаются сразу; остальной каталог — lazy. */
  priority?: boolean
}) {
  const prices = item.variants.length > 0 ? item.variants.map((v) => v.price) : [item.price]
  const minPrice = Math.min(...prices)
  return (
    <button
      onClick={onTap}
      className={`public-menu-item-card is-${layout}`}
    >
      <span className="public-menu-item-media">
        {item.image_url ? (
          <img
            src={item.image_url}
            alt=""
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            decoding="async"
          />
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
function ItemConfigSheet({
  item, lang, isRtl, viewOnly = false, editing, closing, onClose, onAdd, onRemove,
}: {
  item: PublicItem
  lang: Lang
  isRtl: boolean
  /** Витрина без модуля заказов (100): карточка только показывает состав/цену */
  viewOnly?: boolean
  /** Правка строки корзины: открываем с уже выбранными вариантом и модификаторами */
  editing?: { variantId: string | null; modIds: string[] } | null
  /** Пока true, sheet остаётся в DOM и проигрывает обратный переход. */
  closing: boolean
  onClose: () => void
  onAdd: (line: Omit<CartLine, 'key' | 'qty'>) => void
  /** Убрать позицию из корзины; задан только в режиме правки строки */
  onRemove?: () => void
}) {
  const defaultVariant = item.variants.find((v) => v.is_default) ?? item.variants[0] ?? null
  const [variantId, setVariantId] = useState<string | null>(
    editing ? editing.variantId : defaultVariant?.id ?? null
  )
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Правка: берём выбор гостя, а не дефолты товара
    if (editing) return new Set(editing.modIds)
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
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        sheetRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute('hidden'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const previousOverflow = document.body.style.overflow
    const pageFrame = document.querySelector<HTMLElement>('.public-menu-frame')
    document.body.style.overflow = 'hidden'
    pageFrame?.setAttribute('inert', '')
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      pageFrame?.removeAttribute('inert')
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

  return createPortal(
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      data-state={closing ? 'closing' : 'open'}
      className="public-menu-item-overlay fixed inset-0 z-40 flex items-end justify-center"
      onClick={onClose}
    >
      <div
        ref={sheetRef}
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
                    {/* Надбавка одной изолированной группой «+₪ 2»: знак
                        внутри изоляции, иначе в ивритском окружении он
                        отрывается от суммы. Отступ margin'ом — пробел на
                        границе направлений съедается, и цена липла к имени. */}
                    {m.price_delta !== 0 && (
                      <span className="ms-1.5">{formatMoneyDelta(m.price_delta, lang)}</span>
                    )}
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
            {/* При правке количество меняется степпером в самой корзине */}
            {!editing && (
              <div className="flex items-center gap-1 shrink-0">
                <Stepper onClick={() => setQty((q) => Math.max(1, q - 1))}>−</Stepper>
                <span className="w-8 text-center font-bold tabular-nums text-gray-900">{qty}</span>
                <Stepper onClick={() => setQty((q) => Math.min(99, q + 1))}>+</Stepper>
              </div>
            )}
            {/* «Убрать» занимает освободившееся при правке место степпера.
                Красная — общепринятый сигнал необратимого действия, он же
                разводит её с «Сохранить» надёжнее серого контура. Заливку
                не берём: сплошной красный спорил бы по весу с главной
                кнопкой. Высота общая, ширина по содержимому — сумма важнее. */}
            {editing && onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="shrink-0 h-14 px-5 rounded-2xl border border-red-200 bg-red-50
                           text-red-600 font-bold active:scale-[0.98] transition-all"
              >
                {t(lang, 'pubRemoveItem')}
              </button>
            )}
            <button
              disabled={!!missingGroup}
              onClick={() => {
                const mods = item.modifier_groups.flatMap((g) => g.modifiers).filter((m) => selected.has(m.id))
                const line = {
                  itemId: item.id,
                  name: item.name,
                  variantId: variant?.id ?? null,
                  variantName: variant?.name ?? null,
                  modIds: mods.map((m) => m.id),
                  modNames: mods.map((m) => m.name),
                  unitPrice: unit,
                }
                // Правка меняет состав одной строки, количество берётся из
                // корзины — повторный вызов заменял бы строку многократно.
                if (editing) {
                  onAdd(line)
                  return
                }
                for (let i = 0; i < qty; i++) onAdd(line)
              }}
              className="flex-1 min-w-0 h-14 rounded-2xl bg-gray-900 text-white font-bold disabled:opacity-40
                         active:scale-[0.98] transition-all flex items-center justify-center gap-2 px-4"
            >
              {missingGroup ? (
                <span className="truncate">{`${t(lang, 'pubChoose')}: ${missingGroup.name}`}</span>
              ) : (
                <>
                  <span>{t(lang, editing ? 'save' : 'pubAdd')}</span>
                  <span className="tabular-nums" dir="ltr">
                    {formatMoney(unit * (editing ? 1 : qty), lang)}
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** Корзина в духе delivery-приложений: позиции, быстрые количества и upsell. */
function CartStage({
  lang, cart, total, itemImages, recommendations,
  onQty, onEditLine, onRecommend, onAddItems, onContinue,
}: {
  lang: Lang
  cart: CartLine[]
  total: number
  itemImages: Record<string, string | null>
  recommendations: PublicItem[]
  onQty: (key: string, qty: number) => void
  /** Тап по строке — правка состава (вариант, модификаторы) */
  onEditLine: (line: CartLine) => void
  onRecommend: (item: PublicItem) => void
  onAddItems: () => void
  onContinue: () => void
}) {
  const cartCount = cart.reduce((sum, line) => sum + line.qty, 0)

  return (
    <div className="public-menu-checkout public-menu-cart-stage">
      <div className="public-menu-checkout-content public-menu-route-motion">
        <div className="public-menu-checkout-intro">
          <div>
            <h1 className="font-display text-gray-900 public-menu-route-focus public-menu-route-heading" tabIndex={-1}>
              {t(lang, 'pubYourOrder')}
            </h1>
          </div>
        </div>

        <section className="public-menu-checkout-card public-menu-cart-card">
          <div className="public-menu-checkout-section-title public-menu-cart-title">
            <h2 aria-hidden="true">{t(lang, 'pubYourOrder')}</h2>
            <button type="button" onClick={onAddItems}>
              <span aria-hidden>+</span>
              {t(lang, 'pubAddMoreItems')}
            </button>
          </div>
          <div className="public-menu-cart-lines">
            {cart.map((line) => (
              <div key={line.key} className="public-menu-cart-line">
                {/* Фото и название — кнопка правки состава: гость, выбравший
                    не тот размер или модификатор, чинит позицию на месте,
                    а не удаляет и собирает заново. Степпер снаружи, иначе
                    тап по «+/−» открывал бы карточку. */}
                <button
                  type="button"
                  className="public-menu-cart-edit"
                  onClick={() => onEditLine(line)}
                  aria-label={`${t(lang, 'edit')}: ${line.name}`}
                >
                  <div className="public-menu-cart-media">
                    {itemImages[line.itemId] ? (
                      <img src={itemImages[line.itemId] ?? undefined} alt="" />
                    ) : (
                      <span aria-hidden>{line.name.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="public-menu-cart-copy">
                    <div className="public-menu-cart-name">{line.name}</div>
                    {(line.variantName || line.modNames.length > 0) && (
                      <div className="public-menu-cart-meta">
                        {[line.variantName, ...line.modNames].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                </button>
                {/* Сумма над степпером одной колонкой: раньше она стояла
                    под названием, а количество — отдельно справа, и строка
                    читалась разрозненно. */}
                <div className="public-menu-cart-controls">
                  <span className="public-menu-cart-price">
                    {formatMoney(line.unitPrice * line.qty, lang)}
                  </span>
                  <div className="public-menu-cart-stepper">
                    <Stepper onClick={() => onQty(line.key, line.qty - 1)}>−</Stepper>
                    <span>{line.qty}</span>
                    <Stepper onClick={() => onQty(line.key, line.qty + 1)}>+</Stepper>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="public-menu-cart-total">
            <span>{t(lang, 'pubTotal')}</span>
            <strong dir="ltr">{formatMoney(total, lang)}</strong>
          </div>
        </section>

        {recommendations.length > 0 && (
          <section className="public-menu-checkout-recommendations is-large">
            <h2>{t(lang, 'pubAlsoTry')}</h2>
            <div>
              {recommendations.map((item) => (
                <button key={item.id} type="button" onClick={() => onRecommend(item)}>
                  <span className="public-menu-checkout-recommendation-media">
                    {item.image_url ? <img src={item.image_url} alt="" /> : <span />}
                    <span className="public-menu-checkout-recommendation-add" aria-hidden>+</span>
                  </span>
                  <span className="public-menu-checkout-recommendation-copy">
                    <small dir="ltr">{formatMoney(item.price, lang)}</small>
                    <strong>{item.name}</strong>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="public-menu-checkout-spacer" aria-hidden />
      </div>

      <div className="public-menu-checkout-submitbar is-cart">
        <button type="button" onClick={onContinue} className="public-menu-checkout-submit">
          <span className="public-menu-checkout-submit-count">{cartCount}</span>
          <span>{t(lang, 'pubContinueToPayment')}</span>
          <strong dir="ltr">{formatMoney(total, lang)}</strong>
        </button>
      </div>
    </div>
  )
}

/** Способ получения + контакты + подтверждение заявки */
function CheckoutScreen({
  lang, locId, openNow, canPreorder, prepMin, prepMax, hours, timezone, orderTypes, initialOrderType,
  tableContext, tableToken, orderChannel, recommendations, itemImages, cart, total,
  availabilityMessage, contextMessage, stage,
  onAddItems, onContinue, onQty, onEditLine, onRecommend, onSubmitted,
}: {
  lang: Lang
  locId: string
  /** Открыто прямо сейчас: только при этом доступен заказ «как можно скорее» */
  openNow: boolean
  /** Приём заявок «ко времени» на будущее окно возможен (116) */
  canPreorder: boolean
  /** Время приготовления — вилка мин–макс (061): 0/0 = не показывать */
  prepMin: number
  prepMax: number
  /** Часы работы точки (112): null = приём в любое время */
  hours: Hours | null
  /** Таймзона точки — слоты строятся в ней, а не в зоне телефона гостя */
  timezone: string | null
  orderTypes: PublicOrderType[]
  initialOrderType: PublicOrderType
  tableContext: PublicMenu['order_context']
  tableToken: string | null
  orderChannel: 'link' | 'counter_qr' | 'table_qr' | 'website' | 'social'
  recommendations: PublicItem[]
  itemImages: Record<string, string | null>
  cart: CartLine[]
  total: number
  availabilityMessage: string | null
  contextMessage: string | null
  stage: 'cart' | 'payment'
  onAddItems: () => void
  onContinue: () => void
  onQty: (key: string, qty: number) => void
  onEditLine: (line: CartLine) => void
  onRecommend: (item: PublicItem) => void
  onSubmitted: (clientUuid: string) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  // Закрыто сейчас (116) — «как можно скорее» невозможно, поэтому форма
  // сразу открывается на выборе времени: иначе гость упирался бы в
  // заблокированную кнопку, не понимая, что предзаказ доступен.
  const [asap, setAsap] = useState(openNow)
  // Выбранный слот — ISO-момент, а не «HH:MM»: время уже посчитано в
  // таймзоне точки, повторно интерпретировать его на клиенте не нужно.
  const [slotIso, setSlotIso] = useState('')
  const [note, setNote] = useState('')
  // Тип заказа: первый включённый по умолчанию. Если включён один —
  // вопрос не показываем (нечего выбирать).
  const [orderType, setOrderType] = useState<PublicOrderType>(initialOrderType)
  // Адрес доставки раздельными полями: одной строкой гость регулярно
  // забывал квартиру и этаж. В submit уходит собранной строкой.
  const [city, setCity] = useState('')
  const [street, setStreet] = useState('')
  const [apartment, setApartment] = useState('')
  const [floor, setFloor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showValidation, setShowValidation] = useState(false)
  // client_uuid создаётся один раз на попытку оформления: ретрай после
  // сбоя сети не создаст дубликат (идемпотентность submit_online_order)
  const clientUuid = useMemo(() => crypto.randomUUID(), [])

  const phoneDigits = phone.replace(/\D/g, '')
  const isTableOrder = tableContext?.kind === 'table' && !!tableToken

  // Слоты внутри часов работы (112). Пересчитываются раз в минуту: пока
  // гость заполняет форму, ближайший слот может стать прошедшим.
  const [slotsNow, setSlotsNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setSlotsNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const slots = useMemo(
    () => buildPickupSlots(hours, timezone ?? undefined, new Date(slotsNow)),
    [hours, timezone, slotsNow]
  )
  // Слот, выбранный ранее, мог уехать в прошлое, пока гость заполнял форму.
  // Считаем его недействительным по факту, без setState в эффекте: выбор
  // просто перестаёт подсвечиваться, а отправка блокируется валидацией.
  const selectedSlot = slots.find((slot) => slot.iso === slotIso) ?? null
  const activeSlot = selectedSlot ? slotIso : ''
  const [pickerOpen, setPickerOpen] = useState(false)

  // Обязателен город и улица с домом; квартира и этаж — по желанию
  // (частный дом их не имеет).
  const addressOk = orderType !== 'delivery'
    || (city.trim().length > 0 && street.trim().length > 0)
  /** Адрес одной строкой для курьера и колонки delivery_address */
  const composedAddress = [
    street.trim(),
    apartment.trim() && `${t(lang, 'pubApartment')} ${apartment.trim()}`,
    floor.trim() && `${t(lang, 'pubFloor')} ${floor.trim()}`,
    city.trim(),
  ].filter(Boolean).join(', ')
  const contactOk = isTableOrder || (name.trim().length > 0 && phoneDigits.length >= 9)
  const timeOk = isTableOrder || asap || activeSlot !== ''
  // Что именно оформляется — заказ «на сейчас» или предзаказ (116). За столом
  // предзаказа нет: гость сидит в зале, сервер всё равно обнулит pickup_at.
  const isPreorder = !isTableOrder && !asap && activeSlot !== ''
  // Отправка разрешена, если точка открыта сейчас ЛИБО это корректный
  // предзаказ на будущее окно. Раньше здесь стоял один флаг isOpen, и
  // закрытое заведение не принимало даже заказ на завтра.
  const canSubmit = isPreorder ? canPreorder : openNow
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
      // Слот уже посчитан в таймзоне точки — берём его момент как есть
      const pickupIso = !isTableOrder && !asap && activeSlot ? activeSlot : null
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
        delivery_address: orderType === 'delivery' ? composedAddress : null,
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

  if (stage === 'cart') {
    return (
      <CartStage
        lang={lang}
        cart={cart}
        total={total}
        itemImages={itemImages}
        recommendations={recommendations}
        onQty={onQty}
        onEditLine={onEditLine}
        onRecommend={onRecommend}
        onAddItems={onAddItems}
        onContinue={onContinue}
      />
    )
  }

  return (
    <div className="public-menu-checkout">
      <div className="public-menu-checkout-content public-menu-route-motion">
        {/* Только заголовок: надзаголовок «сводка заказа» и подпись
            «выберите способ получения…» дублировали то, что и так видно
            в самих чипах ниже. */}
        <div className="public-menu-checkout-intro">
          <h1 className="font-display text-gray-900 public-menu-route-focus public-menu-route-heading" tabIndex={-1}>
            {t(lang, 'pubPaymentTitle')}
          </h1>
        </div>

        {contextMessage && (
          <div className="public-menu-checkout-alert is-error" role="alert">{contextMessage}</div>
        )}

        {/* Нумерованных заголовков шагов больше нет: «как получить» и
            «контакты» очевидны из самих полей, а цифры превращали короткую
            форму в анкету. */}
        <section className="public-menu-checkout-card public-menu-order-card">
          {isTableOrder && tableContext ? (
            <div className="public-menu-checkout-fulfilment is-table">
              <span className="public-menu-checkout-fulfilment-icon">{tableContext.label}</span>
              <span className="min-w-0">
                <small>{t(lang, 'pubOrderingFor')}</small>
                <strong>
                  {t(lang, 'pubTable')} {tableContext.label}
                  {tableContext.zone ? ` · ${tableContext.zone}` : ''}
                </strong>
              </span>
              <span className="public-menu-checkout-status">{t(lang, 'pubPayLater')}</span>
            </div>
          ) : (
            <>
              {orderTypes.length > 1 && (
                <div className="public-menu-order-types">
                  {orderTypes.map((type) => (
                    <Chip key={type} active={orderType === type} onClick={() => setOrderType(type)}>
                      {t(lang, type === 'here' ? 'pubTypeHere' : type === 'delivery' ? 'pubTypeDelivery' : 'pubTypeTakeaway')}
                    </Chip>
                  ))}
                </div>
              )}
              {/* Блок «способ получения · без онлайн-оплаты» убран: он
                  дословно повторял только что выбранный чип и добавлял
                  экран прокрутки. Оплата на месте сказана в секции ниже. */}
            </>
          )}
        </section>

        <section className="public-menu-checkout-card public-menu-checkout-form">
          {/* Поля — подчёркнутые строки без коробок: подпись работает
              плейсхолдером и уезжает наверх, когда гость начал вводить.
              Так форма читается списком, а не анкетой из рамок, и один
              и тот же вид годится для «сидеть», «забрать» и доставки —
              меняется только набор строк. */}
          {!isTableOrder && (
            <div className="public-menu-checkout-fields is-underlined">
              <label className={`public-menu-underline-field ${
                showValidation && !name.trim() ? 'is-invalid' : ''
              }`}>
                <input
                  autoComplete="name"
                  placeholder=" "
                  value={name}
                  aria-invalid={showValidation && !name.trim()}
                  onChange={(event) => setName(event.target.value)}
                />
                <span>{t(lang, 'pubYourName')}</span>
              </label>
              <label className={`public-menu-underline-field ${
                showValidation && phoneDigits.length < 9 ? 'is-invalid' : ''
              }`}>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  dir="ltr"
                  placeholder=" "
                  value={phone}
                  aria-invalid={showValidation && phoneDigits.length < 9}
                  onChange={(event) => setPhone(event.target.value)}
                />
                <span>{t(lang, 'pubPhone')}</span>
              </label>
              <small className="public-menu-field-hint">{t(lang, 'pubPhoneHint')}</small>

              {/* Адрес раздельными полями и только для доставки: одной
                  строкой гость регулярно забывал квартиру и этаж, и курьер
                  звонил уточнять. В базу уходит собранной строкой —
                  колонка delivery_address не меняется. */}
              {orderType === 'delivery' && (
                <>
                  <label className={`public-menu-underline-field ${
                    showValidation && !city.trim() ? 'is-invalid' : ''
                  }`}>
                    <input
                      autoComplete="address-level2"
                      placeholder=" "
                      value={city}
                      aria-invalid={showValidation && !city.trim()}
                      onChange={(event) => setCity(event.target.value)}
                    />
                    <span>{t(lang, 'pubCity')}</span>
                  </label>
                  <label className={`public-menu-underline-field ${
                    showValidation && !street.trim() ? 'is-invalid' : ''
                  }`}>
                    <input
                      autoComplete="street-address"
                      placeholder=" "
                      value={street}
                      aria-invalid={showValidation && !street.trim()}
                      onChange={(event) => setStreet(event.target.value)}
                    />
                    <span>{t(lang, 'pubStreet')}</span>
                  </label>
                  {/* Квартира и этаж — короткие, в один ряд, как в референсе */}
                  <div className="public-menu-address-row">
                    <label className="public-menu-underline-field">
                      <input
                        inputMode="numeric"
                        placeholder=" "
                        value={apartment}
                        onChange={(event) => setApartment(event.target.value)}
                      />
                      <span>{t(lang, 'pubApartment')}</span>
                    </label>
                    <label className="public-menu-underline-field">
                      <input
                        inputMode="numeric"
                        placeholder=" "
                        value={floor}
                        onChange={(event) => setFloor(event.target.value)}
                      />
                      <span>{t(lang, 'pubFloor')}</span>
                    </label>
                  </div>
                </>
              )}

              <div>
                <span className="public-menu-field-label public-menu-subsection">
                  {t(lang, 'pubPickupTime')}
                </span>
                <div className="public-menu-time-options">
                  {/* Время готовки — отдельной строкой под подписью и не
                      жирным: в одну строку через «·» оно удлиняло чип вдвое
                      и рвалось посередине («~20–» / «45 דק׳»). */}
                  {/* «Как можно скорее» доступно только пока точка открыта:
                      закрытому заведению такую заявку готовить некому (116) */}
                  <Chip active={asap} disabled={!openNow} onClick={() => setAsap(true)}>
                    <span className="public-menu-chip-stack">
                      <span>{t(lang, 'pubAsap')}</span>
                      {formatPrepRange(lang, prepMin, prepMax) && (
                        <small dir="ltr">{formatPrepRange(lang, prepMin, prepMax)}</small>
                      )}
                    </span>
                  </Chip>
                  {/* Заказ на время возможен, только если внутри часов работы
                      есть хотя бы один свободный слот (112) */}
                  <Chip
                    active={!asap}
                    disabled={slots.length === 0}
                    onClick={() => setAsap(false)}
                  >
                    {t(lang, 'pubAtTime')}
                  </Chip>
                </div>
                {!asap && (
                  slots.length === 0 ? (
                    <p className="public-menu-time-empty">{t(lang, 'pubNoSlots')}</p>
                  ) : (
                    /* Барабан, а не select: слотов у полного дня под сотню,
                       и системный список гость листал без ощущения «дня».
                       В шторке день и время разведены по колёсам. */
                    <button
                      type="button"
                      className={`public-menu-field is-select is-picker ${
                        showValidation && !timeOk ? 'is-invalid' : ''
                      }`}
                      aria-haspopup="dialog"
                      aria-invalid={showValidation && !timeOk}
                      onClick={() => setPickerOpen(true)}
                    >
                      {selectedSlot
                        ? `${t(lang, selectedSlot.day === 'today' ? 'pubSlotsToday' : 'pubSlotsTomorrow')} · ${selectedSlot.label}`
                        : t(lang, 'pubPickSlot')}
                    </button>
                  )
                )}
              </div>
            </div>
          )}

          <label className="public-menu-underline-field">
            <input
              placeholder=" "
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <span>{t(lang, 'pubNote')}</span>
          </label>
        </section>

        <section className="public-menu-checkout-card public-menu-payment-card">
          {/* Короткое «Оплата», а не pubPaymentTitle: тот уже стоит
              заголовком страницы. Размер общий с «когда приготовить» —
              оба подзаголовка блоков. */}
          <span className="public-menu-field-label public-menu-subsection">
            {t(lang, 'payment')}
          </span>
          <div className="public-menu-payment-note">
            <span aria-hidden>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                <path d="M12 3 5 6v5c0 4.5 2.7 8.1 7 10 4.3-1.9 7-5.5 7-10V6l-7-3Z" strokeLinejoin="round" />
                <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>
              <strong>{t(lang, 'pubNoOnlinePayment')}</strong>
              <small>{t(lang, isTableOrder ? 'pubPayAtTable' : 'pubPayAtPickup')}</small>
            </span>
          </div>
        </section>

        <div className="public-menu-checkout-spacer" aria-hidden />
      </div>

      <div className="public-menu-checkout-submitbar">
        {(error || (showValidation && validationText) || availabilityMessage || (!openNow && !availabilityMessage)) && (
          <div
            className={`public-menu-checkout-alert ${
              error || (showValidation && validationText) ? 'is-error' : 'is-warning'
            }`}
            role="alert"
          >
            {error || (showValidation && validationText) || availabilityMessage || t(lang, 'pubClosed')}
          </div>
        )}
        {/* Итог отдельной строкой над кнопкой, а не внутри неё: на финальном
            шаге сумма — то, что гость перепроверяет перед отправкой, и она
            должна читаться как число, а не как часть подписи кнопки. */}
        <div className="public-menu-checkout-total">
          <span className="public-menu-checkout-total-label">
            <strong>{t(lang, 'pubTotal')}</strong>
            <small>{t(lang, 'pubTotalVatNote')}</small>
          </span>
          <span className="public-menu-checkout-total-value" dir="ltr">
            {formatMoney(total, lang)}
          </span>
        </div>
        <button
          disabled={busy || !canSubmit}
          onClick={submit}
          className="public-menu-checkout-submit is-final"
        >
          {busy ? t(lang, 'pubSubmitting') : t(lang, isTableOrder ? 'pubSubmitTable' : 'pubSubmitCounter')}
        </button>
      </div>

      {pickerOpen && (
        <PickupTimeSheet
          lang={lang}
          slots={slots}
          value={activeSlot}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(iso) => { setSlotIso(iso); setPickerOpen(false) }}
        />
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
  /** Связь пропала: показываем гостю, что статус мог устареть */
  const [offline, setOffline] = useState(false)

  /**
   * Заказ в терминальном состоянии — дальше опрашивать нечего.
   * Раньше опрос жил вечно: гость оставлял экран, и телефон всю ночь
   * дёргал сервер каждые 5 секунд.
   */
  const finished = status !== null && (
    status.order_status === 'paid'
    || status.order_status === 'fulfilled'
    || status.order_status === 'voided'
    || status.status === 'rejected'
    || status.status === 'cancelled'
    || status.status === 'completed'
  )

  useEffect(() => {
    if (lost || finished) return

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      // В фоне не опрашиваем: вкладка скрыта — гость статус не видит
      if (document.visibilityState !== 'visible') return
      try {
        const s = await fetchPublicStatus(clientUuid)
        if (stopped) return
        setStatus(s)
        setLost(false)
        setOffline(false)
      } catch (e) {
        if (stopped) return
        if (e instanceof PublicApiError && e.code === 'not_found') setLost(true)
        // Сеть отвалилась — не молчим: прежде статус просто «замерзал»
        else setOffline(true)
      }
    }

    const loop = () => {
      void poll()
      timer = setTimeout(loop, 5000)
    }
    loop()

    // Вернулись в приложение — обновляем сразу, не ждём следующего тика
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [clientUuid, lost, finished])

  if (lost) {
    return (
      <CenterCard>
        <p className="font-bold text-gray-900">{t(lang, 'pubStatusLost')}</p>
        <NewOrderBtn lang={lang} onClick={onNewOrder} />
      </CenterCard>
    )
  }
  if (!status) {
    // Первая загрузка без сети: «Загрузка» висела бы бесконечно
    return (
      <CenterCard>
        <p className="text-gray-500">{t(lang, offline ? 'pubStatusOffline' : 'loading')}</p>
      </CenterCard>
    )
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
      {/* Связь пропала: статус мог устареть — прежде экран просто «замерзал» */}
      {offline && (
        <p className="text-xs font-semibold text-gray-500 mb-4">{t(lang, 'pubStatusOffline')}</p>
      )}
      {/* Номер дня есть только у POS-заказа; standalone-заявка живёт без него */}
      {status.daily_number != null && (
        <>
          <p className="text-sm font-bold text-gray-900 uppercase tracking-wide">{t(lang, 'pubOrderNumber')}</p>
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
        // Пока заказ готовится кнопка вторичная (см. вызов), но выделена
        // заливкой, а не тонкой рамкой — рамка терялась на белом фоне.
        secondary
          ? 'bg-gray-100 border border-gray-300 text-gray-900'
          : 'bg-gray-900 text-white shadow-lg shadow-black/20'
      }`}
    >
      {t(lang, 'pubNewOrder')}
    </button>
  )
}

function Chip({ active, onClick, children, disabled = false }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      /* Выбранный чип — светлый с контуром, а не сплошная чёрная заливка:
         заливка принадлежит главному действию (кнопка отправки заказа).
         Раньше тип заказа, время и модификаторы были такими же чёрными
         и спорили с ней за внимание. */
      className={`h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.96] ${
        active
          ? 'public-menu-chip-active bg-white text-gray-900'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
      } ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
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
    case 'network': return t(lang, 'pubErrNetwork')
    case 'disabled': return t(lang, 'pubPaused')
    case 'paused': return t(lang, 'pubPaused')
    case 'closed': return t(lang, 'pubErrClosed')
    case 'rate_limited': return t(lang, 'pubErrRate')
    case 'busy': return t(lang, 'pubErrBusy')
    case 'item_unavailable': return `${t(lang, 'pubErrUnavailable')}${detail ? `: ${detail}` : ''}`
    case 'invalid_phone': return t(lang, 'pubErrPhone')
    case 'invalid_address': return t(lang, 'pubErrAddress')
    // Выбранное время вне часов работы (112): слот мог устареть, пока
    // гость заполнял форму, — просим выбрать заново.
    case 'pickup_outside_hours': return t(lang, 'pubErrPickupHours')
    case 'invalid_table': return t(lang, 'pubTableQrExpired')
    case 'table_ordering_disabled': return t(lang, 'pubTableOrderingDisabled')
    default: return t(lang, 'pubErrGeneric')
  }
}
