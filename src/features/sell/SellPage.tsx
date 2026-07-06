import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCategories, fetchItems, fetchModifierGroups } from '../menu/api'
import { placeOrder } from './api'
import { useCartStore, cartTotal, lineUnitPrice, type CartLine, type CartMod } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import type { MenuItem, ModifierGroup } from '../../types'
import ItemPicker from './ItemPicker'
import AppSidebar from '../../components/AppSidebar'
import ItemImage from '../../components/ItemImage'

/** Дефолтная конфигурация товара — для добавления в 1 тап */
function defaultConfig(item: MenuItem, groups: ModifierGroup[]) {
  const variants = (item.item_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
  const variant = variants.find((v) => v.is_default) ?? variants[0] ?? null
  const mods: CartMod[] = groups.flatMap((g) =>
    (g.modifiers ?? [])
      .filter((m) => m.is_default && m.is_available)
      .map((m) => ({ id: m.id, name: m.name, priceDelta: m.price_delta }))
  )
  return {
    itemId: item.id,
    name: item.name,
    variantId: variant?.id ?? null,
    variantName: variant?.name ?? null,
    basePrice: variant?.price ?? item.price,
    mods,
    notes: '',
  }
}

export default function SellPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const { data: categories = [] } = useQuery({ queryKey: ['menu_categories'], queryFn: fetchCategories })
  const { data: items = [] } = useQuery({ queryKey: ['menu_items'], queryFn: fetchItems })
  const { data: allGroups = [] } = useQuery({ queryKey: ['modifier_groups'], queryFn: fetchModifierGroups })

  const cart = useCartStore()

  const hasFavorites = useMemo(() => items.some((i) => i.is_favorite && i.is_available), [items])
  const [activeCat, setActiveCat] = useState<string | 'all' | 'fav' | null>(null)
  const [search, setSearch] = useState('')
  const [picker, setPicker] = useState<{ item: MenuItem; line: CartLine | null } | null>(null)
  const [placedNumber, setPlacedNumber] = useState<number | null>(null)
  const [clientUuid, setClientUuid] = useState(() => crypto.randomUUID())

  // Стартовая вкладка: избранное, если оно есть
  const currentCat = activeCat ?? (hasFavorites ? 'fav' : 'all')

  const visibleItems = useMemo(() => {
    let list = items.filter((i) => i.is_available)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      return list.filter((i) => i.name.toLowerCase().includes(q))
    }
    if (currentCat === 'fav') list = list.filter((i) => i.is_favorite)
    else if (currentCat !== 'all') list = list.filter((i) => i.category_id === currentCat)
    return list
  }, [items, currentCat, search])

  function itemGroups(item: MenuItem): ModifierGroup[] {
    const links = (item.menu_item_modifier_groups ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
    return links
      .map((l) => allGroups.find((g) => g.id === l.group_id))
      .filter((g): g is ModifierGroup => !!g)
  }

  function handleItemTap(item: MenuItem) {
    const groups = itemGroups(item)
    if (item.ask_modifiers && (groups.length > 0 || (item.item_variants?.length ?? 0) > 0)) {
      setPicker({ item, line: null })
      return
    }
    cart.addLine(defaultConfig(item, groups))
  }

  const place = useMutation({
    mutationFn: () => placeOrder(clientUuid, staff!.id, cart.orderType, cart.customerName, cart.lines),
    onSuccess: (res) => {
      setPlacedNumber(res.daily_number)
      cart.clear()
      setClientUuid(crypto.randomUUID())
      qc.invalidateQueries({ queryKey: ['orders'] })
      setTimeout(() => setPlacedNumber(null), 2500)
    },
    onError: (e) => toast.error(e.message),
  })

  const total = cartTotal(cart.lines)
  // НДС включён в цену — показываем справочно (18% по умолчанию, снапшот считает сервер)
  const vatIncluded = Math.round((total * 18) / 118)

  if (!staff) return null

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="sell" />

      {/* ── Каталог ─────────────────────────────────── */}
      <main className="flex-1 min-w-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-5 pb-0 shrink-0">
          <input
            className="w-full rounded-2xl border border-gray-100 bg-gray-50 px-5 py-3 text-sm
                       placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900/10
                       focus:bg-white transition-all"
            placeholder={t(lang, 'searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="flex gap-2 overflow-x-auto py-4">
            {hasFavorites && (
              <Chip active={!search && currentCat === 'fav'} onClick={() => { setSearch(''); setActiveCat('fav') }}>
                ★ {t(lang, 'favorites')}
              </Chip>
            )}
            <Chip active={!search && currentCat === 'all'} onClick={() => { setSearch(''); setActiveCat('all') }}>
              {t(lang, 'all')}
            </Chip>
            {categories.filter((c) => c.is_active).map((c) => (
              <Chip key={c.id} active={!search && currentCat === c.id} onClick={() => { setSearch(''); setActiveCat(c.id) }}>
                {c.name}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {visibleItems.length === 0 ? (
            <p className="text-gray-300 text-sm text-center pt-20">{t(lang, 'nothingFound')}</p>
          ) : (
            <div className="grid grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleItemTap(item)}
                  className="relative rounded-2xl border border-gray-100 p-3 text-start bg-white
                             hover:border-gray-200 hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)]
                             transition-all duration-150 active:scale-[0.97]"
                >
                  {item.is_favorite && (
                    <span className="absolute top-2.5 end-2.5 text-amber-400 text-sm drop-shadow-sm">★</span>
                  )}
                  <ItemImage item={item} size="card" />
                  <div className="mt-2.5 font-semibold text-gray-900 text-sm leading-tight">{item.name}</div>
                  <div className="mt-1 text-sm font-bold text-gray-500 tabular-nums">
                    {item.item_variants && item.item_variants.length > 0
                      ? formatMoney(Math.min(...item.item_variants.map((v) => v.price)), lang) + '+'
                      : formatMoney(item.price, lang)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* ── Заказ ───────────────────────────────────── */}
      <aside className="w-[340px] shrink-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="p-4 pb-3 shrink-0">
          <h2 className="text-lg font-black text-gray-900 mb-3">{t(lang, 'newOrderTitle')}</h2>
          <div className="grid grid-cols-2 gap-1 bg-gray-50 border border-gray-100 rounded-xl p-0.5 mb-2.5">
            {(['here', 'takeaway'] as const).map((tp) => (
              <button
                key={tp}
                onClick={() => cart.setOrderType(tp)}
                className={`py-2 rounded-lg text-sm font-semibold transition-all ${
                  cart.orderType === tp
                    ? 'bg-white text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {t(lang, tp)}
              </button>
            ))}
          </div>
          <input
            className="input !py-2"
            placeholder={t(lang, 'customerNameOpt')}
            value={cart.customerName}
            onChange={(e) => cart.setCustomerName(e.target.value)}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 space-y-2">
          {cart.lines.length === 0 && (
            <p className="text-gray-300 text-sm text-center pt-16">{t(lang, 'cartEmptyHint')}</p>
          )}
          {cart.lines.map((l) => {
            const item = items.find((i) => i.id === l.itemId)
            return (
              <div key={l.key} className="rounded-2xl border border-gray-100 p-3 animate-[rise-in_0.18s_ease-out]">
                <div className="flex items-start gap-2.5">
                  {item && <ItemImage item={item} size="line" />}
                  <button
                    className="text-start flex-1 min-w-0"
                    onClick={() => item && setPicker({ item, line: l })}
                  >
                    <span className="font-semibold text-gray-900 text-sm block leading-tight">
                      {l.name}
                      {l.variantName && <span className="text-gray-400 font-medium"> · {l.variantName}</span>}
                    </span>
                    {(l.mods.length > 0 || l.notes) && (
                      <span className="block text-xs text-gray-400 mt-0.5 truncate">
                        {[...l.mods.map((m) => m.name), l.notes].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </button>
                  <span className="font-bold text-sm text-gray-900 tabular-nums shrink-0">
                    {formatMoney(lineUnitPrice(l) * l.qty, lang)}
                  </span>
                </div>
                <div className="flex items-center gap-1 mt-2 ps-[50px]">
                  <Stepper onClick={() => cart.updateQty(l.key, l.qty - 1)}>−</Stepper>
                  <span className="w-8 text-center font-bold text-sm tabular-nums">{l.qty}</span>
                  <Stepper onClick={() => cart.updateQty(l.key, l.qty + 1)}>+</Stepper>
                  <button onClick={() => cart.removeLine(l.key)} className="ms-auto text-gray-300 hover:text-red-500 px-2">✕</button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="p-4 pt-3 shrink-0 border-t border-gray-100 space-y-1.5">
          <div className="flex justify-between text-sm text-gray-400">
            <span>{t(lang, 'subtotal')}</span>
            <span className="tabular-nums">{formatMoney(total, lang)}</span>
          </div>
          <div className="flex justify-between text-sm text-gray-400">
            <span>{t(lang, 'vatIncl')} 18%</span>
            <span className="tabular-nums">{formatMoney(vatIncluded, lang)}</span>
          </div>
          <div className="flex justify-between items-baseline pt-1">
            <span className="font-bold text-gray-900">{t(lang, 'total')}</span>
            <span className="text-2xl font-black text-gray-900 tabular-nums">{formatMoney(total, lang)}</span>
          </div>
          <button
            onClick={() => place.mutate()}
            disabled={cart.lines.length === 0 || place.isPending}
            className="btn-primary w-full !py-4 !text-base !rounded-2xl mt-2"
          >
            {place.isPending ? t(lang, 'charging') : t(lang, 'charge')}
            {cart.lines.length > 0 && <span className="tabular-nums ms-2">{formatMoney(total, lang)}</span>}
          </button>
        </div>
      </aside>

      {picker && (
        <ItemPicker
          item={picker.item}
          groups={itemGroups(picker.item)}
          line={picker.line}
          onClose={() => setPicker(null)}
          onConfirm={(cfg) => {
            if (picker.line) {
              cart.updateLine(picker.line.key, cfg)
            } else {
              cart.addLine({ itemId: picker.item.id, name: picker.item.name, ...cfg })
            }
            setPicker(null)
          }}
        />
      )}

      {placedNumber !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={() => setPlacedNumber(null)}>
          <div className="card px-16 py-12 text-center animate-[rise-in_0.25s_ease-out]">
            <div className="text-sm text-gray-400 mb-2">{t(lang, 'orderPlaced')}</div>
            <div className="text-6xl font-black text-gray-900 tabular-nums">#{placedNumber}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap transition-all active:scale-[0.96] ${
        active ? 'bg-gray-900 text-white' : 'bg-gray-50 border border-gray-100 text-gray-500 hover:border-gray-300'
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
      className="w-8 h-8 rounded-lg bg-gray-50 border border-gray-200 font-bold text-gray-600
                 hover:border-gray-400 active:scale-[0.9] transition-all"
    >
      {children}
    </button>
  )
}

