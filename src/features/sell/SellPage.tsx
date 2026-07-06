import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchCategories, fetchItems, fetchModifierGroups } from '../menu/api'
import { placeOrder, payOrder, type PaymentInput } from './api'
import { fetchCurrentShift } from '../shift/api'
import { useCartStore, cartTotal, lineUnitPrice, type CartLine, type CartMod } from '../../store/cartStore'
import { useAuthStore } from '../../store/authStore'
import { useLangStore } from '../../store/langStore'
import { t } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import type { MenuItem, ModifierGroup } from '../../types'
import ItemPicker from './ItemPicker'
import PaymentSheet from './PaymentSheet'
import ShiftGate from '../shift/ShiftGate'
import AppSidebar from '../../components/AppSidebar'
import ItemImage from '../../components/ItemImage'
import Icon from '../../components/Icon'

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

  const { data: shift, isLoading: shiftLoading } = useQuery({ queryKey: ['current_shift'], queryFn: fetchCurrentShift })
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
  // Заказ, ожидающий оплаты (после place, до pay).
  // intent: 'card' — оплатить сразу картой; 'cash'/'choose' — открыть диалог
  const [payingOrder, setPayingOrder] = useState<
    { orderId: string; dailyNumber: number; total: number; intent: 'cash' | 'card' | 'choose' } | null
  >(null)

  // Стартовая вкладка — первая категория по списку (иначе всё)
  const firstCat = categories.find((c) => c.is_active)?.id
  const currentCat = activeCat ?? firstCat ?? 'all'

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

  function finishPaid(num: number) {
    setPayingOrder(null)
    setPlacedNumber(num)
    cart.clear()
    setClientUuid(crypto.randomUUID())
    qc.invalidateQueries({ queryKey: ['orders'] })
    qc.invalidateQueries({ queryKey: ['current_shift'] })
    setTimeout(() => setPlacedNumber(null), 2500)
  }

  // Шаг 1: создать заказ. intent решает, что дальше:
  //   card   → сразу оплатить картой
  //   cash   → открыть диалог с расчётом сдачи
  //   choose → открыть диалог выбора способа
  const place = useMutation({
    mutationFn: (intent: 'cash' | 'card' | 'choose') =>
      placeOrder(clientUuid, staff!.id, cart.orderType, cart.customerName, cart.lines).then((r) => ({ ...r, intent })),
    onSuccess: (res) => {
      if (res.intent === 'card') {
        payWithClose({ orderId: res.order_id, dailyNumber: res.daily_number, payments: [{ method: 'card', amount: res.total }] })
      } else {
        setPayingOrder({ orderId: res.order_id, dailyNumber: res.daily_number, total: res.total, intent: res.intent })
      }
    },
    onError: (e) => toast.error(e.message),
  })

  // Шаг 2: принять оплату → показать номер, очистить корзину
  const pay = useMutation({
    mutationFn: (v: { orderId: string; dailyNumber: number; payments: PaymentInput[] }) =>
      payOrder(v.orderId, v.payments),
    onSuccess: (_r, v) => finishPaid(v.dailyNumber),
    onError: (e) => toast.error(e.message),
  })
  const payWithClose = (v: { orderId: string; dailyNumber: number; payments: PaymentInput[] }) => pay.mutate(v)

  const total = cartTotal(cart.lines)
  // НДС включён в цену — показываем справочно (18% по умолчанию, снапшот считает сервер)
  const vatIncluded = Math.round((total * 18) / 118)

  if (!staff) return null

  // Нет открытой смены — не пускаем к продажам
  if (!shiftLoading && !shift) {
    return <ShiftGate />
  }

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

        {/* Ряд действий (пока заглушки — функционал в следующих фазах) */}
        <div className="shrink-0 border-t border-gray-100 px-5 pt-3 pb-5 flex gap-2 overflow-x-auto">
          <ActionButton icon="customItem" label={t(lang, 'customItem')} lang={lang} />
          <ActionButton icon="discount" label={t(lang, 'discount')} lang={lang} />
          <ActionButton icon="note" label={t(lang, 'note')} lang={lang} />
          <ActionButton icon="refund" label={t(lang, 'refund')} lang={lang} />
        </div>
      </main>

      {/* ── Заказ ───────────────────────────────────── */}
      <aside className="w-[400px] shrink-0 bg-white rounded-3xl flex flex-col overflow-hidden">
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
                      {l.variantName && <span className="text-gray-500 font-medium"> · {l.variantName}</span>}
                    </span>
                    {(l.mods.length > 0 || l.notes) && (
                      <span className="block text-xs text-gray-500 mt-0.5 truncate">
                        {[...l.mods.map((m) => m.name), l.notes].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </button>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm text-gray-900 tabular-nums">
                        {formatMoney(lineUnitPrice(l) * l.qty, lang)}
                      </span>
                      <button onClick={() => cart.removeLine(l.key)} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-red-500">✕</button>
                    </div>
                    <div className="flex items-center gap-1">
                      <Stepper onClick={() => cart.updateQty(l.key, l.qty - 1)}>−</Stepper>
                      <span className="w-6 text-center font-bold text-sm tabular-nums">{l.qty}</span>
                      <Stepper onClick={() => cart.updateQty(l.key, l.qty + 1)}>+</Stepper>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="p-4 pt-3 shrink-0 border-t border-gray-100 space-y-1.5">
          <div className="flex justify-between text-sm text-gray-500">
            <span>{t(lang, 'vatIncl')} 18%</span>
            <span className="tabular-nums">{formatMoney(vatIncluded, lang)}</span>
          </div>
          <div className="flex justify-between items-baseline pt-1">
            <span className="font-bold text-gray-900">{t(lang, 'total')}</span>
            <span key={total} className="text-2xl font-black text-gray-900 tabular-nums inline-block cart-bump">
              {formatMoney(total, lang)}
            </span>
          </div>
          {(() => {
            const disabled = cart.lines.length === 0 || place.isPending || pay.isPending
            return (
              <>
                <button
                  onClick={() => place.mutate('choose')}
                  disabled={disabled}
                  className="btn-primary w-full !py-4 !text-base !rounded-2xl mt-2 flex items-center justify-between !px-5"
                >
                  <span>{place.isPending ? t(lang, 'charging') : t(lang, 'charge')}</span>
                  {cart.lines.length > 0 && <span className="tabular-nums">{formatMoney(total, lang)}</span>}
                </button>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button
                    onClick={() => place.mutate('cash')}
                    disabled={disabled}
                    className="btn-secondary min-h-[52px] !rounded-2xl flex items-center justify-center gap-2"
                  >
                    <Icon name="cash" size={18} /> {t(lang, 'payCash')}
                  </button>
                  <button
                    onClick={() => place.mutate('card')}
                    disabled={disabled}
                    className="btn-secondary min-h-[52px] !rounded-2xl flex items-center justify-center gap-2"
                  >
                    <Icon name="card" size={18} /> {t(lang, 'payCard')}
                  </button>
                </div>
              </>
            )
          })()}
        </div>
      </aside>

      {/* Оплата созданного заказа (наличные с расчётом сдачи или выбор способа) */}
      {payingOrder && (
        <PaymentSheet
          total={payingOrder.total}
          startMode={payingOrder.intent === 'cash' ? 'cash' : 'choose'}
          busy={pay.isPending}
          onCancel={() => setPayingOrder(null)}
          onPay={(payments) => pay.mutate({ orderId: payingOrder.orderId, dailyNumber: payingOrder.dailyNumber, payments })}
        />
      )}

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
          <div className="card px-16 py-12 text-center animate-[pop-in_0.35s_cubic-bezier(0.34,1.56,0.64,1)]">
            <div className="text-sm text-gray-500 mb-2">{t(lang, 'orderPlaced')}</div>
            <div className="text-7xl font-black text-gray-900 tabular-nums">#{placedNumber}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function ActionButton({ icon, label, lang }: { icon: 'customItem' | 'discount' | 'note' | 'refund'; label: string; lang: 'ru' | 'he' }) {
  return (
    <button
      onClick={() => toast(`${label} — ${t(lang, 'comingSoon')}`)}
      className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold
                 text-gray-900 hover:border-gray-400 transition-all whitespace-nowrap active:scale-[0.97]"
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-11 px-4 rounded-xl text-sm font-semibold whitespace-nowrap transition-all active:scale-[0.96] ${
        active ? 'bg-gray-200 text-gray-900' : 'text-gray-500 hover:bg-gray-100'
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
      className="w-11 h-11 rounded-xl bg-gray-50 border border-gray-200 text-base font-bold text-gray-600
                 flex items-center justify-center leading-none
                 hover:border-gray-400 active:scale-[0.9] transition-all"
    >
      {children}
    </button>
  )
}

