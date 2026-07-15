import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { useAuthStore } from '../../store/authStore'
import { useDeviceStore } from '../../store/deviceStore'
import { t, formatTime, formatElapsed, type TranslationKey } from '../../lib/i18n'
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
  fetchOnlineOrders, fetchOnlineStats, acceptOnlineOrder, rejectOnlineOrder,
  setOnlinePause, setOnlinePrepRange,
  type OnlineOrder,
} from './api'
import type { Location, LocationSettings } from '../../types'

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
  const deviceName = useDeviceStore((s) => s.deviceName)

  const { data: orders = [] } = useQuery({ queryKey: ['online_orders'], queryFn: fetchOnlineOrders })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })
  const { data: stats } = useQuery({ queryKey: ['online_stats'], queryFn: fetchOnlineStats, staleTime: 60_000 })

  // Realtime-подписки здесь нет: AppSidebar (смонтирован на этом экране)
  // уже подписан на online_orders и инвалидирует ['online_orders']

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
            staffName: staff?.name ?? '',
            deviceName,
            lines: o.items.map((l) => ({
              qty: l.qty,
              name: l.name,
              variantName: l.variant_name,
              modifiers: l.mods.map((m) => m.name),
              notes: l.notes ?? '',
            })),
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

  // ── Пауза приёма и время приготовления (054, идея из Square) ──
  const [stateSheet, setStateSheet] = useState(false)
  const oo = location?.settings?.online_orders
  const enabled = oo?.enabled !== false
  // Истёкшая пауза снимается сама — тик nowTs раз в 30с гасит пилюлю
  const pausedUntil = oo?.paused_until && Date.parse(oo.paused_until) > nowTs ? oo.paused_until : null
  const canPause = can(staff?.role, 'online_pause', location?.settings)
  // Вилка приготовления (061): новые ключи в приоритете, legacy prep_minutes = min=max
  const prepMin = oo?.prep_min ?? oo?.prep_minutes ?? 0
  const prepMax = oo?.prep_max ?? oo?.prep_minutes ?? 0

  const patchOnline = (patch: NonNullable<LocationSettings['online_orders']>) => {
    qc.setQueryData(['current_location'], (old: Location | undefined) =>
      old ? { ...old, settings: { ...old.settings, online_orders: { ...old.settings?.online_orders, ...patch } } } : old)
  }
  const onlineMutOpts = {
    onMutate: async (patch: NonNullable<LocationSettings['online_orders']>) => {
      await qc.cancelQueries({ queryKey: ['current_location'] })
      const prev = qc.getQueryData(['current_location'])
      patchOnline(patch)
      return { prev }
    },
    onError: (e: Error, _v: unknown, ctx?: { prev: unknown }) => {
      qc.setQueryData(['current_location'], ctx?.prev)
      toast.error(e.message)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['current_location'] }),
  }
  const pauseMut = useMutation({
    mutationFn: (patch: NonNullable<LocationSettings['online_orders']>) => setOnlinePause(patch.paused_until ?? null),
    ...onlineMutOpts,
  })
  const prepMut = useMutation({
    mutationFn: (r: { min: number; max: number }) => setOnlinePrepRange(r.min, r.max),
    onMutate: async (r: { min: number; max: number }) => {
      await qc.cancelQueries({ queryKey: ['current_location'] })
      const prev = qc.getQueryData(['current_location'])
      // Пишем новые ключи и гасим legacy prep_minutes (зеркало 061)
      patchOnline({ prep_min: r.min, prep_max: r.max, prep_minutes: null })
      return { prev }
    },
    onError: onlineMutOpts.onError,
    onSettled: onlineMutOpts.onSettled,
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
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-xl font-bold text-gray-900">{t(lang, 'onlineOrders')}</h1>
            {/* Статус приёма и время приготовления — кликабельные пилюли (Square) */}
            {location && (
              <button
                onClick={() => setStateSheet(true)}
                className="h-11 px-4 rounded-full border border-gray-200 hover:border-gray-400 flex items-center gap-2 active:scale-[0.97] transition-all shrink-0"
              >
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  !enabled ? 'bg-gray-300' : pausedUntil ? 'bg-amber-400' : 'bg-green-500'
                }`} />
                <span className="text-sm font-semibold text-gray-900">
                  {!enabled
                    ? t(lang, 'onlineStateOff')
                    : pausedUntil
                      ? `${t(lang, 'onlinePausedUntil')} ${formatTime(pausedUntil, lang)}`
                      : t(lang, 'onlineStateOn')}
                </span>
                <Chevron />
              </button>
            )}
            {location && enabled && (
              <button
                onClick={() => setStateSheet(true)}
                className="h-11 px-4 rounded-full border border-gray-200 hover:border-gray-400 flex items-center gap-2 active:scale-[0.97] transition-all shrink-0"
              >
                <ClockIcon />
                <span className="text-sm font-semibold text-gray-900 tabular-nums">
                  {prepMax > 0
                    ? `~${prepMin && prepMin < prepMax ? `${prepMin}–${prepMax}` : prepMax} ${t(lang, 'minShort')}`
                    : t(lang, 'onlinePrepTitle')}
                </span>
                <Chevron />
              </button>
            )}
          </div>
          {/* Статистика за 7 дней (идея из Square Online) */}
          {stats && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 me-1">{t(lang, 'onlineStats7d')}</span>
              <span className="badge-gray tabular-nums">{stats.requests} {t(lang, 'onlineStatReqs')}</span>
              <span className="badge-green tabular-nums">{stats.accepted} {t(lang, 'onlineStatAcc')}</span>
              <span className="badge-blue tabular-nums">{formatMoney(stats.revenue, lang)}</span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {orders.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <p className="font-bold text-gray-900">{t(lang, 'onlineEmpty')}</p>
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'onlineEmptyHint')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-6 items-start">
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

      {stateSheet && location && (
        <OnlineStateSheet
          lang={lang}
          enabled={enabled}
          pausedUntil={pausedUntil}
          prepMin={prepMin}
          prepMax={prepMax}
          canPause={canPause}
          busy={pauseMut.isPending || prepMut.isPending}
          onPause={(untilIso) => pauseMut.mutate({ paused_until: untilIso })}
          onResume={() => pauseMut.mutate({ paused_until: null })}
          onPrep={(min, max) => prepMut.mutate({ min, max })}
          onClose={() => setStateSheet(false)}
        />
      )}

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
        <div className="text-sm text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
          <span>
            {agoText(o.created_at, nowTs, lang)} ·{' '}
            <span className="font-semibold text-gray-900">
              {o.pickup_at ? `${t(lang, 'onlinePickupAt')} ${formatTime(o.pickup_at, lang)}` : t(lang, 'onlineAsap')}
            </span>
          </span>
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
            {t(lang, o.order_type === 'here' ? 'onlineTypeHere' : o.order_type === 'delivery' ? 'onlineTypeDelivery' : 'onlineTypeTakeaway')}
          </span>
        </div>
        {o.order_type === 'delivery' && o.delivery_address && (
          <div className="text-sm font-semibold text-gray-900 mt-1">{o.delivery_address}</div>
        )}
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

/** Пресеты паузы: минуты или 'eod' — до конца дня (23:59 локального) */
const PAUSE_PRESETS: { minutes: number | 'eod'; label: TranslationKey }[] = [
  { minutes: 30, label: 'onlinePause30' },
  { minutes: 60, label: 'onlinePause1h' },
  { minutes: 120, label: 'onlinePause2h' },
  { minutes: 'eod', label: 'onlinePauseEod' },
]

const PREP_PRESETS = [10, 15, 20, 30, 45, 60]

/**
 * Управление приёмом (054, Square-стиль): пауза на время (снимается
 * сама) и время приготовления, которое гость видит при заказе.
 * Изменения применяются сразу — шит не закрывается, статус в пилюлях
 * обновляется optimistic-патчем кеша current_location.
 */
function OnlineStateSheet({ lang, enabled, pausedUntil, prepMin, prepMax, canPause, busy, onPause, onResume, onPrep, onClose }: {
  lang: 'ru' | 'he'
  enabled: boolean
  pausedUntil: string | null
  prepMin: number
  prepMax: number
  canPause: boolean
  busy: boolean
  onPause: (untilIso: string) => void
  onResume: () => void
  onPrep: (min: number, max: number) => void
  onClose: () => void
}) {
  function pauseFor(preset: number | 'eod') {
    const until = new Date()
    if (preset === 'eod') until.setHours(23, 59, 0, 0)
    else until.setTime(until.getTime() + preset * 60_000)
    onPause(until.toISOString())
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-3xl p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">{t(lang, 'onlineOrders')}</h3>
          <button onClick={onClose} className="w-11 h-11 rounded-xl bg-gray-100 text-gray-500 font-bold active:scale-[0.94] transition-all">✕</button>
        </div>

        {!enabled ? (
          // Выключено тумблером в настройках — пауза не имеет смысла
          <p className="text-sm text-gray-500 mt-4">{t(lang, 'onlineOffHint')}</p>
        ) : pausedUntil ? (
          <div className="mt-4 rounded-2xl bg-gray-50 p-4">
            <div className="rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3">
              {t(lang, 'onlinePausedUntil')} {formatTime(pausedUntil, lang)}
            </div>
            <p className="text-sm text-gray-500 mt-2">{t(lang, 'onlinePauseHint')}</p>
            <button
              className="btn-primary w-full h-12 mt-3"
              disabled={!canPause || busy}
              onClick={onResume}
            >
              {t(lang, 'onlineResume')}
            </button>
          </div>
        ) : (
          <div className="mt-4 rounded-2xl bg-gray-50 p-4">
            <div className="text-sm font-bold text-gray-500">{t(lang, 'onlinePauseTitle')}</div>
            <p className="text-sm text-gray-500 mt-1">{t(lang, 'onlinePauseHint')}</p>
            <div className="grid grid-cols-2 gap-2 mt-3">
              {PAUSE_PRESETS.map((p) => (
                <button
                  key={String(p.minutes)}
                  className="btn-secondary h-12"
                  disabled={!canPause || busy}
                  onClick={() => pauseFor(p.minutes)}
                >
                  {t(lang, p.label)}
                </button>
              ))}
            </div>
          </div>
        )}

        {enabled && (
          <div className="mt-3 rounded-2xl bg-gray-50 p-4">
            <div className="text-sm font-bold text-gray-500">{t(lang, 'onlinePrepTitle')}</div>
            <p className="text-sm text-gray-500 mt-1">{t(lang, 'onlinePrepHint')}</p>

            {/* Выкл — гасит обе границы; иначе — две строки вилки «от … до …» */}
            <div className="flex flex-wrap gap-2 mt-3">
              <PrepChip active={!prepMax} disabled={!canPause || busy} onClick={() => onPrep(0, 0)}>
                {t(lang, 'onlinePrepOff')}
              </PrepChip>
            </div>

            {prepMax > 0 && (
              <>
                <div className="text-xs font-semibold text-gray-500 mt-4 mb-2">{t(lang, 'onlinePrepFrom')}</div>
                <div className="flex flex-wrap gap-2">
                  {PREP_PRESETS.map((m) => (
                    <PrepChip
                      key={`min-${m}`}
                      active={prepMin === m}
                      disabled={!canPause || busy}
                      // Нижняя граница не может превышать верхнюю — тянем max за собой
                      onClick={() => onPrep(m, Math.max(m, prepMax))}
                    >
                      {m}
                    </PrepChip>
                  ))}
                </div>

                <div className="text-xs font-semibold text-gray-500 mt-4 mb-2">{t(lang, 'onlinePrepTo')}</div>
                <div className="flex flex-wrap gap-2">
                  {PREP_PRESETS.map((m) => (
                    <PrepChip
                      key={`max-${m}`}
                      active={prepMax === m}
                      disabled={!canPause || busy || m < prepMin}
                      onClick={() => onPrep(Math.min(prepMin, m), m)}
                    >
                      {m}
                    </PrepChip>
                  ))}
                </div>
              </>
            )}

            {/* Пока вилка выключена — быстрый старт с дефолта */}
            {!prepMax && (
              <div className="flex flex-wrap gap-2 mt-3">
                {PREP_PRESETS.map((m) => (
                  <PrepChip key={`start-${m}`} active={false} disabled={!canPause || busy} onClick={() => onPrep(m, m)}>
                    {m} {t(lang, 'minShort')}
                  </PrepChip>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PrepChip({ active, disabled, onClick, children }: {
  active: boolean
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-11 px-4 rounded-xl text-sm font-semibold tabular-nums transition-all active:scale-[0.96] disabled:opacity-40 ${
        active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
      }`}
    >
      {children}
    </button>
  )
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gray-500 shrink-0" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function DoneBadge({ o, lang }: { o: OnlineOrder; lang: 'ru' | 'he' }) {
  if (o.status === 'rejected') return <span className="badge-red">{t(lang, 'onlineRejected')}</span>
  const st = o.order?.status
  if (st === 'voided') return <span className="badge-gray">{t(lang, 'onlineCancelled')}</span>
  if (st === 'paid' || st === 'fulfilled') return <span className="badge-green">{t(lang, 'onlinePaid')}</span>
  return <span className="badge-blue">{t(lang, 'onlineAcceptedBadge')}</span>
}
