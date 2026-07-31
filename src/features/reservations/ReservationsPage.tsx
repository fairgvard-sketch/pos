import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { useAuthStore } from '../../store/authStore'
import { useCartStore } from '../../store/cartStore'
import { t, formatDate, formatTime, formatElapsed, type Lang } from '../../lib/i18n'
import { fetchTables } from '../tables/api'
import { fetchCurrentLocation } from '../auth/api'
import AppSidebar from '../../components/AppSidebar'
import {
  fetchReservations, fetchReservationHistory, acceptReservation, rejectReservation,
  setReservationTable, seatReservation, markReservationArrived,
  createReservation, fetchGuestHistory, type CreateReservationInput,
  type Reservation, type HistoryPeriod,
} from './api'
import TimelineView from './TimelineView'
import { TabSwitch, HistoryFilters } from '../../components/HistoryTabs'
import type { Table } from '../../types'

/**
 * Брони (053): заявки на бронирование стола с сайта. Новые —
 * подтвердить (опционально сразу назначив стол) / отклонить;
 * подтверждённые — сегодня/будущие, стол можно сменить; история —
 * отклонённые/отменённые/прошедшие. Realtime + бейдж в сайдбаре.
 */
export default function ReservationsPage() {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const staff = useAuthStore((s) => s.staff)
  const navigate = useNavigate()
  const cart = useCartStore()
  const qc = useQueryClient()

  const { data: reservations = [] } = useQuery({ queryKey: ['reservations'], queryFn: fetchReservations })
  const { data: tables = [] } = useQuery({ queryKey: ['tables'], queryFn: fetchTables })
  const { data: location } = useQuery({ queryKey: ['current_location'], queryFn: fetchCurrentLocation })

  // Ручная бронь (060): форма создания открыта
  const [creating, setCreating] = useState(false)

  // ── Вкладка «История» (113): прошедшие брони за период + поиск ──
  // Таймлайн — вид по умолчанию: хостес открывает экран, чтобы увидеть
  // зал, а не список. Список остаётся вторым видом, а не удаляется (плана
  // Phase 3, п.4): по нему удобно решать заявки и искать по имени.
  const [view, setView] = useState<'timeline' | 'list'>('timeline')
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const [period, setPeriod] = useState<HistoryPeriod>('today')
  const [search, setSearch] = useState('')
  // Ввод не дёргает сеть на каждую букву — запрос идёт по debounce
  const [searchQ, setSearchQ] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setSearchQ(search), 300)
    return () => clearTimeout(id)
  }, [search])

  const { data: pastRes = [], isFetching: pastLoading } = useQuery({
    queryKey: ['reservation_history', period, searchQ],
    queryFn: () => fetchReservationHistory(period, searchQ),
    enabled: tab === 'history',
    placeholderData: (prev) => prev,
  })

  // Realtime-подписки здесь нет: AppSidebar (смонтирован на этом экране)
  // уже подписан на reservations и инвалидирует ['reservations']

  // Тик раз в 30с — «5 мин назад» и границы секций живут без перезапросов
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['reservations'] })
    qc.invalidateQueries({ queryKey: ['reservations_today'] })
    // Таймлайн живёт на своём ключе: без этого действие из списка не
    // отражалось бы на полотне до перезагрузки.
    qc.invalidateQueries({ queryKey: ['reservation_timeline'] })
  }

  // ── Подтвердить (пикер стола открыт) / сменить стол ──
  const [picking, setPicking] = useState<{ r: Reservation; mode: 'accept' | 'change' } | null>(null)
  // Бронь, открытая тапом по блоку таймлайна
  const [detail, setDetail] = useState<Reservation | null>(null)
  const accept = useMutation({
    mutationFn: ({ r, tableId }: { r: Reservation; tableId: string | null }) =>
      acceptReservation(r.id, staff!.id, tableId),
    onSuccess: () => {
      setPicking(null)
      toast.success(t(lang, 'resAcceptedToast'))
      invalidateAll()
    },
    onError: (e) => {
      const m = (e as Error).message
      toast.error(m.includes('table_busy') ? t(lang, 'resSeatBusy') : m)
    },
  })
  const changeTable = useMutation({
    mutationFn: ({ r, tableId }: { r: Reservation; tableId: string | null }) =>
      setReservationTable(r.id, staff!.id, tableId),
    onSuccess: () => {
      setPicking(null)
      invalidateAll()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  // ── Посадить бронь за стол (057): открыть счёт стола → перейти в продажу ──
  const seat = useMutation({
    mutationFn: (r: Reservation) => seatReservation(r.id, staff!.id),
    onSuccess: (res, r) => {
      cart.clear()
      cart.setTableCtx({ tableId: r.table_id!, orderId: res.order_id, tableLabel: r.table?.label ?? '', existingTotal: res.total })
      navigate('/sell')
    },
    onError: (e) => {
      const m = (e as Error).message
      toast.error(m.includes('table_busy') ? t(lang, 'resSeatBusy') : m)
    },
  })

  // ── Гость сел (119): для точки без POS это и есть посадка ──
  const arrive = useMutation({
    mutationFn: (r: Reservation) => markReservationArrived(r.id, staff!.id),
    onSuccess: () => {
      toast.success(t(lang, 'rsvArrivedToast'))
      invalidateAll()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  // ── Отклонить / отменить бронь (двухшагово + необязательная причина) ──
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const reject = useMutation({
    mutationFn: (r: Reservation) => rejectReservation(r.id, staff!.id, rejectReason.trim() || undefined),
    onSuccess: () => {
      setRejecting(null)
      setRejectReason('')
      invalidateAll()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  // Секции: прошедшее = визит был больше 2 часов назад.
  // Будущие подтверждённые — группами по дню визита.
  const { fresh, today, futureByDay, history } = useMemo(() => {
    const passedTs = nowTs - 2 * 3600_000
    const now = new Date(nowTs)
    const isPast = (r: Reservation) => new Date(r.reserved_at).getTime() < passedTs
    const fresh = reservations.filter((r) => r.status === 'new' && !isPast(r))
    const today = reservations.filter(
      (r) => r.status === 'confirmed' && !isPast(r) && isSameDay(new Date(r.reserved_at), now)
    )
    const future = reservations.filter(
      (r) => r.status === 'confirmed' && !isPast(r) && !isSameDay(new Date(r.reserved_at), now)
    )
    const history = reservations
      .filter((r) => !fresh.includes(r) && !today.includes(r) && !future.includes(r))
      .sort((a, b) => b.reserved_at.localeCompare(a.reserved_at))
    const futureByDay = new Map<string, Reservation[]>()
    for (const r of future) {
      const key = dayLabel(r.reserved_at, lang)
      const list = futureByDay.get(key)
      if (list) list.push(r)
      else futureByDay.set(key, [r])
    }
    return { fresh, today, futureByDay, history }
  }, [reservations, nowTs, lang])
  const [showHistory, setShowHistory] = useState(false)

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="h-screen bg-[#eceef1] flex gap-3 p-3 overflow-hidden">
      <AppSidebar active="reservations" />

      <main className="flex-1 min-w-0 bg-white rounded-3xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-gray-900">{t(lang, 'reservationsTitle')}</h1>
            {tab === 'active' && (
              <div className="flex rounded-xl border border-gray-200 p-0.5">
                {(['timeline', 'list'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    className={`h-9 px-3 rounded-lg text-sm font-semibold transition-colors ${
                      view === v ? 'bg-gray-900 text-white' : 'text-gray-600'
                    }`}
                  >
                    {t(lang, v === 'timeline' ? 'rsvTimeline' : 'rsvListView')}
                  </button>
                ))}
              </div>
            )}
            <TabSwitch
              value={tab}
              onChange={setTab}
              activeLabel={t(lang, 'tabActive')}
              historyLabel={t(lang, 'tabHistory')}
            />
            {tab === 'active' && today.length > 0 && (
              <span className="badge-blue tabular-nums">{today.length} {t(lang, 'resTodayCount')}</span>
            )}
          </div>
          <button className="btn-primary !py-2.5 !px-5" onClick={() => setCreating(true)}>
            {t(lang, 'resNewBooking')}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'history' ? (
            <>
              <HistoryFilters
                lang={lang} period={period} onPeriod={setPeriod}
                search={search} onSearch={setSearch}
              />
              {pastRes.length === 0 ? (
                <p className="text-sm text-gray-500 text-center pt-12">
                  {pastLoading ? t(lang, 'loading') : t(lang, 'historyEmpty')}
                </p>
              ) : (
                <div className="space-y-2 max-w-3xl">
                  {pastRes.map((r) => (
                    <div key={r.id} className="card p-4 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-bold tabular-nums text-gray-900">
                            {formatDate(r.reserved_at, lang)}
                          </span>
                          <span className="text-sm font-semibold text-gray-900 truncate">{r.customer_name}</span>
                          {r.customer_phone && (
                            <span className="text-xs text-gray-500 tabular-nums" dir="ltr">{r.customer_phone}</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {r.party_size} {t(lang, 'resGuestsShort')}
                          {r.table ? ` · ${t(lang, 'tableLabel')} ${r.table.label}` : ''}
                          {r.reject_reason ? ` · ${r.reject_reason}` : ''}
                        </div>
                      </div>
                      <HistoryBadge r={r} lang={lang} />
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : view === 'timeline' ? (
            <TimelineView
              lang={lang}
              isRtl={isRtl}
              tables={tables}
              settings={(location?.settings as { reservations?: unknown }) ?? null}
              tz={location?.timezone || 'Asia/Jerusalem'}
              onOpen={setDetail}
            />
          ) : reservations.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <p className="font-bold text-gray-900">{t(lang, 'resEmpty')}</p>
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'resEmptyHint')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-6 items-start">
              {fresh.length > 0 && (
                <Section title={t(lang, 'resSectionNew')}>
                  {fresh.map((r) => (
                    <div key={r.id} className="card p-4 border-2 border-gray-900">
                      <ReservationHead r={r} lang={lang} nowTs={nowTs} showDay />
                      {rejecting === r.id ? (
                        <RejectForm
                          lang={lang}
                          reason={rejectReason}
                          setReason={setRejectReason}
                          busy={reject.isPending}
                          onCancel={() => { setRejecting(null); setRejectReason('') }}
                          onConfirm={() => reject.mutate(r)}
                        />
                      ) : (
                        <div className="flex gap-2 mt-3">
                          <button className="btn-secondary h-12 px-6" onClick={() => setRejecting(r.id)}>
                            {t(lang, 'resReject')}
                          </button>
                          <button className="btn-primary flex-1 h-12" onClick={() => setPicking({ r, mode: 'accept' })}>
                            {t(lang, 'resAccept')}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </Section>
              )}

              {today.length > 0 && (
                <Section title={t(lang, 'resSectionToday')}>
                  {today.map((r) => (
                    <ConfirmedCard
                      key={r.id} r={r} lang={lang} nowTs={nowTs}
                      rejecting={rejecting === r.id}
                      rejectReason={rejectReason} setRejectReason={setRejectReason}
                      rejectBusy={reject.isPending}
                      onStartReject={() => setRejecting(r.id)}
                      onCancelReject={() => { setRejecting(null); setRejectReason('') }}
                      onConfirmReject={() => reject.mutate(r)}
                      onPickTable={() => setPicking({ r, mode: 'change' })}
                      onSeat={() => seat.mutate(r)}
                      seatBusy={seat.isPending}
                    />
                  ))}
                </Section>
              )}

              {[...futureByDay.entries()].map(([day, list]) => (
                <Section key={day} title={`${t(lang, 'resSectionFuture')} · ${day}`}>
                  {list.map((r) => (
                    <ConfirmedCard
                      key={r.id} r={r} lang={lang} nowTs={nowTs}
                      rejecting={rejecting === r.id}
                      rejectReason={rejectReason} setRejectReason={setRejectReason}
                      rejectBusy={reject.isPending}
                      onStartReject={() => setRejecting(r.id)}
                      onCancelReject={() => { setRejecting(null); setRejectReason('') }}
                      onConfirmReject={() => reject.mutate(r)}
                      onPickTable={() => setPicking({ r, mode: 'change' })}
                    />
                  ))}
                </Section>
              ))}

              {history.length > 0 && (
                <section>
                  <button
                    className="min-h-11 text-sm font-bold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2"
                    onClick={() => setShowHistory((v) => !v)}
                  >
                    {t(lang, 'resSectionHistory')} · {history.length}
                    <span className="text-gray-500">{showHistory ? '▴' : '▾'}</span>
                  </button>
                  {showHistory && (
                    <div className="space-y-3">
                      {history.map((r) => (
                        <div key={r.id} className="card p-4 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <span className="font-bold tabular-nums text-gray-900">
                                {dayLabel(r.reserved_at, lang)} {formatTime(r.reserved_at, lang)}
                              </span>
                              <span className="text-sm font-semibold text-gray-900 truncate">{r.customer_name}</span>
                              <span className="text-xs text-gray-500 tabular-nums">{r.party_size} {t(lang, 'resGuestsShort')}</span>
                            </div>
                            {r.reject_reason && <div className="text-xs text-gray-500 mt-1">{r.reject_reason}</div>}
                          </div>
                          <HistoryBadge r={r} lang={lang} />
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </main>

      {picking && (
        <TablePickerSheet
          lang={lang}
          reservation={picking.r}
          mode={picking.mode}
          tables={tables}
          reservations={reservations}
          busy={accept.isPending || changeTable.isPending}
          onPick={(tableId) => {
            if (picking.mode === 'accept') accept.mutate({ r: picking.r, tableId })
            else changeTable.mutate({ r: picking.r, tableId })
          }}
          onClose={() => setPicking(null)}
        />
      )}

      {detail && staff && (
        <BookingActionsSheet
          lang={lang}
          r={detail}
          busy={accept.isPending || seat.isPending || reject.isPending || arrive.isPending}
          onClose={() => setDetail(null)}
          onAccept={() => { setDetail(null); setPicking({ r: detail, mode: 'accept' }) }}
          onTables={() => { setDetail(null); setPicking({ r: detail, mode: 'change' }) }}
          onArrive={() => { arrive.mutate(detail); setDetail(null) }}
          onSeat={() => { seat.mutate(detail); setDetail(null) }}
          onReject={() => { setDetail(null); setRejecting(detail.id) }}
        />
      )}

      {creating && location && staff && (
        <NewReservationSheet
          lang={lang}
          locationId={location.id}
          staffId={staff.id}
          tables={tables}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            toast.success(t(lang, 'resCreatedToast'))
            invalidateAll()
          }}
        />
      )}
    </div>
  )
}

/** Форма ручной брони (060): телефонный звонок → бронь сразу «Подтверждена» */

/**
 * Действия над бронью, открытой с таймлайна. Набор зависит от состояния:
 * заявку сперва подтверждают, подтверждённую — сажают. «Посадить» с
 * открытием счёта показывается только там, где счёт есть, то есть при
 * POS; без него остаётся отметка «гость сел» (119).
 */
function BookingActionsSheet({
  lang, r, busy, onClose, onAccept, onTables, onArrive, onSeat, onReject,
}: {
  lang: Lang
  r: Reservation
  busy: boolean
  onClose: () => void
  onAccept: () => void
  onTables: () => void
  onArrive: () => void
  onSeat: () => void
  onReject: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const seated = r.arrived_at != null || r.order_id != null
  const actions: { label: string; onClick: () => void; primary?: boolean; danger?: boolean }[] = []

  if (r.status === 'new') {
    actions.push({ label: t(lang, 'resAccept'), onClick: onAccept, primary: true })
  } else if (r.status === 'confirmed') {
    if (!seated) {
      actions.push({ label: t(lang, 'rsvMarkArrived'), onClick: onArrive, primary: true })
      if (r.table_id) actions.push({ label: t(lang, 'resSeatGuest'), onClick: onSeat })
    }
    actions.push({ label: t(lang, 'resPickTable'), onClick: onTables })
  }
  if (r.status === 'new' || r.status === 'confirmed') {
    actions.push({ label: t(lang, 'resReject'), onClick: onReject, danger: true })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={r.customer_name}
    >
      <div
        className="w-full max-w-lg rounded-t-3xl bg-white px-4 pt-3 pb-6 shadow-xl text-start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-200" aria-hidden />
        <div className="px-1">
          <p className="text-lg font-bold text-gray-900">{r.customer_name}</p>
          <p className="text-sm text-gray-500 mt-0.5">
            {formatTime(r.reserved_at, lang)} · {r.party_size} {t(lang, 'resGuestsShort')}
            {r.zone && ` · ${r.zone.name}`}
            {r.table && ` · ${t(lang, 'tableLabel')} ${r.table.label}`}
          </p>
          {r.customer_phone && (
            <a href={`tel:${r.customer_phone}`} className="text-sm text-gray-500 tabular-nums" dir="ltr">
              {r.customer_phone}
            </a>
          )}
          {r.note && <p className="text-sm text-gray-700 mt-2">{r.note}</p>}
        </div>

        <div className="flex flex-col gap-2 mt-4">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={busy}
              onClick={a.onClick}
              className={`h-12 rounded-xl text-sm font-bold active:scale-[0.98] transition-all disabled:opacity-40 ${
                a.primary
                  ? 'bg-gray-900 text-white'
                  : a.danger
                    ? 'bg-red-50 text-red-700'
                    : 'border border-gray-300 text-gray-900'
              }`}
            >
              {a.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onClose}
            className="h-12 rounded-xl bg-gray-100 text-sm font-semibold text-gray-700"
          >
            {t(lang, 'close')}
          </button>
        </div>
      </div>
    </div>
  )
}

function NewReservationSheet({ lang, locationId, staffId, tables, onClose, onCreated }: {
  lang: Lang
  locationId: string
  staffId: string
  tables: Table[]
  onClose: () => void
  onCreated: () => void
}) {
  const isRtl = lang === 'he'
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [dateStr, setDateStr] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [timeStr, setTimeStr] = useState('19:00')
  const [guests, setGuests] = useState(2)
  const [tableId, setTableId] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const create = useMutation({
    mutationFn: () => {
      const reservedAt = new Date(`${dateStr}T${timeStr}:00`)
      const input: CreateReservationInput = {
        name: name.trim(),
        phone: phone.trim(),
        partySize: guests,
        reservedAt: reservedAt.toISOString(),
        note: note.trim() || null,
        tableId,
      }
      return createReservation(locationId, staffId, input)
    },
    onSuccess: onCreated,
    onError: (e) => toast.error((e as Error).message),
  })

  function submit() {
    if (!name.trim()) { toast.error(t(lang, 'resNeedName')); return }
    if (!dateStr || !timeStr) { toast.error(t(lang, 'resNeedTime')); return }
    if (Number.isNaN(new Date(`${dateStr}T${timeStr}:00`).getTime())) { toast.error(t(lang, 'resNeedTime')); return }
    create.mutate()
  }

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="card w-full max-w-md p-6 animate-[rise-in_0.2s_ease-out] max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-black text-gray-900 mb-4">{t(lang, 'resNewBooking')}</h2>

        <div className="space-y-4">
          <Field label={t(lang, 'resGuestName')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label={t(lang, 'resPhoneLabel')}>
            <input type="tel" inputMode="tel" dir="ltr" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t(lang, 'resDate')}>
              <input type="date" className="input" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
            </Field>
            <Field label={t(lang, 'resTimeLabel')}>
              <input type="time" className="input" value={timeStr} onChange={(e) => setTimeStr(e.target.value)} />
            </Field>
          </div>
          <Field label={t(lang, 'resPartySize')}>
            <div className="flex items-center gap-3">
              <button onClick={() => setGuests((g) => Math.max(1, g - 1))} className="w-11 h-11 rounded-xl border border-gray-200 text-xl font-bold text-gray-700 hover:border-gray-400 active:scale-[0.95]">−</button>
              <span className="text-lg font-black text-gray-900 tabular-nums w-8 text-center">{guests}</span>
              <button onClick={() => setGuests((g) => Math.min(20, g + 1))} className="w-11 h-11 rounded-xl border border-gray-200 text-xl font-bold text-gray-700 hover:border-gray-400 active:scale-[0.95]">+</button>
            </div>
          </Field>
          <Field label={t(lang, 'resTable')}>
            <select className="input" value={tableId ?? ''} onChange={(e) => setTableId(e.target.value || null)}>
              <option value="">{t(lang, 'resNoTable')}</option>
              {tables.map((tb) => (
                <option key={tb.id} value={tb.id}>{tb.label}{tb.zone ? ` · ${tb.zone}` : ''}</option>
              ))}
            </select>
          </Field>
          <Field label={t(lang, 'resNote')}>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>

        <div className="flex gap-2 mt-6">
          <button onClick={onClose} className="btn-ghost flex-1">{t(lang, 'cancel')}</button>
          <button onClick={submit} disabled={create.isPending} className="btn-primary flex-1 disabled:opacity-50">{t(lang, 'save')}</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-500 mb-1.5">{label}</span>
      {children}
    </label>
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

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** «пт, 18 июл.» — короткая дата дня визита */
function dayLabel(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleDateString(lang === 'he' ? 'he-IL' : 'ru-RU', {
    weekday: 'short', day: 'numeric', month: 'short',
  })
}

/** «5 мин назад»; «только что» — без хвоста «назад» */
function agoText(iso: string, nowTs: number, lang: Lang): string {
  const s = formatElapsed(iso, nowTs, lang)
  return s === t(lang, 'justNow') ? s : `${s} ${t(lang, 'ago')}`
}

/** Шапка карточки: время визита крупно, имя, телефон, гости, комментарий */
function ReservationHead({ r, lang, nowTs, showDay }: {
  r: Reservation; lang: Lang; nowTs: number; showDay?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xl font-black tabular-nums text-gray-900">
          {showDay && !isSameDay(new Date(r.reserved_at), new Date(nowTs)) && `${dayLabel(r.reserved_at, lang)} `}
          {formatTime(r.reserved_at, lang)}
        </span>
        <span className="font-bold text-gray-900 truncate">{r.customer_name}</span>
        <span className="badge-gray tabular-nums shrink-0">{r.party_size} {t(lang, 'resGuestsShort')}</span>
        {r.zone && <span className="badge-gray shrink-0">{r.zone.name}</span>}
        {r.table && <span className="badge-blue shrink-0">{t(lang, 'tableLabel')} {r.table.label}</span>}
        {r.auto && <span className="badge-gray shrink-0">{t(lang, 'resAutoBadge')}</span>}
      </div>
      <div className="text-sm text-gray-500 mt-1">
        <a href={`tel:${r.customer_phone}`} dir="ltr" className="tabular-nums underline decoration-gray-300">
          {r.customer_phone}
        </a>
        {' '}· {agoText(r.created_at, nowTs, lang)}
      </div>
      <GuestBadge phone={r.customer_phone} currentId={r.id} lang={lang} />
      {r.note && <div className="text-sm text-gray-700 mt-1">«{r.note}»</div>}
    </div>
  )
}

/**
 * CRM-подсказка о госте (063): подтягивает историю по телефону. Показывает
 * «постоянный гость · N визитов», при отменах — «×N отмен». Тихо молчит,
 * если истории нет или это первый визит (не засоряет карточку).
 */
function GuestBadge({ phone, currentId, lang }: { phone: string; currentId: string; lang: Lang }) {
  const { data } = useQuery({
    queryKey: ['guest_history', phone],
    queryFn: () => fetchGuestHistory(phone),
    enabled: phone.replace(/\D/g, '').length >= 6,
    staleTime: 60_000,
  })
  if (!data) return null
  // Прошлые визиты = подтверждённые брони помимо текущей. Текущая может уже
  // быть confirmed и попасть в счётчик — вычитаем её, показываем только «до».
  const priorVisits = Math.max(0, data.visits - (currentId ? 1 : 0))
  const returning = priorVisits >= 1
  const hasCancels = data.cancelled >= 1
  // 121: неявки, метки и заметка о госте — контекст, ради которого хостес
  // раньше уходил в базу клиентов отдельным действием.
  const noShows = data.no_shows ?? 0
  const tags = data.tags ?? []
  const note = data.guest_note?.trim()
  if (!returning && !hasCancels && noShows === 0 && tags.length === 0 && !note) return null
  return (
    <div className="mt-1 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        {returning && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 text-green-700 px-2 py-0.5 font-semibold">
            {t(lang, 'resGuestReturning')} · {priorVisits} {t(lang, 'resGuestVisits')}
          </span>
        )}
        {hasCancels && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 text-amber-700 px-2 py-0.5 font-semibold tabular-nums">
            ×{data.cancelled} {t(lang, 'resGuestCancels')}
          </span>
        )}
        {noShows > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 text-red-700 px-2 py-0.5 font-semibold tabular-nums">
            ×{noShows} {t(lang, 'resGuestNoShows')}
          </span>
        )}
        {tags.map((tag) => (
          <span key={tag} className="inline-flex items-center rounded-full bg-gray-100 text-gray-700 px-2 py-0.5 font-semibold">
            {tag}
          </span>
        ))}
      </div>
      {note && <p className="text-gray-600 mt-1">{note}</p>}
    </div>
  )
}

function RejectForm({ lang, reason, setReason, busy, onCancel, onConfirm }: {
  lang: Lang; reason: string; setReason: (v: string) => void
  busy: boolean; onCancel: () => void; onConfirm: () => void
}) {
  return (
    <div className="mt-3 space-y-2">
      <input
        className="input w-full"
        placeholder={t(lang, 'resRejectReasonPh')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        autoFocus
      />
      <div className="flex gap-2">
        <button className="btn-secondary flex-1 h-11" onClick={onCancel}>
          {t(lang, 'cancel')}
        </button>
        <button className="btn-danger flex-1 h-11" disabled={busy} onClick={onConfirm}>
          {t(lang, 'resRejectConfirm')}
        </button>
      </div>
    </div>
  )
}

/** Подтверждённая бронь: стол можно сменить, бронь — отменить, гостя — посадить */
function ConfirmedCard({ r, lang, nowTs, rejecting, rejectReason, setRejectReason, rejectBusy, onStartReject, onCancelReject, onConfirmReject, onPickTable, onSeat, seatBusy }: {
  r: Reservation; lang: Lang; nowTs: number
  rejecting: boolean; rejectReason: string; setRejectReason: (v: string) => void
  rejectBusy: boolean
  onStartReject: () => void; onCancelReject: () => void; onConfirmReject: () => void
  onPickTable: () => void
  /** Посадить гостя (только для секции «сегодня»); undefined — кнопки нет */
  onSeat?: () => void
  seatBusy?: boolean
}) {
  return (
    <div className="card p-4">
      <ReservationHead r={r} lang={lang} nowTs={nowTs} />
      {r.order_id ? (
        // Посажены (057): счётом дальше управляют из зала
        <div className="mt-3">
          <span className="badge-green">{t(lang, 'resSeatedBadge')}</span>
        </div>
      ) : rejecting ? (
        <RejectForm
          lang={lang}
          reason={rejectReason}
          setReason={setRejectReason}
          busy={rejectBusy}
          onCancel={onCancelReject}
          onConfirm={onConfirmReject}
        />
      ) : (
        <div className="flex gap-2 mt-3">
          <button className="btn-secondary h-11 px-5" onClick={onStartReject}>
            {t(lang, 'resCancelBooking')}
          </button>
          <button className="btn-secondary h-11 px-5" onClick={onPickTable}>
            {r.table ? `${t(lang, 'tableLabel')} ${r.table.label}` : t(lang, 'resPickTable')}
          </button>
          {onSeat && r.table && (
            <button className="btn-primary flex-1 h-11" disabled={seatBusy} onClick={onSeat}>
              {t(lang, 'resSeatGuest')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function HistoryBadge({ r, lang }: { r: Reservation; lang: Lang }) {
  if (r.status === 'rejected') return <span className="badge-red">{t(lang, 'resRejectedBadge')}</span>
  if (r.status === 'cancelled') return <span className="badge-gray">{t(lang, 'resCancelledBadge')}</span>
  if (r.status === 'confirmed') return <span className="badge-green">{t(lang, 'resConfirmedBadge')}</span>
  return <span className="badge-gray">{t(lang, 'resExpiredBadge')}</span>
}

/**
 * Пикер стола: сетка по зонам, «Без стола» первой строкой (accept)
 * или «Снять стол» (change). Столы с другой confirmed-бронью в ±2ч
 * от времени этой заявки помечены временем — подсказка, не блокировка.
 */
function TablePickerSheet({ lang, reservation, mode, tables, reservations, busy, onPick, onClose }: {
  lang: Lang
  reservation: Reservation
  mode: 'accept' | 'change'
  tables: { id: string; label: string; zone: string | null }[]
  reservations: Reservation[]
  busy: boolean
  onPick: (tableId: string | null) => void
  onClose: () => void
}) {
  const isRtl = lang === 'he'
  const targetTs = new Date(reservation.reserved_at).getTime()

  // Столы с другой подтверждённой бронью в ±2ч — время ближайшего конфликта
  const conflictByTable = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of reservations) {
      if (r.id === reservation.id || r.status !== 'confirmed' || !r.table_id) continue
      if (Math.abs(new Date(r.reserved_at).getTime() - targetTs) <= 2 * 3600_000) {
        if (!map.has(r.table_id)) map.set(r.table_id, formatTime(r.reserved_at, lang))
      }
    }
    return map
  }, [reservations, reservation.id, targetTs, lang])

  // Группировка по зонам (столы без зоны — общая группа «Зал»)
  const zones = useMemo(() => {
    const map = new Map<string, typeof tables>()
    for (const tb of tables) {
      const key = tb.zone || t(lang, 'hall')
      const list = map.get(key)
      if (list) list.push(tb)
      else map.set(key, [tb])
    }
    return map
  }, [tables, lang])

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-t-3xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 shrink-0">
          <h2 className="font-bold text-gray-900">
            {mode === 'accept' ? t(lang, 'resAcceptPickTitle') : t(lang, 'resPickTable')}
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {formatTime(reservation.reserved_at, lang)} · {reservation.customer_name} · {reservation.party_size} {t(lang, 'resGuestsShort')}
            {/* Пожелание зоны от гостя (072) — подсказка, не ограничение */}
            {reservation.zone && <> · <span className="font-semibold text-gray-900">{reservation.zone.name}</span></>}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <button
            className="btn-secondary w-full h-12"
            disabled={busy}
            onClick={() => onPick(null)}
          >
            {mode === 'accept' ? t(lang, 'resNoTable') : t(lang, 'resClearTable')}
          </button>

          {[...zones.entries()].map(([zone, list]) => (
            <div key={zone}>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">{zone}</div>
              <div className="grid grid-cols-4 gap-2">
                {list.map((tb) => {
                  const conflict = conflictByTable.get(tb.id)
                  const current = reservation.table_id === tb.id
                  return (
                    <button
                      key={tb.id}
                      disabled={busy}
                      onClick={() => onPick(tb.id)}
                      className={`h-14 rounded-xl border text-sm font-semibold active:scale-[0.97] transition-colors ${
                        current
                          ? 'border-gray-900 bg-gray-900 text-white'
                          : 'border-gray-200 bg-white text-gray-900 hover:bg-gray-50'
                      }`}
                    >
                      <span className="block truncate px-1">{tb.label}</span>
                      {conflict && (
                        <span className={`block text-xs tabular-nums ${current ? 'text-gray-300' : 'text-blue-600'}`}>
                          {conflict}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-gray-100 shrink-0">
          <button className="btn-secondary w-full h-11" onClick={onClose}>{t(lang, 'cancel')}</button>
        </div>
      </div>
    </div>
  )
}
