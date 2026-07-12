import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { t, formatTime, type Lang } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import {
  fetchPublicMenu, fetchPublicStatus, submitPublicOrder, PublicApiError,
  type PublicItem, type PublicMenu, type PublicStatus, type PublicOrderType,
} from './publicApi'
import BrandSplash from '../../components/ui/BrandSplash'

/**
 * Публичная страница «закажи и забери» (050): меню → корзина → заявка →
 * ожидание подтверждения кассой. Оплата на кассе при получении.
 * Мобильная, he по умолчанию (гости кофейни), язык переключается.
 * Никакого Supabase-клиента: только Edge Functions с anon-ключом.
 */

const ACTIVE_KEY = 'kassa-public-active' // {clientUuid, locId} — текущая заявка

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
  // Гостевая страница — всегда иврит (заказ he-first), без переключения языка.
  const lang: Lang = 'he'
  useEffect(() => {
    // <html lang> решает RTL в проде: start/end скомпилированы через :lang(he)
    document.documentElement.lang = lang
  }, [])
  const isRtl = true

  // Незавершённая заявка переживает перезагрузку страницы
  const [activeUuid, setActiveUuid] = useState<string | null>(() => readActive(locId))

  const [cart, setCart] = useState<CartLine[]>([])
  const [view, setView] = useState<'menu' | 'checkout'>('menu')
  const [configItem, setConfigItem] = useState<PublicItem | null>(null)
  // null = экран плиток категорий; id = экран позиций категории
  const [activeCat, setActiveCat] = useState<string | null>(null)
  useEffect(() => { window.scrollTo(0, 0) }, [activeCat, view])

  const { data: menu, isLoading, isError } = useQuery({
    queryKey: ['public_menu', locId],
    queryFn: () => fetchPublicMenu(locId),
    staleTime: 30_000,
    enabled: !activeUuid, // на экране статуса меню не нужно
  })

  const cartCount = cart.reduce((s, l) => s + l.qty, 0)
  const cartTotal = cart.reduce((s, l) => s + l.unitPrice * l.qty, 0)

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

  // ── Экран статуса активной заявки ──────────────────────────
  if (activeUuid) {
    return (
      <Shell isRtl={isRtl} title={menu?.location.business_name || menu?.location.name} logo={menu?.location.logo_url}>
        <StatusScreen lang={lang} clientUuid={activeUuid} onNewOrder={startNewOrder} />
      </Shell>
    )
  }

  // Сплэш Angle держится, пока грузится меню (done=false), и растворяется,
  // когда данные пришли. Первым ребёнком фрагмента во всех трёх ветках —
  // React сохраняет его состояние и анимация не перезапускается.
  if (isLoading) {
    return (
      <>
        <BrandSplash done={false} />
        <Shell isRtl={isRtl}>
          <div className="py-24 text-center text-gray-500">{t(lang, 'loading')}</div>
        </Shell>
      </>
    )
  }
  if (isError || !menu) {
    return (
      <>
        <BrandSplash />
        <Shell isRtl={isRtl}>
          <div className="py-24 text-center text-gray-500">{t(lang, 'pubMenuError')}</div>
        </Shell>
      </>
    )
  }

  return (
    <>
    <BrandSplash />
    <Shell
      isRtl={isRtl}
      title={menu.location.business_name || menu.location.name}
      logo={menu.location.logo_url}
      hero={view === 'menu' && !activeCat}
      headerImg={menu.location.header_url}
      bgImg={menu.location.background_url}
    >
      {menu.location.accepting === false ? (
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

      {view === 'menu' && !activeCat && (
        // Главный экран: плитки категорий растягиваются на всю высоту
        // (auto-rows-fr + flex-1 — пустого «хвоста» не остаётся), внизу подвал
        <>
          <div className="px-4 mt-4 flex-1 grid grid-cols-2 auto-rows-fr gap-3">
            {menu.categories.map((cat) => {
              const cover = cat.items.find((i) => i.image_url)?.image_url
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCat(cat.id)}
                  className="relative min-h-28 rounded-2xl overflow-hidden bg-gray-200 active:scale-[0.98] transition-all text-start"
                >
                  {cover && <img src={cover} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />}
                  <span className="absolute inset-0 bg-black/15" />
                  <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-white text-lg font-bold leading-tight [text-shadow:0_1px_6px_rgba(0,0,0,0.55)]">{cat.name}</span>
                </button>
              )
            })}
          </div>
          <SocialFooter links={menu.location.links} lang={lang} padForCart={cartCount > 0} />
        </>
      )}

      {view === 'menu' && activeCat && (() => {
        const cat = menu.categories.find((c) => c.id === activeCat)
        if (!cat) return null
        return (
          <>
            {/* Чипы: возврат к плиткам + быстрый переход между категориями */}
            <nav className="sticky top-14 z-10 bg-white/95 backdrop-blur border-b border-gray-100 px-4 py-2 flex gap-2 overflow-x-auto">
              <button
                onClick={() => setActiveCat(null)}
                aria-label={t(lang, 'back')}
                className="h-10 w-10 rounded-full bg-gray-100 text-gray-600 shrink-0 flex items-center justify-center active:scale-[0.96] transition-all"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="rtl:-scale-x-100">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>
              {menu.categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveCat(c.id)}
                  className={`h-10 px-4 rounded-full text-sm font-semibold whitespace-nowrap transition-all active:scale-[0.96] shrink-0 ${
                    c.id === activeCat ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </nav>
            <div className="px-4 pb-32">
              <h2 className="text-lg font-bold text-gray-900 mt-5 mb-3">{cat.name}</h2>
              <div className="space-y-2">
                {cat.items.map((item) => (
                  <ItemRow key={item.id} item={item} lang={lang} onTap={() => {
                    // Простой товар — сразу в корзину; сложный — конфигуратор
                    if (item.variants.length === 0 && item.modifier_groups.length === 0) {
                      addLine({
                        itemId: item.id, name: item.name, variantId: null, variantName: null,
                        modIds: [], modNames: [], unitPrice: item.price,
                      })
                    } else {
                      setConfigItem(item)
                    }
                  }} />
                ))}
              </div>
            </div>
          </>
        )
      })()}

      {view === 'menu' && (
        <>
          {cartCount > 0 && (
            <div className="fixed bottom-0 inset-x-0 p-4 bg-gradient-to-t from-white via-white to-transparent">
              <button
                onClick={() => setView('checkout')}
                className="w-full h-16 rounded-full bg-gray-900 text-white ps-2 pe-6 flex items-center gap-4 active:scale-[0.98] transition-all"
              >
                <span className="w-11 h-11 shrink-0 rounded-full bg-white text-gray-900 font-bold text-lg flex items-center justify-center tabular-nums">
                  {cartCount}
                </span>
                <span className="font-bold text-lg">{t(lang, 'pubShowItems')}</span>
                {/* Сумма к краю (на RTL — левому); знак ₪ слева от числа */}
                <span className="ms-auto font-bold text-xl tabular-nums" dir="ltr">
                  ₪{(cartTotal / 100).toLocaleString('he-IL', {
                    minimumFractionDigits: cartTotal % 100 === 0 ? 0 : 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </button>
            </div>
          )}
        </>
      )}

      {view === 'checkout' && (
        <CheckoutScreen
          lang={lang}
          locId={locId}
          isOpen={menu.location.is_open && menu.location.accepting !== false}
          prepMin={menu.location.prep_min ?? 0}
          prepMax={menu.location.prep_max ?? 0}
          orderTypes={menu.location.order_types ?? ['here', 'takeaway']}
          cart={cart}
          total={cartTotal}
          onQty={updateQty}
          onBack={() => setView('menu')}
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
          onClose={() => setConfigItem(null)}
          onAdd={(line) => {
            addLine(line)
            setConfigItem(null)
          }}
        />
      )}
    </Shell>
    </>
  )
}

/**
 * Каркас страницы. Два режима шапки:
 * hero — главный экран плиток: крупный логотип и название по центру;
 * компактная sticky-шапка (h-14) — категории/корзина/статус, к ней
 * привязаны чипы навигации (sticky top-14).
 * Оформление (Настройки → Онлайн-заказы): headerImg — баннер вместо
 * белой hero-шапки; bgImg — фон главного экрана (fixed-подложка),
 * шапка и плитки накладываются поверх, текст шапки — белый.
 */
function Shell({ isRtl, title, logo, hero, headerImg, bgImg, children }: {
  isRtl: boolean
  title?: string
  logo?: string | null
  hero?: boolean
  headerImg?: string | null
  bgImg?: string | null
  children: React.ReactNode
}) {
  const hasBg = !!(hero && bgImg)
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#eceef1]">
      {hasBg && (
        // Фон не скроллится вместе с контентом; колонка та же max-w-lg
        <div className="fixed inset-0 pointer-events-none" aria-hidden>
          <div className="max-w-lg mx-auto h-full relative overflow-hidden">
            <img src={bgImg!} alt="" className="absolute inset-0 w-full h-full object-cover" />
            <span className="absolute inset-0 bg-black/30" />
          </div>
        </div>
      )}
      <div className={`relative max-w-lg mx-auto min-h-screen flex flex-col ${hasBg ? '' : 'bg-white'}`}>
        {hero ? (
          headerImg ? (
            // Баннер-шапка: фото, поверх — логотип и название (белым на скриме)
            <header className="relative h-32 shrink-0">
              <img src={headerImg} alt="" className="absolute inset-0 w-full h-full object-cover" />
              <span className="absolute inset-0 bg-black/35" />
              {/* Логотип на баннере не дублируем — сам баннер уже брендирован */}
              <div className="absolute inset-0 flex flex-col items-center justify-center px-4 pointer-events-none">
                <h1 className="font-display text-[64px] font-bold text-white leading-tight text-center [text-shadow:0_1px_8px_rgba(0,0,0,0.45)]">
                  {title ?? ''}
                </h1>
              </div>
            </header>
          ) : (
          <header className="relative px-8 pt-8 pb-2 text-center">
            <h1 className={`font-display text-[64px] font-bold leading-tight mt-8 ${
              hasBg ? 'text-white [text-shadow:0_1px_8px_rgba(0,0,0,0.45)]' : 'text-gray-900'
            }`}>
              {title ?? ''}
            </h1>
          </header>
          )
        ) : (
          <header className="sticky top-0 z-10 bg-white border-b border-gray-100 px-4 h-14 flex items-center justify-center relative">
            {/* Логотип у начала строки; название — по центру */}
            {logo && <img src={logo} alt="" className="absolute start-4 w-9 h-9 rounded-full object-cover" />}
            <span className="font-display px-14 text-center font-bold text-xl text-gray-900 truncate">
              {title ?? ''}
            </span>
          </header>
        )}
        <div className="flex-1 flex flex-col">{children}</div>
      </div>
    </div>
  )
}

/**
 * Подвал главного экрана: Instagram / Facebook / отзыв в Google.
 * Ссылки настраиваются в кассе (Настройки → Обслуживание → Онлайн-заказы);
 * пустая ссылка = кнопки нет. padForCart — просвет под фиксированной
 * кнопкой корзины.
 */
function SocialFooter({ links, lang, padForCart }: {
  links?: PublicMenu['location']['links']
  lang: Lang
  padForCart: boolean
}) {
  const iconBtn =
    'w-12 h-12 rounded-full bg-gray-100 text-gray-700 flex items-center justify-center active:scale-[0.94] transition-all'
  const hasAny = !!(links?.instagram || links?.facebook || links?.google_review)
  if (!hasAny) return padForCart ? <div className="pb-24" /> : null
  return (
    <footer className={`px-4 pt-10 flex flex-col items-center gap-4 ${padForCart ? 'pb-28' : 'pb-8'}`}>
      {(links?.instagram || links?.facebook) && (
        <div className="flex items-center gap-3">
          {links?.instagram && (
            <a href={links.instagram} target="_blank" rel="noopener noreferrer" aria-label="Instagram" className={iconBtn}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" stroke="none" />
              </svg>
            </a>
          )}
          {links?.facebook && (
            <a href={links.facebook} target="_blank" rel="noopener noreferrer" aria-label="Facebook" className={iconBtn}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
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
          className="h-11 px-5 rounded-full bg-gray-100 text-sm font-semibold text-gray-700 flex items-center gap-2 active:scale-[0.96] transition-all"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
          </svg>
          {t(lang, 'pubReviewGoogle')}
        </a>
      )}
    </footer>
  )
}

/**
 * Карточка товара — классический вид меню доставки: фото, название,
 * цена, кнопка «+». Без фото — плейсхолдер с первой буквой названия,
 * чтобы список не «прыгал» по выравниванию.
 */
function ItemRow({ item, lang, onTap }: { item: PublicItem; lang: Lang; onTap: () => void }) {
  const prices = item.variants.length > 0 ? item.variants.map((v) => v.price) : [item.price]
  const minPrice = Math.min(...prices)
  const hasRange = new Set(prices).size > 1
  return (
    <button
      onClick={onTap}
      className="w-full rounded-2xl bg-gray-50 hover:bg-gray-100 active:scale-[0.99] transition-all flex items-center gap-3 p-3 text-start"
    >
      {item.image_url ? (
        <img src={item.image_url} alt="" loading="lazy" className="w-16 h-16 rounded-xl object-cover shrink-0 bg-white" />
      ) : (
        <span className="w-16 h-16 rounded-xl bg-white text-gray-300 text-2xl font-bold shrink-0 flex items-center justify-center">
          {item.name.slice(0, 1)}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block font-semibold text-gray-900 leading-snug">{item.name}</span>
        {item.description && (
          <span className="block text-xs text-gray-500 mt-0.5 leading-snug line-clamp-2">{item.description}</span>
        )}
        <span className="block text-sm font-semibold text-gray-900 mt-1 tabular-nums">
          {hasRange && <span className="text-gray-500 font-normal">{t(lang, 'pubFrom')} </span>}
          {/* dir=ltr: цена не пляшет в bidi-контексте ивритских названий */}
          <span dir="ltr">{formatMoney(minPrice, lang)}</span>
        </span>
      </span>
      <span className="w-9 h-9 rounded-full bg-gray-900 text-white shrink-0 flex items-center justify-center" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
    </button>
  )
}

/** Конфигуратор позиции: размер, модификаторы (min/max по группе), количество */
function ItemConfigSheet({ item, lang, isRtl, onClose, onAdd }: {
  item: PublicItem
  lang: Lang
  isRtl: boolean
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
    <div dir={isRtl ? 'rtl' : 'ltr'} className="fixed inset-0 z-20 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-white rounded-t-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {item.image_url && (
          <img src={item.image_url} alt="" className="w-full h-44 object-cover shrink-0" />
        )}
        <div className="px-6 pt-5 pb-3 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-gray-900">{item.name}</h3>
            {item.description && <p className="text-sm text-gray-500 mt-1 leading-snug">{item.description}</p>}
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-xl bg-gray-100 text-gray-500 font-bold active:scale-[0.94] transition-all">✕</button>
        </div>

        <div className="px-6 overflow-y-auto space-y-5 pb-4">
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

        <div className="p-4 border-t border-gray-100 shrink-0">
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
      </div>
    </div>
  )
}

/** Корзина + форма контактов + отправка заявки */
function CheckoutScreen({ lang, locId, isOpen, prepMin, prepMax, orderTypes, cart, total, onQty, onBack, onSubmitted }: {
  lang: Lang
  locId: string
  isOpen: boolean
  /** Время приготовления — вилка мин–макс (061): 0/0 = не показывать */
  prepMin: number
  prepMax: number
  orderTypes: PublicOrderType[]
  cart: CartLine[]
  total: number
  onQty: (key: string, qty: number) => void
  onBack: () => void
  onSubmitted: (clientUuid: string) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [asap, setAsap] = useState(true)
  const [time, setTime] = useState('')
  const [note, setNote] = useState('')
  // Тип заказа: первый включённый по умолчанию. Если включён один —
  // вопрос не показываем (нечего выбирать).
  const [orderType, setOrderType] = useState<PublicOrderType>(orderTypes[0] ?? 'takeaway')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // client_uuid создаётся один раз на попытку оформления: ретрай после
  // сбоя сети не создаст дубликат (идемпотентность submit_online_order)
  const clientUuid = useMemo(() => crypto.randomUUID(), [])

  const phoneDigits = phone.replace(/\D/g, '')
  const addressOk = orderType !== 'delivery' || address.trim().length > 0
  const valid = cart.length > 0 && name.trim().length > 0 && phoneDigits.length >= 9 && (asap || time !== '') && addressOk

  async function submit() {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      let pickupIso: string | null = null
      if (!asap && time) {
        const [h, m] = time.split(':').map(Number)
        const d = new Date()
        d.setHours(h, m, 0, 0)
        // Время сегодняшнего дня; прошедшее сервер трактует как «как можно скорее»
        pickupIso = d.toISOString()
      }
      await submitPublicOrder({
        loc: locId,
        client_uuid: clientUuid,
        name: name.trim(),
        phone: phoneDigits,
        pickup_at: pickupIso,
        note: note.trim() || null,
        order_type: orderType,
        delivery_address: orderType === 'delivery' ? address.trim() : null,
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
    <div className="px-4 pb-8">
      <button onClick={onBack} className="mt-4 h-11 px-4 rounded-xl bg-gray-100 text-sm font-semibold text-gray-700 active:scale-[0.96] transition-all">
        ← {t(lang, 'back')}
      </button>

      <h2 className="text-lg font-bold text-gray-900 mt-4 mb-3">{t(lang, 'pubCart')}</h2>
      <div className="space-y-2">
        {cart.map((l) => (
          <div key={l.key} className="flex items-center gap-3 rounded-2xl bg-gray-50 px-4 py-3">
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

      <div className="flex items-center justify-between mt-4 px-1">
        <span className="font-bold text-gray-900">{t(lang, 'pubTotal')}</span>
        <span className="font-black text-xl tabular-nums text-gray-900" dir="ltr">{formatMoney(total, lang)}</span>
      </div>
      <p className="text-xs text-gray-500 mt-1 px-1">{t(lang, 'pubPayAtPickup')}</p>

      {/* Тип заказа (055): показываем вопрос только если вариантов >1 */}
      {orderTypes.length > 1 && (
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
        <input
          className="w-full h-12 mt-3 rounded-xl border border-gray-200 px-4 text-base focus:outline-none focus:border-gray-900"
          placeholder={t(lang, 'pubAddress')}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      )}

      <h2 className="text-lg font-bold text-gray-900 mt-6 mb-3">{t(lang, 'pubContact')}</h2>
      <div className="space-y-3">
        <input
          className="w-full h-12 rounded-xl border border-gray-200 px-4 text-base focus:outline-none focus:border-gray-900"
          placeholder={t(lang, 'pubYourName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="w-full h-12 rounded-xl border border-gray-200 px-4 text-base focus:outline-none focus:border-gray-900"
          placeholder={t(lang, 'pubPhone')}
          type="tel"
          dir="ltr"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />

        <div className="flex gap-2">
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
              onChange={(e) => setTime(e.target.value)}
            />
          )}
        </div>

        <input
          className="w-full h-12 rounded-xl border border-gray-200 px-4 text-base focus:outline-none focus:border-gray-900"
          placeholder={t(lang, 'pubNote')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {error && <div className="mt-4 rounded-2xl bg-red-50 text-red-600 text-sm font-semibold px-4 py-3">{error}</div>}
      {!isOpen && <div className="mt-4 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3">{t(lang, 'pubClosed')}</div>}

      <button
        disabled={!valid || busy || !isOpen}
        onClick={submit}
        className="w-full h-14 mt-4 rounded-2xl bg-gray-900 text-white font-bold disabled:opacity-40 active:scale-[0.98] transition-all"
      >
        {busy ? t(lang, 'pubSubmitting') : `${t(lang, 'pubSubmit')} · ${formatMoney(total, lang)}`}
      </button>
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
        <div className="w-10 h-10 mx-auto rounded-full border-4 border-gray-200 border-t-gray-900 animate-spin" />
        <p className="text-xl font-bold text-gray-900 mt-5">{t(lang, 'pubWaiting')}</p>
        <p className="text-sm text-gray-500 mt-2">{t(lang, 'pubWaitingHint')}</p>
      </CenterCard>
    )
  }

  // accepted
  const os = status.order_status
  if (os === 'voided') {
    return (
      <CenterCard>
        <p className="text-2xl font-black text-gray-900">{t(lang, 'pubCancelledTitle')}</p>
        <NewOrderBtn lang={lang} onClick={onNewOrder} />
      </CenterCard>
    )
  }
  const isDone = os === 'paid' || os === 'fulfilled'
  return (
    <CenterCard>
      <p className="text-sm font-bold text-gray-500 uppercase tracking-wide">{t(lang, 'pubOrderNumber')}</p>
      <p className="text-6xl font-black tabular-nums text-gray-900 mt-2">#{status.daily_number}</p>
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
        {isDone ? t(lang, 'pubDoneHint') : t(lang, 'pubShowNumber')}
      </p>
      <p className="text-lg font-bold tabular-nums text-gray-900 mt-3" dir="ltr">{formatMoney(status.total, lang)}</p>
      {/* Пока заказ не выдан — вторичная, чтобы случайно не потерять экран с номером */}
      <NewOrderBtn lang={lang} onClick={onNewOrder} secondary={!isDone} />
    </CenterCard>
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
    default: return t(lang, 'pubErrGeneric')
  }
}
