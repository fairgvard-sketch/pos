import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useLangStore } from '../../store/langStore'
import { useAuthStore } from '../../store/authStore'
import { t, formatTime, formatElapsed, type Lang } from '../../lib/i18n'
import { fetchTables } from '../tables/api'
import AppSidebar from '../../components/AppSidebar'
import {
  fetchReservations, acceptReservation, rejectReservation, setReservationTable,
  type Reservation,
} from './api'

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
  const qc = useQueryClient()

  const { data: reservations = [] } = useQuery({ queryKey: ['reservations'], queryFn: fetchReservations })
  const { data: tables = [] } = useQuery({ queryKey: ['tables'], queryFn: fetchTables })

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
  }

  // ── Подтвердить (пикер стола открыт) / сменить стол ──
  const [picking, setPicking] = useState<{ r: Reservation; mode: 'accept' | 'change' } | null>(null)
  const accept = useMutation({
    mutationFn: ({ r, tableId }: { r: Reservation; tableId: string | null }) =>
      acceptReservation(r.id, staff!.id, tableId),
    onSuccess: () => {
      setPicking(null)
      toast.success(t(lang, 'resAcceptedToast'))
      invalidateAll()
    },
    onError: (e) => toast.error((e as Error).message),
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
          <h1 className="text-xl font-bold text-gray-900">{t(lang, 'reservationsTitle')}</h1>
          {today.length > 0 && (
            <span className="badge-blue tabular-nums">{today.length} {t(lang, 'resTodayCount')}</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {reservations.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <p className="font-bold text-gray-900">{t(lang, 'resEmpty')}</p>
              <p className="text-sm text-gray-500 mt-1">{t(lang, 'resEmptyHint')}</p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-8">
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
                    className="text-sm font-bold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2"
                    onClick={() => setShowHistory((v) => !v)}
                  >
                    {t(lang, 'resSectionHistory')} · {history.length}
                    <span className="text-gray-400">{showHistory ? '▴' : '▾'}</span>
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
        {r.table && <span className="badge-blue shrink-0">{t(lang, 'tableLabel')} {r.table.label}</span>}
      </div>
      <div className="text-sm text-gray-500 mt-1">
        <a href={`tel:${r.customer_phone}`} dir="ltr" className="tabular-nums underline decoration-gray-300">
          {r.customer_phone}
        </a>
        {' '}· {agoText(r.created_at, nowTs, lang)}
      </div>
      {r.note && <div className="text-sm text-gray-700 mt-1">«{r.note}»</div>}
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

/** Подтверждённая бронь: стол можно сменить, бронь — отменить */
function ConfirmedCard({ r, lang, nowTs, rejecting, rejectReason, setRejectReason, rejectBusy, onStartReject, onCancelReject, onConfirmReject, onPickTable }: {
  r: Reservation; lang: Lang; nowTs: number
  rejecting: boolean; rejectReason: string; setRejectReason: (v: string) => void
  rejectBusy: boolean
  onStartReject: () => void; onCancelReject: () => void; onConfirmReject: () => void
  onPickTable: () => void
}) {
  return (
    <div className="card p-4">
      <ReservationHead r={r} lang={lang} nowTs={nowTs} />
      {rejecting ? (
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
