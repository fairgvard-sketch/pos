import { useState } from 'react'
import { useOrderStore } from '../../store/orderStore'
import { t } from '../../lib/i18n'
import type { Order, OrderItem, Table } from '../../types'
import type { Lang } from '../../lib/i18n'
import ModifierModal from '../menu/ModifierModal'
import { cartItemEffectivePrice } from '../../store/orderStore'
import { useSettingsStore } from '../../store/settingsStore'
import ConfirmDialog from '../../components/ui/ConfirmDialog'

function calcItemTotal(c: import('../../store/orderStore').CartItem): number {
  return cartItemEffectivePrice(c) * c.qty
}

interface Props {
  tableId: string
  activeOrder: Order | null
  lang: Lang
  onSave: () => void
  onSendToKitchen: () => void
  onRequestBill?: () => void
  isSaving: boolean
  isSending: boolean
  isRequestingBill?: boolean
  onVoidItem?: (itemId: string) => void
  isVoiding?: boolean
  onUpdateItemQty?: (itemId: string, qty: number) => void
  onUpdateItemNotes?: (itemId: string, notes: string) => void
  onUpdateItem?: (itemId: string, updates: { price?: number; notes?: string; modifierIds?: string[] }) => void
  onUpdateCustomerName?: (name: string) => void
  onMoveItems?: (itemIds: string[], toTableId: string) => Promise<void>
  tables?: Table[]
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-gray-400',
  cooking: 'text-amber-500',
  ready:   'text-emerald-500',
  served:  'text-gray-300',
}

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-gray-300',
  cooking: 'bg-amber-400',
  ready:   'bg-emerald-400',
  served:  'bg-gray-200',
}

type ItemAction = 'price' | 'discountPct' | 'discountAbs'

function Numpad({ label, value, placeholder, onConfirm, onCancel }: {
  label: string
  value: string
  placeholder?: string
  onConfirm: (val: string) => void
  onCancel: () => void
}) {
  const [v, setV] = useState(value)

  const press = (key: string) => {
    if (key === '⌫') { setV((s) => s.slice(0, -1)); return }
    if (key === 'C') { setV(''); return }
    if (key === '.' && v.includes('.')) return
    if (v === '0' && key !== '.') { setV(key); return }
    setV((s) => s + key)
  }

  // Row layout: [C, empty, ⌫] / [1,2,3] / [4,5,6] / [7,8,9] / [., 0, OK]
  const rows: (string | null)[][] = [
    ['C', null, '⌫'],
    ['1', '2',  '3'],
    ['4', '5',  '6'],
    ['7', '8',  '9'],
    ['.', '0',  'OK'],
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        className="bg-white rounded-2xl w-full max-w-sm p-4 pb-6 mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-gray-500">{label}</span>
          <button onClick={onCancel} className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="bg-gray-50 rounded-xl px-4 py-3 text-right text-2xl font-bold text-gray-900 tabular-nums mb-4 min-h-[52px]">
          {v || <span className="text-gray-300">{placeholder ?? '0'}</span>}
        </div>

        <div className="flex flex-col gap-2">
          {rows.map((row, ri) => (
            <div key={ri} className="grid grid-cols-3 gap-2">
              {row.map((k, ci) => {
                if (k === null) return <div key={ci} />
                if (k === 'OK') return (
                  <button
                    key="OK"
                    onClick={() => onConfirm(v)}
                    className="h-14 rounded-xl bg-gray-900 text-white text-lg font-bold active:scale-95 transition-all hover:bg-gray-800"
                  >
                    OK
                  </button>
                )
                return (
                  <button
                    key={k}
                    onClick={() => press(k)}
                    className={`h-14 rounded-xl text-xl font-semibold transition-all active:scale-95 ${
                      k === '⌫' ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' :
                      k === 'C'  ? 'bg-red-50 text-red-500 hover:bg-red-100' :
                                   'bg-gray-50 text-gray-900 hover:bg-gray-100'
                    }`}
                  >
                    {k}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function CartPanel({ activeOrder, lang, onSave, onSendToKitchen, onRequestBill, isSaving, isSending, isRequestingBill, onVoidItem, isVoiding, onUpdateItemQty, onUpdateItemNotes, onUpdateItem, onUpdateCustomerName, onMoveItems, tables }: Props) {
  const { cart, guestCount, setGuestCount, updateQty, removeFromCart, updateNotes, updateGuest, updateModifiers, updatePrice, updateDiscount } = useOrderStore()
  const cartItemActions = useSettingsStore((s) => s.cartItemActions)
  const isRetail = useSettingsStore((s) => s.venueType === 'retail')
  const [editNoteKey, setEditNoteKey] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [editingCartKey, setEditingCartKey] = useState<string | null>(null)
  const [editOrderNoteId, setEditOrderNoteId] = useState<string | null>(null)
  const [orderNoteText, setOrderNoteText] = useState('')
  const [editingOrderItem, setEditingOrderItem] = useState<OrderItem | null>(null)
  const [customerName, setCustomerName] = useState(activeOrder?.customer_name ?? '')
  const [editingName, setEditingName] = useState(false)
  const [moveMode, setMoveMode] = useState(false)
  const [moveSelected, setMoveSelected] = useState<Set<string>>(new Set())
  const [moveTableModal, setMoveTableModal] = useState(false)
  const [isMoving, setIsMoving] = useState(false)
  const [selectedCartKey, setSelectedCartKey] = useState<string | null>(null)
  const [activeAction, setActiveAction] = useState<ItemAction | null>(null)
  const [actionInput, setActionInput] = useState('')
  const [selectedOrderItemId, setSelectedOrderItemId] = useState<string | null>(null)
  const [orderItemAction, setOrderItemAction] = useState<ItemAction | null>(null)
  const [orderItemInput, setOrderItemInput] = useState('')
  const [numpadOpen, setNumpadOpen] = useState<'cart' | 'order' | null>(null)
  const [confirmVoidItem, setConfirmVoidItem] = useState<OrderItem | null>(null)

  const editingItem = editingCartKey ? cart.find((c) => c.cartKey === editingCartKey) : null
  const selectedItem = selectedCartKey ? cart.find((c) => c.cartKey === selectedCartKey) : null

  function selectItem(cartKey: string) {
    if (selectedCartKey === cartKey) {
      setSelectedCartKey(null)
      setActiveAction(null)
    } else {
      setSelectedCartKey(cartKey)
      setActiveAction(null)
      setSelectedOrderItemId(null)
    }
  }

  function selectOrderItem(id: string) {
    if (selectedOrderItemId === id) {
      setSelectedOrderItemId(null)
      setOrderItemAction(null)
    } else {
      setSelectedOrderItemId(id)
      setOrderItemAction(null)
      setSelectedCartKey(null)
    }
  }

  function openOrderItemAction(action: ItemAction, item: OrderItem) {
    setOrderItemAction(action)
    if (action === 'price') setOrderItemInput((item.price).toFixed(0))
    else setOrderItemInput('')
  }

  function applyOrderItemAction(item: OrderItem, rawVal?: string) {
    if (!orderItemAction || !onUpdateItem) return
    const val = parseFloat(rawVal ?? orderItemInput)
    if (isNaN(val) || val < 0) return
    const origPrice = item.menu_item?.price ?? item.price
    let newPrice: number
    if (orderItemAction === 'price') newPrice = val
    else if (orderItemAction === 'discountPct') newPrice = origPrice * (1 - Math.min(100, val) / 100)
    else newPrice = Math.max(0, origPrice - val)
    onUpdateItem(item.id, { price: newPrice })
    setOrderItemAction(null)
    setOrderItemInput('')
    setSelectedOrderItemId(null)
  }

  function openAction(action: ItemAction) {
    if (!selectedItem) return
    setActiveAction(action)
    if (action === 'price') setActionInput((selectedItem.overridePrice ?? selectedItem.menu_item.price + selectedItem.extraPrice).toFixed(0))
    else if (action === 'discountPct') setActionInput(selectedItem.discountPct > 0 ? selectedItem.discountPct.toString() : '')
    else if (action === 'discountAbs') setActionInput(selectedItem.discountAbs > 0 ? selectedItem.discountAbs.toFixed(0) : '')
  }

  function applyAction(rawVal?: string) {
    if (!selectedItem || !activeAction) return
    const val = parseFloat(rawVal ?? actionInput)
    if (isNaN(val) || val < 0) return
    if (activeAction === 'price') {
      updatePrice(selectedItem.cartKey, val)
      updateDiscount(selectedItem.cartKey, 0, 0)
    } else if (activeAction === 'discountPct') {
      updateDiscount(selectedItem.cartKey, Math.min(100, val), 0)
      updatePrice(selectedItem.cartKey, null)
    } else if (activeAction === 'discountAbs') {
      updateDiscount(selectedItem.cartKey, 0, val)
      updatePrice(selectedItem.cartKey, null)
    }
    setActiveAction(null)
    setActionInput('')
  }

  function resetItemPrice(cartKey: string) {
    updatePrice(cartKey, null)
    updateDiscount(cartKey, 0, 0)
  }

  const hasAnyCartAction = cartItemActions.price || cartItemActions.discountPct || cartItemActions.discountAbs || cartItemActions.modifiers

  const cartTotal = cart.reduce((sum, c) => sum + calcItemTotal(c), 0)
  const existingTotal = activeOrder?.total ?? 0
  const grandTotal = cartTotal + existingTotal

  const STATUS_LABEL: Record<string, string> = {
    pending: t(lang, 'pending'),
    cooking: t(lang, 'cooking'),
    ready:   t(lang, 'ready'),
    served:  t(lang, 'served'),
  }

  const allItems = [
    ...(activeOrder?.order_items ?? []).map((oi) => ({ type: 'saved' as const, item: oi })),
    ...cart.map((c) => ({ type: 'new' as const, item: c })),
  ]

  const isEmpty = allItems.length === 0

  return (
    <div className="w-[360px] bg-white border-l border-gray-100 flex flex-col relative shrink-0">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100">
        {/* Top row: order info + guests */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            <h2 className="font-bold text-gray-900 text-base leading-none">{t(lang, 'order')}</h2>
            {activeOrder && (
              <p className="text-xs text-gray-400 mt-1">#{activeOrder.id.slice(0, 8).toUpperCase()}</p>
            )}
          </div>

          {/* Guest count */}
          <div className="flex items-center gap-1 bg-gray-50 rounded-xl px-2 py-1.5">
            <svg className="w-3.5 h-3.5 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
            </svg>
            <button
              onClick={() => setGuestCount(Math.max(1, guestCount - 1))}
              className="w-5 h-5 rounded-lg bg-white shadow-sm hover:bg-gray-100 text-xs font-bold text-gray-600 flex items-center justify-center transition-colors"
            >−</button>
            <span className="text-sm font-bold text-gray-800 w-5 text-center tabular-nums">{guestCount}</span>
            <button
              onClick={() => setGuestCount(Math.min(10, guestCount + 1))}
              className="w-5 h-5 rounded-lg bg-white shadow-sm hover:bg-gray-100 text-xs font-bold text-gray-600 flex items-center justify-center transition-colors"
            >+</button>
          </div>
        </div>

        {/* Customer name */}
        {editingName ? (
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder={t(lang, 'customerNamePlaceholder')}
              className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-900/10 bg-gray-50"
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onUpdateCustomerName?.(customerName); setEditingName(false) }
                if (e.key === 'Escape') setEditingName(false)
              }}
            />
            <button
              onClick={() => { onUpdateCustomerName?.(customerName); setEditingName(false) }}
              className="text-sm text-gray-700 font-semibold px-3 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors"
            >OK</button>
          </div>
        ) : (
          <button
            onClick={() => setEditingName(true)}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors w-full"
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            {customerName
              ? <span className="text-gray-800 font-medium">{customerName}</span>
              : <span>{t(lang, 'customerName')}</span>}
          </button>
        )}
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto">
        {isEmpty && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-300">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <p className="text-sm">{t(lang, 'selectDishes')}</p>
          </div>
        )}

        {/* Saved order items */}
        {activeOrder?.order_items && activeOrder.order_items.length > 0 && (
          <div className="px-4 pt-3">
            {cart.length > 0 && (
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">
                {t(lang, 'alreadyInOrder')}
              </p>
            )}
            {activeOrder.order_items.map((item) => {
              const isOrdSelected = selectedOrderItemId === item.id
              const origPrice = item.menu_item?.price ?? item.price
              const isPriceModified = item.price !== origPrice
              return (
                <div
                  key={item.id}
                  className={`py-2.5 border-b border-gray-50 last:border-0 rounded-xl transition-all ${isOrdSelected ? 'bg-gray-50 px-2 -mx-2' : ''}`}
                >
                  <div
                    className={`flex flex-col gap-1 ${moveMode ? 'cursor-pointer' : item.status !== 'served' && onUpdateItem ? 'cursor-pointer' : ''}`}
                    onClick={() => {
                      if (moveMode) {
                        setMoveSelected((prev) => {
                          const next = new Set(prev)
                          next.has(item.id) ? next.delete(item.id) : next.add(item.id)
                          return next
                        })
                      } else {
                        item.status !== 'served' && onUpdateItem && selectOrderItem(item.id)
                      }
                    }}
                  >
                    {/* Row 1: dot + name */}
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`shrink-0 w-2 h-2 rounded-full ${STATUS_DOT[item.status] ?? 'bg-gray-200'}`} />
                      {moveMode && (
                        <div className={`shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${moveSelected.has(item.id) ? 'bg-gray-900 border-gray-900' : 'border-gray-300'}`}>
                          {moveSelected.has(item.id) && <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M1.5 5l2.5 2.5 4.5-4"/></svg>}
                        </div>
                      )}
                      <p className="text-sm text-gray-800 font-medium leading-snug flex-1 min-w-0 break-words">
                        {item.menu_item?.name}
                      </p>
                    </div>

                    {/* Row 2: status + qty controls + price + void */}
                    <div className="flex items-center gap-1.5 ps-4">
                      {item.status !== 'pending' && (
                        <span className={`text-[10px] font-semibold ${STATUS_COLOR[item.status] ?? 'text-gray-400'}`}>
                          {STATUS_LABEL[item.status] ?? item.status}
                        </span>
                      )}
                      <div className="flex-1" />
                      {onUpdateItemQty && item.status === 'pending' ? (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); onUpdateItemQty(item.id, item.qty - 1) }}
                            className="w-7 h-7 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm font-bold text-gray-600 flex items-center justify-center transition-colors active:scale-[0.93]"
                          >−</button>
                          <span className="text-sm font-bold text-gray-800 w-5 text-center tabular-nums">{item.qty}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); onUpdateItemQty(item.id, item.qty + 1) }}
                            className="w-7 h-7 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm font-bold text-gray-600 flex items-center justify-center transition-colors active:scale-[0.93]"
                          >+</button>
                        </>
                      ) : (
                        <span className="text-sm text-gray-500 font-medium">{item.qty}×</span>
                      )}
                      <div className="w-12 text-right shrink-0">
                        {isPriceModified ? (
                          <div>
                            <span className="text-sm font-bold text-emerald-600">{(item.price * item.qty).toFixed(0)} ₪</span>
                            <span className="block text-[9px] text-gray-300 line-through leading-none">{(origPrice * item.qty).toFixed(0)}</span>
                          </div>
                        ) : (
                          <span className="text-sm font-bold text-gray-700">{(item.price * item.qty).toFixed(0)} ₪</span>
                        )}
                      </div>
                      {onVoidItem && item.status !== 'served' && (
                        <button
                          disabled={isVoiding}
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmVoidItem(item)
                          }}
                          className="w-7 h-7 text-gray-300 hover:text-red-400 flex items-center justify-center text-base leading-none transition-colors active:scale-[0.93]"
                          title={t(lang, 'voidItem')}
                        >×</button>
                      )}
                    </div>
                  </div>

                  {/* Quick action panel for saved order items */}
                  {isOrdSelected && onUpdateItem && (
                    <div className="mt-2 ms-4">
                      {orderItemAction === null ? (
                        <div className="flex flex-wrap gap-1.5">
                          {cartItemActions.price && (
                            <button
                              onClick={() => openOrderItemAction('price', item)}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 hover:border-gray-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'שנה מחיר' : 'Цена'}
                            </button>
                          )}
                          {cartItemActions.discountPct && (
                            <button
                              onClick={() => openOrderItemAction('discountPct', item)}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 hover:border-gray-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'הנחה %' : 'Скидка %'}
                            </button>
                          )}
                          {cartItemActions.discountAbs && (
                            <button
                              onClick={() => openOrderItemAction('discountAbs', item)}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 hover:border-gray-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'הנחה ₪' : 'Скидка ₪'}
                            </button>
                          )}
                          {isPriceModified && (
                            <button
                              onClick={() => onUpdateItem(item.id, { price: origPrice })}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-red-200 text-red-400 hover:border-red-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'אפס' : 'Сброс'}
                            </button>
                          )}
                          {cartItemActions.modifiers && (
                            <button
                              onClick={() => { setEditingOrderItem(item); setSelectedOrderItemId(null) }}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 hover:border-gray-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'תוספות' : 'Допы'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex gap-1.5 items-center">
                          <button
                            onClick={() => setNumpadOpen('order')}
                            className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-1.5 bg-white text-left tabular-nums font-semibold text-gray-900 min-w-0"
                          >
                            {orderItemInput || <span className="text-gray-300">{item.price.toFixed(0)}</span>}
                          </button>
                          {numpadOpen === 'order' && (
                            <Numpad
                              label={orderItemAction === 'price' ? (lang === 'he' ? 'מחיר ₪' : 'Цена ₪') :
                                     orderItemAction === 'discountPct' ? (lang === 'he' ? 'הנחה %' : 'Скидка %') :
                                     (lang === 'he' ? 'הנחה ₪' : 'Скидка ₪')}
                              value={orderItemInput}
                              placeholder={item.price.toFixed(0)}
                              onConfirm={(val) => { setNumpadOpen(null); applyOrderItemAction(item, val) }}
                              onCancel={() => setNumpadOpen(null)}
                            />
                          )}
                          <button onClick={() => applyOrderItemAction(item)} className="text-sm font-semibold px-3 py-1.5 bg-gray-900 text-white rounded-xl hover:bg-gray-700 transition-all">
                            OK
                          </button>
                          <button onClick={() => setOrderItemAction(null)} className="text-sm text-gray-400 hover:text-gray-600 px-1">
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Modifiers of saved item */}
                  {item.order_item_modifiers && item.order_item_modifiers.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5 ms-4">
                      {item.order_item_modifiers.map((m) => (
                        <span key={m.modifier.id} className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-lg leading-tight">
                          {m.modifier.name}
                          {m.modifier.price_delta > 0 && <span className="text-gray-400"> +{m.modifier.price_delta}₪</span>}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Note for existing order item */}
                  {onUpdateItemNotes && item.status !== 'served' && (
                    editOrderNoteId === item.id ? (
                      <div className="mt-1.5 ms-4 flex gap-1.5">
                        <input
                          autoFocus
                          value={orderNoteText}
                          onChange={(e) => setOrderNoteText(e.target.value)}
                          placeholder={t(lang, 'notePlaceholder')}
                          className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-900/10 bg-gray-50"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { onUpdateItemNotes(item.id, orderNoteText); setEditOrderNoteId(null) }
                            if (e.key === 'Escape') setEditOrderNoteId(null)
                          }}
                        />
                        <button
                          onClick={() => { onUpdateItemNotes(item.id, orderNoteText); setEditOrderNoteId(null) }}
                          className="text-sm text-gray-700 font-semibold px-3 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors"
                        >OK</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditOrderNoteId(item.id); setOrderNoteText(item.notes ?? '') }}
                        className="text-xs text-gray-400 hover:text-gray-600 mt-1 ms-4 transition-colors block"
                      >
                        {item.notes
                          ? <span className="text-gray-500 italic">"{item.notes}"</span>
                          : t(lang, 'noteItem')}
                      </button>
                    )
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* New cart items */}
        {cart.length > 0 && (
          <div className={`px-4 ${activeOrder?.order_items?.length ? 'pt-3 mt-2' : 'pt-3'}`}>
            {activeOrder?.order_items?.length ? (
              <div className="flex items-center gap-2 mb-2.5">
                <div className="flex-1 h-px bg-gray-100" />
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest bg-gray-50 px-2 py-0.5 rounded-md">
                  {t(lang, 'adding')}
                </span>
                <div className="flex-1 h-px bg-gray-100" />
              </div>
            ) : null}
            {cart.map((c) => {
              const isSelected = selectedCartKey === c.cartKey
              const originalUnit = c.menu_item.price + c.extraPrice
              const hasModifiedPrice = c.overridePrice !== null || c.discountPct > 0 || c.discountAbs > 0
              return (
                <div
                  key={c.cartKey}
                  className={`py-2.5 border-b border-gray-50 last:border-0 rounded-xl transition-all ${isSelected ? 'bg-gray-50 px-2 -mx-2' : ''}`}
                >
                  <div
                    className={`flex items-center gap-2 ${hasAnyCartAction ? 'cursor-pointer' : ''}`}
                    onClick={() => hasAnyCartAction && selectItem(c.cartKey)}
                  >
                    {/* New indicator */}
                    <div className="shrink-0 w-2 h-2 rounded-full bg-gray-900/20" />

                    <p className="text-sm font-medium text-gray-800 flex-1 min-w-0 break-words">{c.menu_item.name}</p>

                    {!isSelected && cartItemActions.modifiers && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingCartKey(c.cartKey) }}
                        className="shrink-0 w-8 h-8 text-gray-300 hover:text-gray-500 transition-colors flex items-center justify-center"
                        title="Изменить"
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
                        </svg>
                      </button>
                    )}

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); updateQty(c.cartKey, c.qty - 1) }}
                        className="w-7 h-7 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm font-bold text-gray-600 flex items-center justify-center transition-colors active:scale-[0.93]"
                      >−</button>
                      <span className="text-sm font-bold text-gray-800 w-5 text-center tabular-nums">{c.qty}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); updateQty(c.cartKey, c.qty + 1) }}
                        className="w-7 h-7 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm font-bold text-gray-600 flex items-center justify-center transition-colors active:scale-[0.93]"
                      >+</button>
                      <div className="w-12 text-right">
                        {hasModifiedPrice ? (
                          <div>
                            <span className="text-sm font-bold text-emerald-600">{calcItemTotal(c).toFixed(0)} ₪</span>
                            <span className="block text-[9px] text-gray-300 line-through leading-none">{(originalUnit * c.qty).toFixed(0)}</span>
                          </div>
                        ) : (
                          <span className="text-sm font-bold text-gray-700">{calcItemTotal(c).toFixed(0)} ₪</span>
                        )}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeFromCart(c.cartKey) }}
                        className="w-7 h-7 text-gray-300 hover:text-red-400 flex items-center justify-center text-base leading-none transition-colors active:scale-[0.93]"
                      >×</button>
                    </div>
                  </div>

                  {/* Quick action panel */}
                  {isSelected && (
                    <div className="mt-2 ms-4">
                      {activeAction === null ? (
                        <div className="flex flex-wrap gap-1.5">
                          {cartItemActions.price && (
                            <button
                              onClick={() => openAction('price')}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 hover:border-gray-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'שנה מחיר' : 'Цена'}
                            </button>
                          )}
                          {cartItemActions.discountPct && (
                            <button
                              onClick={() => openAction('discountPct')}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 hover:border-gray-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'הנחה %' : 'Скидка %'}
                            </button>
                          )}
                          {cartItemActions.discountAbs && (
                            <button
                              onClick={() => openAction('discountAbs')}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 hover:border-gray-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'הנחה ₪' : 'Скидка ₪'}
                            </button>
                          )}
                          {hasModifiedPrice && (
                            <button
                              onClick={() => resetItemPrice(c.cartKey)}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-red-200 text-red-400 hover:border-red-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'אפס' : 'Сброс'}
                            </button>
                          )}
                          {cartItemActions.modifiers && (
                            <button
                              onClick={() => { setEditingCartKey(c.cartKey); setSelectedCartKey(null) }}
                              className="text-xs px-3 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 hover:border-gray-400 transition-all font-medium active:scale-[0.95]"
                            >
                              {lang === 'he' ? 'תוספות' : 'Допы'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex gap-1.5 items-center">
                          <button
                            onClick={() => setNumpadOpen('cart')}
                            className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-1.5 bg-white text-left tabular-nums font-semibold text-gray-900 min-w-0"
                          >
                            {actionInput || <span className="text-gray-300">{activeAction === 'price' ? cartItemEffectivePrice(c).toFixed(0) : '0'}</span>}
                          </button>
                          {numpadOpen === 'cart' && (
                            <Numpad
                              label={activeAction === 'price' ? (lang === 'he' ? 'מחיר ₪' : 'Цена ₪') :
                                     activeAction === 'discountPct' ? (lang === 'he' ? 'הנחה %' : 'Скидка %') :
                                     (lang === 'he' ? 'הנחה ₪' : 'Скидка ₪')}
                              value={actionInput}
                              placeholder={activeAction === 'price' ? cartItemEffectivePrice(c).toFixed(0) : '0'}
                              onConfirm={(val) => { setNumpadOpen(null); applyAction(val) }}
                              onCancel={() => setNumpadOpen(null)}
                            />
                          )}
                          <button onClick={() => applyAction()} className="text-sm font-semibold px-3 py-1.5 bg-gray-900 text-white rounded-xl hover:bg-gray-700 transition-all">
                            OK
                          </button>
                          <button onClick={() => setActiveAction(null)} className="text-sm text-gray-400 hover:text-gray-600 px-1">
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Guest selector */}
                  {guestCount > 1 && (
                    <div className="flex gap-1 mt-1.5 ms-4 flex-wrap">
                      <button
                        onClick={() => updateGuest(c.cartKey, 0)}
                        className={`text-xs px-2 py-0.5 rounded-lg font-medium transition-all ${
                          c.guest === 0 ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                      >—</button>
                      {Array.from({ length: guestCount }, (_, i) => i + 1).map((g) => (
                        <button
                          key={g}
                          onClick={() => updateGuest(c.cartKey, g)}
                          className={`text-xs px-2 py-0.5 rounded-lg font-medium transition-all ${
                            c.guest === g ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                          }`}
                        >Г{g}</button>
                      ))}
                    </div>
                  )}

                  {/* Modifiers */}
                  {c.modifierNames.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5 ms-4">
                      {c.modifierNames.map((name) => (
                        <span key={name} className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-lg leading-tight">
                          {name}
                        </span>
                      ))}
                      {c.extraPrice > 0 && (
                        <span className="text-xs text-gray-400 leading-tight self-center">+{c.extraPrice}₪</span>
                      )}
                    </div>
                  )}

                  {/* Note */}
                  {editNoteKey === c.cartKey ? (
                    <div className="mt-1.5 ms-4 flex gap-1.5">
                      <input
                        autoFocus
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder={t(lang, 'notePlaceholder')}
                        className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-900/10 bg-gray-50"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { updateNotes(c.cartKey, noteText); setEditNoteKey(null) }
                          if (e.key === 'Escape') setEditNoteKey(null)
                        }}
                      />
                      <button
                        onClick={() => { updateNotes(c.cartKey, noteText); setEditNoteKey(null) }}
                        className="text-sm text-gray-700 font-semibold px-3 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors"
                      >OK</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditNoteKey(c.cartKey); setNoteText(c.notes) }}
                      className="text-xs text-gray-400 hover:text-gray-600 mt-1 ms-4 transition-colors block"
                    >
                      {c.notes
                        ? <span className="text-gray-500 italic">"{c.notes}"</span>
                        : t(lang, 'noteItem')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Edit modifiers modal — cart (unsaved) items */}
      {editingItem && (
        <ModifierModal
          item={editingItem.menu_item}
          initialModifierIds={editingItem.modifierIds}
          initialNote={editingItem.notes}
          confirmLabel={lang === 'he' ? 'שמור שינויים' : 'Сохранить изменения'}
          onConfirm={(modifierIds, extraPrice, notes, modifierNames) => {
            updateModifiers(editingItem.cartKey, modifierIds, modifierNames, extraPrice, notes)
            setEditingCartKey(null)
          }}
          onClose={() => setEditingCartKey(null)}
        />
      )}

      {/* Edit modal — already saved order items */}
      {editingOrderItem && editingOrderItem.menu_item && (
        <ModifierModal
          item={editingOrderItem.menu_item}
          initialModifierIds={editingOrderItem.order_item_modifiers?.map((m) => m.modifier.id) ?? []}
          initialNote={editingOrderItem.notes ?? ''}
          confirmLabel={lang === 'he' ? 'שמור שינויים' : 'Сохранить изменения'}
          onConfirm={(modifierIds, extraPrice, notes) => {
            onUpdateItem?.(editingOrderItem.id, {
              price: editingOrderItem.menu_item!.price + extraPrice,
              notes,
              modifierIds,
            })
            setEditingOrderItem(null)
          }}
          onClose={() => setEditingOrderItem(null)}
        />
      )}

      {/* Footer */}
      <div className="border-t border-gray-200 px-4 pt-3 pb-4">
        {!moveMode ? (
          <>
            {/* Total */}
            <div className="flex justify-between items-center mb-4 bg-gray-50 rounded-2xl px-4 py-3">
              <span className="text-sm text-gray-500 font-medium">{t(lang, 'total')}</span>
              <span className="text-3xl font-black text-gray-900 tabular-nums">{grandTotal.toFixed(0)} ₪</span>
            </div>

            {/* Primary action */}
            {cart.length > 0 && !isRetail && (
              <button
                onClick={onSendToKitchen}
                disabled={isSending}
                className="btn-primary w-full py-3.5 text-sm mb-2"
              >
                {isSending ? t(lang, 'sending') : t(lang, 'sendToKitchen')}
              </button>
            )}

            {/* Secondary: add to order without kitchen (restaurant only) */}
            {cart.length > 0 && activeOrder && !isRetail && (
              <button
                onClick={onSave}
                disabled={isSaving}
                className="btn-secondary w-full py-2.5 text-sm mb-2"
              >
                {isSaving ? t(lang, 'saving') : t(lang, 'addToOrder')}
              </button>
            )}

            {/* Retail: save cart and go to payment */}
            {isRetail && cart.length > 0 && (
              <button
                onClick={onSave}
                disabled={isSaving}
                className="btn-primary w-full py-3.5 text-sm mb-2"
              >
                {isSaving ? t(lang, 'saving') : (lang === 'he' ? 'לתשלום' : 'К оплате')}
              </button>
            )}

            {/* Bill + Move row */}
            <div className="flex gap-2">
              {activeOrder && onRequestBill && (
                <button
                  onClick={onRequestBill}
                  disabled={isRequestingBill}
                  className="btn-danger flex-1 py-2.5 text-sm"
                >
                  {isRequestingBill ? '...' : t(lang, 'requestBill')}
                </button>
              )}
              {!isRetail && onMoveItems && activeOrder?.order_items && activeOrder.order_items.length > 0 && (
                <button
                  onClick={() => { setMoveMode(true); setMoveSelected(new Set()) }}
                  className="btn-ghost px-3 py-2.5 text-sm text-gray-500"
                  title={t(lang, 'moveItems')}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">{t(lang, 'moveSelectItems')}</p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (moveSelected.size === 0) return
                  setMoveTableModal(true)
                }}
                disabled={moveSelected.size === 0}
                className="btn-primary flex-1 py-2.5 text-sm disabled:opacity-40"
              >
                {t(lang, 'moveConfirm')} {moveSelected.size > 0 ? `(${moveSelected.size})` : ''}
              </button>
              <button
                onClick={() => { setMoveMode(false); setMoveSelected(new Set()) }}
                className="btn-secondary px-4 py-2.5 text-sm"
              >
                {t(lang, 'moveCancelled')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Table picker modal */}
      {moveTableModal && tables && (
        <div className="absolute inset-0 bg-black/40 flex items-end z-20" onClick={() => setMoveTableModal(false)}>
          <div className="bg-white w-full rounded-t-2xl p-5 max-h-[70%] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-gray-900 mb-4">{t(lang, 'moveSelectTable')}</h3>
            <div className="grid grid-cols-4 gap-2">
              {tables
                .filter((tb) => tb.id !== activeOrder?.table_id)
                .map((tb) => (
                  <button
                    key={tb.id}
                    disabled={isMoving}
                    onClick={async () => {
                      setIsMoving(true)
                      try {
                        await onMoveItems!(Array.from(moveSelected), tb.id)
                        setMoveTableModal(false)
                        setMoveMode(false)
                        setMoveSelected(new Set())
                      } finally {
                        setIsMoving(false)
                      }
                    }}
                    className={`py-3 rounded-xl text-sm font-semibold border-2 transition-all ${
                      tb.status === 'free'
                        ? 'border-gray-200 text-gray-700 hover:border-gray-400'
                        : 'border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-400'
                    } disabled:opacity-50`}
                  >
                    <div className="text-base font-black">{tb.number}</div>
                    {tb.zone && <div className="text-[10px] text-gray-400">{tb.zone}</div>}
                    <div className={`text-[10px] mt-0.5 ${tb.status === 'free' ? 'text-emerald-500' : 'text-amber-500'}`}>
                      {tb.status === 'free' ? (lang === 'he' ? 'פנוי' : 'Свободен') : (lang === 'he' ? 'תפוס' : 'Занят')}
                    </div>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      {confirmVoidItem && onVoidItem && (
        <ConfirmDialog
          title={t(lang, 'voidItemConfirm')}
          message={confirmVoidItem.menu_item?.name}
          confirmLabel={lang === 'he' ? 'מחק' : 'Удалить'}
          cancelLabel={lang === 'he' ? 'ביטול' : 'Отмена'}
          onConfirm={() => { onVoidItem(confirmVoidItem.id); setConfirmVoidItem(null) }}
          onCancel={() => setConfirmVoidItem(null)}
        />
      )}
    </div>
  )
}
