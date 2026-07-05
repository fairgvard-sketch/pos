import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchOrder, updateOrderCustomerName } from '../orders/api'
import { processPayment, processSplitPayment, createCardcomSession } from './api'
import { lookupGuest, applyPoints } from '../loyalty/api'
import { useLangStore } from '../../store/langStore'
import { useSettingsStore } from '../../store/settingsStore'
import HubButton from '../../components/ui/HubButton'
import { t } from '../../lib/i18n'
import { sendToPrinter } from '../../lib/printer'
import type { PaymentMethod, Order } from '../../types'
import type { Guest } from '../loyalty/api'
import type { BusinessInfo } from '../../store/settingsStore'
import type { Lang } from '../../lib/i18n'

type PayMode = 'cash' | 'card' | 'split'
type DiscountType = 'none' | 'percent' | 'fixed'

export default function PaymentPage() {
  const { orderId } = useParams<{ orderId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const lang = useLangStore((s) => s.lang)
  const business = useSettingsStore((s) => s.business)

  const [payMode, setPayMode] = useState<PayMode>('card')
  const [splitCount, setSplitCount] = useState(2)
  const [splitMethods, setSplitMethods] = useState<PaymentMethod[]>(Array(10).fill('card'))
  const [cardcomPending, setCardcomPending] = useState(false)

  // Discount
  const [discountType, setDiscountType] = useState<DiscountType>('none')
  const [discountValue, setDiscountValue] = useState('')

  // Customer name on receipt
  const [customerName, setCustomerName] = useState('')

  // Loyalty
  const [phoneInput, setPhoneInput] = useState('')
  const [guest, setGuest] = useState<Guest | null>(null)
  const [pointsToUse, setPointsToUse] = useState(0)
  const [guestTab, setGuestTab] = useState(false)

  const { data: order, isLoading } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => fetchOrder(orderId!),
    enabled: !!orderId,
  })

  // Sync customer name from order on first load
  useEffect(() => { if (order?.customer_name) setCustomerName(order.customer_name) }, [order?.id])

  // Computed totals
  const subtotal = order?.total ?? 0
  const discountAmount = (() => {
    const v = parseFloat(discountValue) || 0
    if (discountType === 'percent') return Math.min(subtotal, subtotal * v / 100)
    if (discountType === 'fixed') return Math.min(subtotal, v)
    return 0
  })()
  const afterDiscount = subtotal - discountAmount
  const pointsUsable = guest ? Math.min(guest.points, Math.floor(afterDiscount), Math.floor(afterDiscount)) : 0
  const finalTotal = Math.max(0, afterDiscount - pointsToUse)
  const perPerson = payMode === 'split' ? (finalTotal / splitCount) : 0

  const lookupMutation = useMutation({
    mutationFn: () => lookupGuest(phoneInput.trim()),
    onSuccess: (data) => {
      if (data) {
        setGuest(data)
        toast.success(`${data.name} — ${data.points} баллов`)
      } else {
        toast.error('Гость не найден')
      }
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const payMutation = useMutation({
    mutationFn: async () => {
      if (!order) throw new Error(t(lang, 'orderNotFound'))

      // Save customer name if provided
      if (customerName.trim()) {
        await updateOrderCustomerName(order.id, customerName.trim())
      }

      if (payMode === 'split') {
        await processSplitPayment(
          order.id,
          order.table_id,
          splitMethods.slice(0, splitCount).map((m) => ({ method: m, amount: perPerson }))
        )
      } else {
        await processPayment(order.id, order.table_id, payMode, finalTotal)
      }

      // Apply loyalty points
      if (guest && pointsToUse > 0) {
        await applyPoints(guest.id, order.id, pointsToUse, Math.floor(finalTotal))
      } else if (guest) {
        await applyPoints(guest.id, order.id, 0, Math.floor(finalTotal))
      }

      // Print receipt
      sendToPrinter({
        type: 'receipt',
        order: {
          id: order.id,
          table_number: order.table?.number ?? 0,
          waiter_name: order.waiter?.name ?? '',
          created_at: order.created_at,
          total: subtotal,
          customer_name: customerName.trim() || undefined,
          items: (order.order_items ?? []).map((oi) => ({
            name: oi.menu_item?.name ?? '',
            qty: oi.qty,
            price: oi.price,
            notes: oi.notes ?? undefined,
          })),
        },
        discount: discountType !== 'none' && discountAmount > 0
          ? { type: discountType, value: parseFloat(discountValue) || 0 }
          : undefined,
        guest_info: guest
          ? { name: guest.name, points: guest.points, points_used: pointsToUse }
          : undefined,
        business: {
          name: business.name || undefined,
          address: business.address || undefined,
          businessId: business.businessId || undefined,
          vatRate: business.vatRate,
        },
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tables'] })
      qc.invalidateQueries({ queryKey: ['kitchen-orders'] })
      toast.success(t(lang, 'paymentAccepted'))
      navigate('/tables')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const isRtl = lang === 'he'

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">{t(lang, 'orderNotFound')}</p>
      </div>
    )
  }

  // Group items by guest number (seat-based)
  const guestGroups = new Map<number, typeof order.order_items>()
  for (const item of order.order_items ?? []) {
    const g = (item as any).guest ?? 0
    if (!guestGroups.has(g)) guestGroups.set(g, [])
    guestGroups.get(g)!.push(item)
  }
  const hasSeatGroups = guestGroups.size > 1 || (guestGroups.size === 1 && !guestGroups.has(0))

  return (
    <div className="min-h-screen bg-gray-50" dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
        <HubButton />
        <button onClick={() => navigate(-1)} className="p-2 rounded-xl hover:bg-gray-100">
          {isRtl ? '→' : '←'}
        </button>
        <div className="flex-1">
          <h1 className="font-bold text-gray-900">{t(lang, 'payment')}</h1>
          <p className="text-xs text-gray-500">{t(lang, 'table')} {order.table?.number}</p>
        </div>
      </header>

      <div className="max-w-2xl mx-auto p-6 flex flex-col gap-5">
        {/* Receipt preview — matches thermal print layout */}
        <ReceiptPreview
          order={order}
          subtotal={subtotal}
          discountAmount={discountAmount}
          discountType={discountType}
          discountValue={discountValue}
          pointsToUse={pointsToUse}
          finalTotal={finalTotal}
          customerName={customerName}
          business={business}
          lang={lang}
          hasSeatGroups={hasSeatGroups}
          guestGroups={guestGroups}
        />

        {/* Customer name */}
        <div className="card p-4">
          <h2 className="font-bold text-gray-900 mb-3">{t(lang, 'customerName')}</h2>
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            onBlur={() => { if (customerName.trim()) updateOrderCustomerName(order.id, customerName.trim()) }}
            placeholder={t(lang, 'customerNamePlaceholder')}
            className="input text-sm"
          />
        </div>

        {/* Discount */}
        <div className="card p-4">
          <h2 className="font-bold text-gray-900 mb-3">Скидка</h2>
          <div className="flex gap-2 mb-3">
            {(['none', 'percent', 'fixed'] as DiscountType[]).map((dt) => (
              <button
                key={dt}
                onClick={() => { setDiscountType(dt); setDiscountValue('') }}
                className={`flex-1 py-2 rounded-xl text-sm font-medium border-2 transition-all ${
                  discountType === dt
                    ? 'border-green-600 bg-green-50 text-green-700'
                    : 'border-gray-200 text-gray-600'
                }`}
              >
                {dt === 'none' ? 'Нет' : dt === 'percent' ? '%' : '₪'}
              </button>
            ))}
          </div>
          {discountType !== 'none' && (
            <input
              type="number"
              min={0}
              max={discountType === 'percent' ? 100 : subtotal}
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              placeholder={discountType === 'percent' ? 'Процент...' : 'Сумма ₪...'}
              className="input text-sm"
            />
          )}
        </div>

        {/* Loyalty */}
        <div className="card p-4">
          <button
            onClick={() => setGuestTab(!guestTab)}
            className="w-full flex items-center justify-between font-bold text-gray-900"
          >
            <span>Карта гостя</span>
            <span className="text-gray-400 text-sm">{guestTab ? '▲' : '▼'}</span>
          </button>

          {guestTab && (
            <div className="mt-3 space-y-3">
              <div className="flex gap-2">
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="Телефон гостя..."
                  className="input flex-1 text-sm"
                />
                <button
                  onClick={() => lookupMutation.mutate()}
                  disabled={lookupMutation.isPending || !phoneInput.trim()}
                  className="btn-secondary text-sm px-4"
                >
                  Найти
                </button>
              </div>

              {guest && (
                <div className="bg-purple-50 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="font-bold text-purple-900">{guest.name}</p>
                      <p className="text-xs text-purple-600">{guest.phone} · {guest.visits} визитов</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-black text-purple-700">{guest.points}</p>
                      <p className="text-xs text-purple-500">баллов</p>
                    </div>
                  </div>

                  {pointsUsable >= 100 && (
                    <div>
                      <label className="text-xs text-purple-700 font-medium block mb-1">
                        Списать баллов (мин. 100, доступно {pointsUsable}):
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0}
                          max={pointsUsable}
                          step={10}
                          value={pointsToUse}
                          onChange={(e) => setPointsToUse(Number(e.target.value))}
                          className="flex-1"
                        />
                        <span className="text-sm font-bold text-purple-700 w-16 text-right">
                          {pointsToUse} б.
                        </span>
                      </div>
                      {pointsToUse > 0 && pointsToUse < 100 && (
                        <p className="text-xs text-red-500 mt-1">Минимум 100 баллов</p>
                      )}
                    </div>
                  )}

                  {pointsUsable < 100 && (
                    <p className="text-xs text-purple-500">
                      Нужно минимум 100 баллов для списания
                    </p>
                  )}

                  <p className="text-xs text-gray-500 mt-2">
                    Начислится: +{Math.floor(finalTotal)} баллов
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Payment method */}
        <div className="card p-5">
          <h2 className="font-bold text-gray-900 mb-4">{t(lang, 'paymentMethod')}</h2>

          <div className="grid grid-cols-3 gap-3 mb-4">
            {(['cash', 'card', 'split'] as PayMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setPayMode(m)}
                className={`py-3 rounded-xl font-semibold text-sm transition-all border-2 ${
                  payMode === m
                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                {t(lang, m as 'cash' | 'card' | 'split')}
              </button>
            ))}
          </div>

          {payMode === 'split' && (
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-sm text-gray-600">{t(lang, 'guestCount')}</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSplitCount((n) => Math.max(2, n - 1))}
                    className="w-8 h-8 rounded-lg bg-white border border-gray-200 font-bold hover:bg-gray-100"
                  >−</button>
                  <span className="w-8 text-center font-bold">{splitCount}</span>
                  <button
                    onClick={() => setSplitCount((n) => Math.min(10, n + 1))}
                    className="w-8 h-8 rounded-lg bg-white border border-gray-200 font-bold hover:bg-gray-100"
                  >+</button>
                </div>
                <span className="ml-auto text-sm font-bold text-blue-700">
                  {perPerson.toFixed(2)} ₪ {t(lang, 'perPerson')}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {Array.from({ length: splitCount }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">{t(lang, 'guest')} {i + 1}</span>
                    <div className="flex gap-2">
                      {(['cash', 'card'] as PaymentMethod[]).map((m) => (
                        <button
                          key={m}
                          onClick={() =>
                            setSplitMethods((prev) => prev.map((v, idx) => (idx === i ? m : v)))
                          }
                          className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                            splitMethods[i] === m
                              ? 'bg-blue-600 text-white'
                              : 'bg-white border border-gray-200 text-gray-600'
                          }`}
                        >
                          {m === 'cash' ? '💵' : '💳'} {t(lang, m === 'cash' ? 'cash_short' : 'card_short')}
                        </button>
                      ))}
                    </div>
                    <span className="text-sm font-bold w-20 text-right">{perPerson.toFixed(2)} ₪</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Cardcom online payment */}
        <button
          disabled={cardcomPending}
          onClick={async () => {
            if (!order) return
            setCardcomPending(true)
            try {
              const origin = window.location.origin
              const session = await createCardcomSession(
                order.id,
                finalTotal,
                `${origin}/payment/${order.id}?cardcom=success`,
                `${origin}/payment/${order.id}?cardcom=cancel`
              )
              window.location.href = session.url
            } catch (e: any) {
              toast.error(`Cardcom: ${e.message}`)
            } finally {
              setCardcomPending(false)
            }
          }}
          className="w-full py-3 rounded-xl font-bold text-sm border-2 border-indigo-400 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-all disabled:opacity-50"
        >
          {cardcomPending ? 'Подключение...' : `💳 Оплатить через Cardcom ${finalTotal.toFixed(2)} ₪`}
        </button>

        <div className="flex gap-3">
          <button
            onClick={() => {
              sendToPrinter({
                type: 'receipt',
                order: {
                  id: order.id,
                  table_number: order.table?.number ?? 0,
                  waiter_name: order.waiter?.name ?? '',
                  created_at: order.created_at,
                  total: subtotal,
                  items: (order.order_items ?? []).map((oi) => ({
                    name: oi.menu_item?.name ?? '',
                    qty: oi.qty,
                    price: oi.price,
                    notes: oi.notes ?? undefined,
                  })),
                },
                discount: discountType !== 'none' && discountAmount > 0
                  ? { type: discountType, value: parseFloat(discountValue) || 0 }
                  : undefined,
                guest_info: guest
                  ? { name: guest.name, points: guest.points, points_used: pointsToUse }
                  : undefined,
                business: {
                  name: business.name || undefined,
                  address: business.address || undefined,
                  businessId: business.businessId || undefined,
                  vatRate: business.vatRate,
                },
              }).then((ok) => { if (!ok) window.print() })
            }}
            className="btn-secondary flex-1"
          >
            {t(lang, 'print')}
          </button>
          <button
            onClick={() => payMutation.mutate()}
            disabled={payMutation.isPending || (pointsToUse > 0 && pointsToUse < 100)}
            className="btn-success flex-[2]"
          >
            {payMutation.isPending
              ? t(lang, 'processingPayment')
              : `${t(lang, 'acceptPayment')} ${finalTotal.toFixed(2)} ₪`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Receipt preview component ─────────────────────────────────
interface ReceiptPreviewProps {
  order: Order
  subtotal: number
  discountAmount: number
  discountType: 'none' | 'percent' | 'fixed'
  discountValue: string
  pointsToUse: number
  finalTotal: number
  customerName: string
  business: BusinessInfo
  lang: Lang
  hasSeatGroups: boolean
  guestGroups: Map<number, Order['order_items']>
}

function ReceiptPreview({
  order, subtotal, discountAmount, discountType, discountValue,
  pointsToUse, finalTotal, customerName, business, hasSeatGroups, guestGroups,
}: ReceiptPreviewProps) {
  const vatRate = business.vatRate || 18
  const vatFactor = vatRate / 100
  const netAmount = finalTotal / (1 + vatFactor)
  const vatAmount = finalTotal - netAmount

  const receiptDate = (() => {
    const d = new Date()
    const hh  = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    const dd  = String(d.getDate()).padStart(2, '0')
    const mm  = String(d.getMonth() + 1).padStart(2, '0')
    return `${hh}:${min} ${dd}/${mm}/${d.getFullYear()}`
  })()

  return (
    <div
      className="receipt-print bg-white border border-gray-200 rounded-2xl overflow-hidden"
      style={{ fontFamily: 'monospace', direction: 'rtl' }}
    >
      {/* Inner receipt — narrow like 80mm paper */}
      <div className="mx-auto py-5 px-6" style={{ maxWidth: 340 }}>

        {/* ── Business header ── */}
        <div className="text-center mb-3">
          {business.name && (
            <p className="font-black text-base">{business.name}</p>
          )}
          {business.address && (
            <p className="text-xs text-gray-600">{business.address}</p>
          )}
          {business.businessId && (
            <p className="text-xs text-gray-500">ח.פ: {business.businessId}</p>
          )}
        </div>

        <div className="border-t border-dashed border-gray-300 mb-3" />

        {/* ── Order meta ── */}
        <div className="text-xs text-gray-600 mb-3 space-y-0.5">
          <div className="flex justify-between">
            <span>תאריך</span>
            <span dir="ltr">{receiptDate}</span>
          </div>
          <div className="flex justify-between">
            <span>קופא</span>
            <span>{order.waiter?.name}</span>
          </div>
          <div className="flex justify-between">
            <span>ללפק</span>
            <span>{order.table?.number}</span>
          </div>
          {customerName.trim() && (
            <div className="flex justify-between">
              <span>לקוח</span>
              <span className="font-semibold">{customerName.trim()}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>מספר</span>
            <span dir="ltr">#{order.id.slice(0, 8).toUpperCase()}</span>
          </div>
        </div>

        <div className="border-t border-dashed border-gray-300 mb-2" />

        {/* ── Column headers ── */}
        <div className="grid text-[10px] font-bold text-gray-500 mb-1" style={{ gridTemplateColumns: '1fr 52px 36px 52px' }}>
          <span>שם</span>
          <span className="text-center">מחיר</span>
          <span className="text-center">כמות</span>
          <span className="text-left">לתשלום</span>
        </div>

        <div className="border-t border-gray-300 mb-2" />

        {/* ── Items ── */}
        {hasSeatGroups
          ? Array.from(guestGroups.entries())
              .sort(([a], [b]) => a - b)
              .map(([guestNum, items]) => (
                <div key={guestNum} className="mb-2">
                  <p className="text-[10px] font-bold text-gray-400 mb-1">
                    {guestNum === 0 ? '— כללי —' : `אורח ${guestNum}`}
                  </p>
                  {items!.map((item) => (
                    <ReceiptRow key={item.id} name={item.menu_item?.name ?? ''} price={item.price} qty={item.qty} />
                  ))}
                </div>
              ))
          : (order.order_items ?? []).map((item) => (
              <ReceiptRow key={item.id} name={item.menu_item?.name ?? ''} price={item.price} qty={item.qty} />
            ))
        }

        <div className="border-t border-dashed border-gray-300 mt-2 mb-2" />

        {/* ── Subtotals ── */}
        <div className="space-y-0.5 text-xs mb-2">
          {discountAmount > 0 && (
            <div className="flex justify-between text-gray-600">
              <span>סה"כ לפני הנחה</span>
              <span dir="ltr">{subtotal.toFixed(2)}</span>
            </div>
          )}
          {discountAmount > 0 && (
            <div className="flex justify-between text-gray-600">
              <span>הנחה {discountType === 'percent' ? `${discountValue}%` : '₪'}</span>
              <span dir="ltr">-{discountAmount.toFixed(2)}</span>
            </div>
          )}
          {pointsToUse > 0 && (
            <div className="flex justify-between text-gray-600">
              <span>נקודות ({pointsToUse})</span>
              <span dir="ltr">-{pointsToUse.toFixed(2)}</span>
            </div>
          )}
          <div className="flex justify-between text-gray-600">
            <span>מע"מ {vatRate}.0%</span>
            <span dir="ltr">{vatAmount.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>סה"כ ללא מע"מ</span>
            <span dir="ltr">{netAmount.toFixed(2)}</span>
          </div>
        </div>

        <div className="border-t border-gray-900 mb-2" />

        {/* ── Grand total ── */}
        <div className="flex justify-between items-baseline">
          <span className="font-bold text-sm">:לתשלום</span>
          <span className="font-black text-xl" dir="ltr">{finalTotal.toFixed(2)} ₪</span>
        </div>

        <div className="border-t border-dashed border-gray-300 mt-3 mb-3" />

        {/* ── Footer ── */}
        <div className="text-center text-xs text-gray-500 space-y-0.5">
          <p>!תודה שקביתם אצלנו</p>
          <p>תתראו אותנו יום מקסימא</p>
        </div>
      </div>
    </div>
  )
}

function ReceiptRow({ name, price, qty }: { name: string; price: number; qty: number }) {
  const total = price * qty
  return (
    <div className="grid text-xs py-0.5" style={{ gridTemplateColumns: '1fr 52px 36px 52px' }}>
      <span className="truncate">{name}</span>
      <span className="text-center tabular-nums" dir="ltr">{price.toFixed(2)}</span>
      <span className="text-center tabular-nums">{qty}</span>
      <span className="text-left tabular-nums font-medium" dir="ltr">{total.toFixed(2)}</span>
    </div>
  )
}
