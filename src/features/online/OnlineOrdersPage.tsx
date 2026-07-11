import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { useAuthStore } from '../../store/authStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t, formatTime, formatElapsed } from '../../lib/i18n'
import { formatMoney } from '../../lib/money'
import { can } from '../../lib/perms'
import { playPaymentChime } from '../../lib/sound'
import { fetchCurrentLocation } from '../auth/api'
import { voidTableOrder } from '../tables/api'
import { payOrder, type PaymentInput } from '../sell/api'
import PaymentSheet from '../sell/PaymentSheet'
import ReceiptChoiceSheet from '../receipt/ReceiptChoiceSheet'
import { autoPrintReceipt, printKitchenTicket } from '../receipt/printService'
import AppSidebar from '../../components/AppSidebar'
import {
  fetchOnlineOrders, acceptOnlineOrder, rejectOnlineOrder, subscribeOnlineOrders,
  type OnlineOrder,
} from './api'

/**
 * Онлайн-заказы (050): заявки с сайта. Новые — принять/отклонить;
 * принятые ждут получения (оплата на кассе обычным pay_order);
 * решённые за сутки — история. Realtime + бейдж в сайдбаре.
 */
export default function OnlineOrdersPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const qc = useQueryClient()

  const paymentSound = useDeviceStore((s) => s.paymentSound)
  const printMode = useDeviceStore((s) => s.printMode)
  const autoPrintOn = useDeviceStore((s) => s.autoPrintReceipt)
  const receiptPromptOn = useDeviceStore((s) => s.receiptPrompt)
  const kitchenTicketOn = useDeviceStore((s) => s.printKitchenTicket)

  const { data: orders = [] } = useQuery({ queryKey: ['online_orders'], queryFn: fetchOnlineOrders })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })

  useEffect(() => subscribeOnlineOrders(() => qc.invalidateQueries({ queryKey: ['online_orders'] })), [qc])

  // Тик раз в 30с — «5 мин назад» на карточках живёт без перезапросов
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['online_orders'] })
    qc.invalidateQueries({ queryKey: ['queue'] })
    qc.invalidateQueries({ queryKey: ['orders'] })
    qc.invalidateQueries({ queryKey: ['current_shift'] })
  }

  // ── Принять: настоящий заказ → очередь бариста (+ кухонный тикет) ──
  const accept = useMutation({
    mutationFn: (o: OnlineOrder) => acceptOnlineOrder(o.id, staff!.id),
    onSuccess: (res, o) => {
      toast.success(`${t(lang, 'onlineAccepted')} — #${res.daily_number}`)
      if (kitchenTicketOn) {
        printKitchenTicket(
          {
            dailyNumber: res.daily_number,
            orderType: 'takeaway',
            customerName: o.customer_name,
            tableLabel: '',
            lines: o.items.map((l) => ({
              qty: l.qty,
              name: l.name,
              variantName: l.variant_name,
              modifiers: l.mods.map((m) => m.name),
              notes: l.notes ?? '',
            })),
            labels: {
              takeaway: t(lang, 'takeaway'),
              here: t(lang, 'here'),
              delivery: t(lang, 'delivery'),
              table: t(lang, 'tableLabel'),
              addon: t(lang, 'kitchenAddon'),
            },
          },
          printMode === 'rawbt'
        )
      }
      invalidateAll()
    },
    onError: (e) => {
      const msg = (e as Error).message
      toast.error(msg.includes('no open shift') ? t(lang, 'onlineNeedShift') : msg)
    },
  })

  // ── Отклонить (двухшаговое подтверждение + необязательная причина) ──
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const reject = useMutation({
    mutationFn: (o: OnlineOrder) => rejectOnlineOrder(o.id, staff!.id, rejectReason.trim() || undefined),
    onSuccess: () => {
      setRejecting(null)
      setRejectReason('')
      invalidateAll()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  // ── Отмена принятого (гость передумал): void, остаток вернёт 047 ──
  const [cancelling, setCancelling] = useState<string | null>(null)
  const cancelOrder = useMutation({
    mutationFn: (orderId: string) => voidTableOrder(orderId, 'online cancelled'),
    onSuccess: () => {
      setCancelling(null)
      invalidateAll()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  // ── Оплата при получении: PaymentSheet → pay_order → чек ──
  const [paying, setPaying] = useState<OnlineOrder | null>(null)
  const [receiptChoice, setReceiptChoice] = useState<string | null>(null)
  const pay = useMutation({
    mutationFn: ({ orderId, payments }: { orderId: string; payments: PaymentInput[] }) =>
      payOrder(orderId, payments, 0, crypto.randomUUID()),
    onSuccess: (res) => {
      setPaying(null)
      if (paymentSound) playPaymentChime()
      if (receiptPromptOn) setReceiptChoice(res.order_id)
      else if (autoPrintOn) void autoPrintReceipt(res.order_id, location, printMode === 'rawbt')
      invalidateAll()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const canVoid = can(staff?.role, 'void_order', location?.settings)
  const fresh = orders.filter((o) => o.status === 'new')
  const awaiting = orders.filter((o) => o.status === 'accepted' && o.order?.status === 'open')
  const done = orders.filter((o) => !fresh.includes(o) && !awaiting.includes(o))

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="online" />

      <main className="flex-1 min-w-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <h1 className="text-xl font-bold text-gray-900">{t(lang, 'onlineOrders')}</h1>
          <span className="text-sm text-gray-500">
            {t(lang, 'onlineNewCount')}: <span className="font-bold tabular-nums text-gray-900">{fresh.length}</span>
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {orders.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <p className="font-bold text-gray-900">{t(lang, 'onlineEmpty')}</p>
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'onlineEmptyHint')}</p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-8">
              {fresh.length > 0 && (
                <Section title={t(lang, 'onlineNew')}>
                  {fresh.map((o) => (
                    <div key={o.id} className="card p-4 border-2 border-gray-900">
                      <OrderHead o={o} lang={lang} nowTs={nowTs} />
                      <Items o={o} lang={lang} />
                      {rejecting === o.id ? (
                        <div className="mt-3 space-y-2">
                          <input
                            className="input w-full"
                            placeholder={t(lang, 'onlineRejectReason')}
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            autoFocus
                          />
                          <div className="flex gap-2">
                            <button className="btn-secondary flex-1 h-11" onClick={() => { setRejecting(null); setRejectReason('') }}>
                              {t(lang, 'cancel')}
                            </button>
                            <button className="btn-danger flex-1 h-11" disabled={reject.isPending} onClick={() => reject.mutate(o)}>
                              {t(lang, 'onlineRejectConfirm')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2 mt-3">
                          <button className="btn-secondary h-12 px-6" onClick={() => setRejecting(o.id)}>
                            {t(lang, 'onlineReject')}
                          </button>
                          <button className="btn-primary flex-1 h-12" disabled={accept.isPending} onClick={() => accept.mutate(o)}>
                            {t(lang, 'onlineAccept')} · {formatMoney(o.total, lang)}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </Section>
              )}

              {awaiting.length > 0 && (
                <Section title={t(lang, 'onlineAwaitingPickup')}>
                  {awaiting.map((o) => (
                    <div key={o.id} className="card p-4">
                      <OrderHead o={o} lang={lang} nowTs={nowTs} number={o.order!.daily_number} />
                      <Items o={o} lang={lang} />
                      {cancelling === o.id ? (
                        <div className="flex gap-2 mt-3">
                          <button className="btn-secondary flex-1 h-11" onClick={() => setCancelling(null)}>
                            {t(lang, 'cancel')}
                          </button>
                          <button className="btn-danger flex-1 h-11" disabled={cancelOrder.isPending} onClick={() => cancelOrder.mutate(o.order!.id)}>
                            {t(lang, 'onlineCancelConfirm')}
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2 mt-3">
                          {canVoid && (
                            <button className="btn-secondary h-12 px-6" onClick={() => setCancelling(o.id)}>
                              {t(lang, 'onlineCancel')}
                            </button>
                          )}
                          <button className="btn-primary flex-1 h-12" onClick={() => setPaying(o)}>
                            {t(lang, 'onlinePay')} · {formatMoney(o.order!.total, lang)}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </Section>
              )}

              {done.length > 0 && (
                <Section title={t(lang, 'onlineFinished')}>
                  {done.map((o) => (
                    <div key={o.id} className="card p-4 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          {o.order && <span className="font-black tabular-nums text-gray-900">#{o.order.daily_number}</span>}
                          <span className="text-sm font-semibold text-gray-900 truncate">{o.customer_name}</span>
                          <span className="text-xs text-gray-500 tabular-nums">{formatTime(o.created_at, lang)}</span>
                        </div>
                        {o.reject_reason && <div className="text-xs text-gray-500 mt-1">{o.reject_reason}</div>}
                      </div>
                      <span className="text-sm font-bold text-gray-900 tabular-nums">{formatMoney(o.order?.total ?? o.total, lang)}</span>
                      <DoneBadge o={o} lang={lang} />
                    </div>
                  ))}
                </Section>
              )}
            </div>
          )}
        </div>
      </main>

      {paying && paying.order && (
        <PaymentSheet
          total={paying.order.total}
          onCancel={() => setPaying(null)}
          onPay={(payments) => pay.mutate({ orderId: paying.order!.id, payments })}
          busy={pay.isPending}
        />
      )}

      {receiptChoice && (
        <ReceiptChoiceSheet
          orderId={receiptChoice}
          location={location}
          onDone={() => setReceiptChoice(null)}
        />
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

/** «5 мин назад»; «только что» — без хвоста «назад» */
function agoText(iso: string, nowTs: number, lang: 'ru' | 'he'): string {
  const s = formatElapsed(iso, nowTs, lang)
  return s === t(lang, 'justNow') ? s : `${s} ${t(lang, 'ago')}`
}

/** Шапка карточки: имя, телефон, когда пришла, когда забрать */
function OrderHead({ o, lang, nowTs, number }: { o: OnlineOrder; lang: 'ru' | 'he'; nowTs: number; number?: number }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          {number !== undefined && <span className="text-xl font-black tabular-nums text-gray-900">#{number}</span>}
          <span className="font-bold text-gray-900 truncate">{o.customer_name}</span>
          <span className="text-sm text-gray-500 tabular-nums" dir="ltr">{o.customer_phone}</span>
        </div>
        <div className="text-sm text-gray-500 mt-1">
          {agoText(o.created_at, nowTs, lang)} ·{' '}
          <span className="font-semibold text-gray-900">
            {o.pickup_at ? `${t(lang, 'onlinePickupAt')} ${formatTime(o.pickup_at, lang)}` : t(lang, 'onlineAsap')}
          </span>
        </div>
        {o.note && <div className="text-sm text-gray-700 mt-1">«{o.note}»</div>}
      </div>
    </div>
  )
}

/** Позиции заявки (снапшот с ценами на момент заявки) */
function Items({ o, lang }: { o: OnlineOrder; lang: 'ru' | 'he' }) {
  return (
    <div className="mt-3 space-y-1">
      {o.items.map((l, i) => (
        <div key={i} className="flex items-baseline gap-2 text-sm">
          <span className="tabular-nums font-semibold text-gray-900 shrink-0">{l.qty}×</span>
          <span className="flex-1 min-w-0">
            <span className="font-semibold text-gray-900">{l.name}</span>
            {(l.variant_name || l.mods.length > 0 || l.notes) && (
              <span className="text-gray-500">
                {' '}· {[l.variant_name, ...l.mods.map((m) => m.name), l.notes].filter(Boolean).join(' · ')}
              </span>
            )}
          </span>
          <span className="tabular-nums text-gray-900 shrink-0">{formatMoney(l.line_total, lang)}</span>
        </div>
      ))}
    </div>
  )
}

function DoneBadge({ o, lang }: { o: OnlineOrder; lang: 'ru' | 'he' }) {
  if (o.status === 'rejected') return <span className="badge-red">{t(lang, 'onlineRejected')}</span>
  const st = o.order?.status
  if (st === 'voided') return <span className="badge-gray">{t(lang, 'onlineCancelled')}</span>
  if (st === 'paid' || st === 'fulfilled') return <span className="badge-green">{t(lang, 'onlinePaid')}</span>
  return <span className="badge-blue">{t(lang, 'onlineAcceptedBadge')}</span>
}
