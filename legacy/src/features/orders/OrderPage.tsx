import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { fetchActiveOrder, createOrder, addOrderItems, sendOrderToKitchen, requestBill, voidOrderItem, cancelOrder, updateOrderItemQty, updateOrderItemNotes, updateOrderItem, updateOrderCustomerName, moveOrderItems } from './api'
import { fetchMenuCategories, fetchMenuItems } from '../menu/api'
import { fetchTables } from '../tables/api'
import { useAuthStore } from '../../store/authStore'
import { useOrderStore, cartItemEffectivePrice } from '../../store/orderStore'
import { useLangStore } from '../../store/langStore'
import { useSettingsStore } from '../../store/settingsStore'
import { t } from '../../lib/i18n'
import { sendToPrinter } from '../../lib/printer'
import MenuItemCard from '../menu/MenuItemCard'
import CartPanel from './CartPanel'
import HubButton from '../../components/ui/HubButton'
import ConfirmDialog from '../../components/ui/ConfirmDialog'

export default function OrderPage() {
  const { tableId } = useParams<{ tableId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const staff = useAuthStore((s) => s.currentStaff)
  const { cart, addToCart, clearCart } = useOrderStore()
  const lang = useLangStore((s) => s.lang)
  const venueType = useSettingsStore((s) => s.venueType)
  const isRetail = venueType === 'retail'

  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [confirmCancel, setConfirmCancel] = useState(false)

  const { data: categories = [] } = useQuery({
    queryKey: ['menu-categories'],
    queryFn: fetchMenuCategories,
    staleTime: 300_000,
  })

  const { data: menuItems = [] } = useQuery({
    queryKey: ['menu-items'],
    queryFn: fetchMenuItems,
    staleTime: 300_000,
  })

  const { data: activeOrder } = useQuery({
    queryKey: ['active-order', tableId],
    queryFn: () => fetchActiveOrder(tableId!),
    enabled: !!tableId,
  })

  const { data: tables = [] } = useQuery({
    queryKey: ['tables'],
    queryFn: fetchTables,
    staleTime: 30_000,
  })

  const filteredItems = useMemo(() => {
    return menuItems.filter((item) => {
      const matchCat = !activeCategoryId || item.category_id === activeCategoryId
      const matchSearch = !search || item.name.toLowerCase().includes(search.toLowerCase())
      return matchCat && matchSearch
    })
  }, [menuItems, activeCategoryId, search])

  const submitOrderMutation = useMutation({
    mutationFn: async () => {
      if (cart.length === 0) throw new Error(t(lang, 'cartEmpty'))
      let orderId = activeOrder?.id
      if (!orderId) {
        const newOrder = await createOrder(tableId!, staff!.id)
        orderId = newOrder.id
      }
      await addOrderItems(orderId, cart.map((c) => ({
        menu_item_id: c.menu_item.id,
        qty: c.qty,
        price: cartItemEffectivePrice(c),
        notes: c.notes,
        modifierIds: c.modifierIds,
      })))
      return orderId
    },
    onSuccess: (orderId) => {
      clearCart()
      qc.invalidateQueries({ queryKey: ['active-order', tableId] })
      if (isRetail) {
        navigate(`/payment/${orderId}`)
      } else {
        toast.success(t(lang, 'addedToOrder'))
      }
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const sendToKitchenMutation = useMutation({
    mutationFn: async () => {
      if (!activeOrder && cart.length === 0) throw new Error(t(lang, 'noItems'))
      let orderId = activeOrder?.id
      if (!orderId) {
        const newOrder = await createOrder(tableId!, staff!.id)
        orderId = newOrder.id
      }
      if (cart.length > 0) {
        await addOrderItems(orderId, cart.map((c) => ({
          menu_item_id: c.menu_item.id,
          qty: c.qty,
          price: cartItemEffectivePrice(c),
          notes: c.notes,
          modifierIds: c.modifierIds,
        })))
      }
      await sendOrderToKitchen(orderId)

      const updatedOrder = await fetchActiveOrder(tableId!)
      if (updatedOrder) {
        sendToPrinter({
          type: 'kitchen',
          order: {
            id: updatedOrder.id,
            table_number: updatedOrder.table?.number ?? 0,
            waiter_name: staff?.name ?? '',
            created_at: updatedOrder.created_at,
            total: updatedOrder.total,
            items: (updatedOrder.order_items ?? []).map((oi) => ({
              name: oi.menu_item?.name ?? '',
              qty: oi.qty,
              price: oi.price,
              notes: oi.notes ?? undefined,
            })),
          },
        })
      }
    },
    onSuccess: () => {
      clearCart()
      qc.invalidateQueries({ queryKey: ['active-order', tableId] })
      qc.invalidateQueries({ queryKey: ['tables'] })
      toast.success(t(lang, 'sentToKitchen'))
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const requestBillMutation = useMutation({
    mutationFn: () => requestBill(activeOrder!.id, tableId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tables'] })
      navigate(`/payment/${activeOrder!.id}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const updateItemMutation = useMutation({
    mutationFn: ({ itemId, updates }: { itemId: string; updates: { price?: number; notes?: string; modifierIds?: string[] } }) =>
      updateOrderItem(itemId, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['active-order', tableId] })
      toast.success(lang === 'he' ? 'השינויים נשמרו' : 'Изменения сохранены')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const updateItemQtyMutation = useMutation({
    mutationFn: ({ itemId, qty }: { itemId: string; qty: number }) =>
      updateOrderItemQty(itemId, qty),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['active-order', tableId] }),
    onError: (e: Error) => toast.error(e.message),
  })

  const updateItemNotesMutation = useMutation({
    mutationFn: ({ itemId, notes }: { itemId: string; notes: string }) =>
      updateOrderItemNotes(itemId, notes),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['active-order', tableId] }),
    onError: (e: Error) => toast.error(e.message),
  })

  const voidItemMutation = useMutation({
    mutationFn: (itemId: string) => voidOrderItem(itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['active-order', tableId] })
      toast.success(t(lang, 'itemVoided'))
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const cancelOrderMutation = useMutation({
    mutationFn: () => cancelOrder(activeOrder!.id, tableId!),
    onSuccess: () => {
      clearCart()
      qc.invalidateQueries({ queryKey: ['tables'] })
      toast.success(t(lang, 'orderCancelled'))
      navigate(isRetail ? '/hub' : '/tables')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const handleMoveItems = async (itemIds: string[], toTableId: string) => {
    if (!activeOrder || !tableId || !staff) return
    await moveOrderItems(itemIds, activeOrder.id, tableId, toTableId, staff.id)
    qc.invalidateQueries({ queryKey: ['active-order', tableId] })
    qc.invalidateQueries({ queryKey: ['tables'] })
    toast.success(t(lang, 'moveSuccess'))
    const remaining = await fetchActiveOrder(tableId)
    if (!remaining) navigate('/tables')
  }

  const isRtl = lang === 'he'

  const [isSavingBack, setIsSavingBack] = useState(false)

  const handleBack = async () => {
    if (cart.length === 0) {
      navigate(isRetail ? '/hub' : '/tables')
      return
    }
    setIsSavingBack(true)
    try {
      let orderId = activeOrder?.id
      if (!orderId) {
        const newOrder = await createOrder(tableId!, staff!.id)
        orderId = newOrder.id
      }
      await addOrderItems(orderId, cart.map((c) => ({
        menu_item_id: c.menu_item.id,
        qty: c.qty,
        price: cartItemEffectivePrice(c),
        notes: c.notes,
        modifierIds: c.modifierIds,
      })))
      clearCart()
    } catch (e: any) {
      toast.error(e?.message ?? 'Ошибка сохранения')
      setIsSavingBack(false)
      return
    }
    navigate(isRetail ? '/hub' : '/tables')
  }

  return (
    <div className="h-screen flex flex-col bg-[#f8f9fb]" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Header */}
      <header className="bg-white border-b border-gray-100 px-4 h-14 flex items-center gap-3 shrink-0 shadow-[0_1px_4px_rgba(0,0,0,0.06)] z-10">
        <HubButton />
        <button
          onClick={handleBack}
          disabled={isSavingBack}
          className="w-8 h-8 rounded-xl hover:bg-gray-100 flex items-center justify-center text-gray-500 transition-colors disabled:opacity-40"
        >
          {isSavingBack ? '…' : (isRtl ? '→' : '←')}
        </button>

        <div className="flex items-center gap-2 min-w-0">
          {!isRetail && (
            <div className="w-7 h-7 rounded-lg bg-gray-900 flex items-center justify-center shrink-0">
              <span className="text-white text-xs font-bold">
                {activeOrder?.table?.number ?? '?'}
              </span>
            </div>
          )}
          <div className="min-w-0">
            <h1 className="font-semibold text-gray-900 text-sm leading-none">
              {isRetail
                ? (lang === 'he' ? 'קופה' : 'Касса')
                : `${t(lang, 'table')} ${activeOrder?.table?.number ?? '—'}`}
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {activeOrder ? `#${activeOrder.id.slice(0, 8).toUpperCase()}` : t(lang, 'newOrder')}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {activeOrder && staff?.role === 'manager' && (
            <button
              onClick={() => {
                setConfirmCancel(true)
              }}
              disabled={cancelOrderMutation.isPending}
              className="btn-ghost py-2 px-3 text-xs text-red-500 hover:bg-red-50"
            >
              {t(lang, 'cancelOrder')}
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Category sidebar */}
        <aside className="w-[130px] bg-white border-r border-gray-100 flex flex-col overflow-y-auto shrink-0 py-2 scroll-fade-y">
          <button
            onClick={() => setActiveCategoryId(null)}
            className={`mx-2 mb-1.5 px-2 py-3 rounded-xl text-xs font-medium text-left transition-all leading-tight ${
              !activeCategoryId
                ? 'bg-gray-900 text-white'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
            }`}
          >
            {t(lang, 'allCategories')}
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategoryId(cat.id)}
              className={`mx-2 mb-1.5 px-2 py-3 rounded-xl text-xs font-medium text-left transition-all leading-tight ${
                activeCategoryId === cat.id
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </aside>

        {/* Menu area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Search */}
          <div className="px-4 py-3 bg-white border-b border-gray-100">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder={t(lang, 'searchMenu')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input pl-9 text-sm"
                dir={isRtl ? 'rtl' : 'ltr'}
              />
            </div>
          </div>

          {/* Items grid — 4 cols */}
          <div className="flex-1 overflow-y-auto p-4 grid grid-cols-4 gap-3 content-start">
            {filteredItems.map((item) => (
              <MenuItemCard
                key={item.id}
                item={item}
                lang={lang}
                onAdd={(modIds, extra, note, modNames) => addToCart(item, modIds, extra, note, 0, modNames)}
              />
            ))}
          </div>
        </div>

        {/* Cart */}
        <CartPanel
          tableId={tableId!}
          activeOrder={activeOrder ?? null}
          lang={lang}
          onSave={() => submitOrderMutation.mutate()}
          onSendToKitchen={() => sendToKitchenMutation.mutate()}
          onRequestBill={() => requestBillMutation.mutate()}
          isSaving={submitOrderMutation.isPending}
          isSending={sendToKitchenMutation.isPending}
          isRequestingBill={requestBillMutation.isPending}
          onVoidItem={(itemId) => voidItemMutation.mutate(itemId)}
          isVoiding={voidItemMutation.isPending}
          onUpdateItemQty={(itemId, qty) => updateItemQtyMutation.mutate({ itemId, qty })}
          onUpdateItemNotes={(itemId, notes) => updateItemNotesMutation.mutate({ itemId, notes })}
          onUpdateItem={(itemId, updates) => updateItemMutation.mutate({ itemId, updates })}
          onUpdateCustomerName={(name) => {
            if (activeOrder) updateOrderCustomerName(activeOrder.id, name)
          }}
          onMoveItems={handleMoveItems}
          tables={tables}
        />
      </div>

      {confirmCancel && (
        <ConfirmDialog
          title={t(lang, 'cancelOrderConfirm')}
          confirmLabel={lang === 'he' ? 'בטל הזמנה' : 'Отменить заказ'}
          cancelLabel={lang === 'he' ? 'חזור' : 'Назад'}
          onConfirm={() => { cancelOrderMutation.mutate(); setConfirmCancel(false) }}
          onCancel={() => setConfirmCancel(false)}
        />
      )}
    </div>
  )
}
