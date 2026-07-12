import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  createReservation,
  updateReservation,
  setReservationStatus,
  seatReservation,
  fetchReservationsForDay,
  type ReservationInput,
} from './api'
import { useAuthStore } from '../../store/authStore'
import { useCartStore } from '../../store/cartStore'
import { useLangStore } from '../../store/langStore'
import { t, formatTime } from '../../lib/i18n'
import type { LocationSettings, Reservation, ReservationStatus, Table } from '../../types'

interface Props {
  /** null — создание новой брони */
  reservation: Reservation | null
  /** Дата, выбранная в книге — дефолт для новой брони */
  defaultDate: string
  tables: Table[]
  busyTableIds: Set<string>
  /** Настройки броней точки: часы приёма, дефолтная длительность */
  resConfig?: LocationSettings['reservations']
  onClose: () => void
  onSaved: () => void
}

const DURATIONS = [60, 90, 120, 150]

/** Статусы, которые «держат» стол (для проверки пересечений) */
const ACTIVE_STATUSES = new Set<ReservationStatus>(['requested', 'confirmed', 'seated'])

/** 'HH:MM' → минуты от полуночи (для сравнения с часами приёма); null если не распарсить */
function minutesOfDay(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

type Screen = 'form' | 'detail' | 'seat'

export default function ReservationSheet({ reservation, defaultDate, tables, busyTableIds, resConfig, onClose, onSaved }: Props) {
  const lang = useLangStore((s) => s.lang)
  const isRtl = lang === 'he'
  const navigate = useNavigate()
  const staff = useAuthStore((s) => s.staff)
  const cart = useCartStore()

  const [screen, setScreen] = useState<Screen>(reservation ? 'detail' : 'form')

  // ── Форма ──
  const init = reservation ? new Date(reservation.reserved_at) : null
  const [name, setName] = useState(reservation?.customer_name ?? '')
  const [phone, setPhone] = useState(reservation?.customer_phone ?? '')
  const [dateStr, setDateStr] = useState(init ? toDateStr(init) : defaultDate)
  const [timeStr, setTimeStr] = useState(
    init ? `${pad(init.getHours())}:${pad(init.getMinutes())}` : resConfig?.open || '12:00',
  )
  const [partySize, setPartySize] = useState(reservation?.party_size ?? 2)
  const [durationMin, setDurationMin] = useState(
    reservation?.duration_min ?? resConfig?.default_duration_min ?? 90,
  )
  const [tableId, setTableId] = useState<string | null>(reservation?.table_id ?? null)
  const [note, setNote] = useState(reservation?.note ?? '')
  const [tags, setTags] = useState<string[]>(reservation?.tags ?? [])

  const tagPresets = lang === 'he' ? ['VIP', 'יום הולדת', 'אלרגיה'] : ['VIP', 'День рождения', 'Аллергия']
  const toggleTag = (tg: string) => setTags((prev) => (prev.includes(tg) ? prev.filter((x) => x !== tg) : [...prev, tg]))

  // ── Доступность столов на выбранное время (защита от овербукинга, фаза B) ──
  // Брони выбранного дня → какие столы заняты в окне [start, start+duration).
  const { data: dayReservations = [] } = useQuery({
    queryKey: ['reservations', dateStr],
    queryFn: () => fetchReservationsForDay(dateStr),
    enabled: screen === 'form',
  })

  const startMs = new Date(`${dateStr}T${timeStr}:00`).getTime()
  const endMs = Number.isNaN(startMs) ? NaN : startMs + durationMin * 60_000

  // table_id → пересекающаяся бронь (первая по времени). Себя исключаем.
  const bookedTables = useMemo(() => {
    const m = new Map<string, Reservation>()
    if (Number.isNaN(startMs)) return m
    for (const r of dayReservations) {
      if (!r.table_id || (reservation && r.id === reservation.id)) continue
      if (!ACTIVE_STATUSES.has(r.status)) continue
      const rStart = Date.parse(r.reserved_at)
      const rEnd = rStart + r.duration_min * 60_000
      if (startMs < rEnd && rStart < endMs && !m.has(r.table_id)) m.set(r.table_id, r)
    }
    return m
  }, [dayReservations, startMs, endMs, reservation])

  // Мягкое предупреждение: время вне часов приёма (не блокирует сохранение)
  const outsideHours = (() => {
    const openM = resConfig?.open ? minutesOfDay(resConfig.open) : null
    const closeM = resConfig?.close ? minutesOfDay(resConfig.close) : null
    const tM = minutesOfDay(timeStr)
    if (tM === null || openM === null || closeM === null) return false
    return openM <= closeM ? tM < openM || tM > closeM : tM < openM && tM > closeM
  })()

  function buildInput(): ReservationInput | null {
    if (!name.trim()) { toast.error(t(lang, 'resNeedName')); return null }
    if (!dateStr || !timeStr) { toast.error(t(lang, 'resNeedTime')); return null }
    const reservedAt = new Date(`${dateStr}T${timeStr}:00`)
    if (isNaN(reservedAt.getTime())) { toast.error(t(lang, 'resNeedTime')); return null }
    if (tableId && bookedTables.has(tableId)) { toast.error(t(lang, 'resOverlap')); return null }
    return {
      reservedAt: reservedAt.toISOString(),
      durationMin,
      partySize,
      customerName: name.trim(),
      customerPhone: phone.trim() || null,
      note: note.trim() || null,
      tableId,
      tags,
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const input = buildInput()
      if (!input) throw new Error('invalid')
      if (reservation) await updateReservation(reservation.id, input)
      else await createReservation(input, staff!.id)
    },
    onSuccess: () => { toast.success(t(lang, 'resSaved')); onSaved() },
    onError: (e) => {
      const m = (e as Error).message
      if (m === 'invalid') return
      toast.error(m === 'overlap' ? t(lang, 'resOverlap') : m)
    },
  })

  const status = useMutation({
    mutationFn: (s: ReservationStatus) => setReservationStatus(reservation!.id, s),
    onSuccess: (_d, s) => {
      if (s === 'cancelled') toast.success(t(lang, 'resCancelled'))
      onSaved()
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const seat = useMutation({
    mutationFn: (pickTableId: string) => seatReservation(reservation!.id, staff!.id, pickTableId),
    onSuccess: (res, pickTableId) => {
      const label = tables.find((tb) => tb.id === pickTableId)?.label ?? ''
      toast.success(t(lang, 'resSeated'))
      cart.clear()
      cart.setTableCtx({ tableId: pickTableId, orderId: res.order_id, tableLabel: label, existingTotal: res.total })
      navigate('/sell')
    },
    onError: (e) => {
      const m = (e as Error).message
      toast.error(m === 'table_busy' ? t(lang, 'resTableBusy') : m)
    },
  })

  const freeTables = tables.filter((tb) => !busyTableIds.has(tb.id))
  const busy = save.isPending || status.isPending || seat.isPending

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="card w-full max-w-md p-6 animate-[rise-in_0.2s_ease-out] max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>

        {/* ── Детали существующей брони ── */}
        {screen === 'detail' && reservation && (
          <div>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <h2 className="text-xl font-black text-gray-900 truncate">{reservation.customer_name}</h2>
              <span className="text-lg font-black text-gray-900 tabular-nums shrink-0">{formatTime(reservation.reserved_at, lang)}</span>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              {reservation.party_size} {t(lang, 'resPartySize').toLowerCase()}
              {reservation.table_id && <> · {t(lang, 'resTable')} {tables.find((tb) => tb.id === reservation.table_id)?.label ?? '—'}</>}
              {reservation.customer_phone && <> · {reservation.customer_phone}</>}
            </p>
            {reservation.note && <p className="text-sm text-gray-700 bg-gray-50 rounded-xl p-3 mb-4">{reservation.note}</p>}
            {reservation.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-4">
                {reservation.tags.map((tg) => (
                  <span key={tg} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-900 text-white">{tg}</span>
                ))}
              </div>
            )}

            <div className="space-y-2">
              {reservation.status === 'requested' && (
                <BigButton primary label={t(lang, 'resConfirm')} disabled={busy} onClick={() => status.mutate('confirmed')} />
              )}
              {(reservation.status === 'confirmed' || reservation.status === 'requested') && (
                <BigButton primary={reservation.status === 'confirmed'} label={t(lang, 'resSeat')} disabled={busy}
                  onClick={() => setScreen('seat')} />
              )}
              {reservation.status === 'seated' && (
                <BigButton primary label={t(lang, 'resComplete')} disabled={busy} onClick={() => status.mutate('completed')} />
              )}
              {(reservation.status === 'requested' || reservation.status === 'confirmed') && (
                <>
                  <BigButton label={t(lang, 'resNoShow')} disabled={busy} onClick={() => status.mutate('no_show')} />
                  <BigButton label={t(lang, 'reservationEdit')} disabled={busy} onClick={() => setScreen('form')} />
                  <BigButton danger label={t(lang, 'resCancelBooking')} disabled={busy}
                    onClick={() => { if (confirm(t(lang, 'resConfirmCancel'))) status.mutate('cancelled') }} />
                </>
              )}
            </div>

            <button onClick={onClose} className="btn-ghost w-full mt-3">{t(lang, 'back')}</button>
          </div>
        )}

        {/* ── Форма создания/правки ── */}
        {screen === 'form' && (
          <div>
            <h2 className="text-lg font-black text-gray-900 mb-4">
              {reservation ? t(lang, 'reservationEdit') : t(lang, 'reservationNew')}
            </h2>

            <div className="space-y-4">
              <Field label={t(lang, 'resGuestName')}>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label={t(lang, 'resDate')}>
                  <input type="date" className="input" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
                </Field>
                <Field label={t(lang, 'resTime')}>
                  <input type="time" className="input" value={timeStr} onChange={(e) => setTimeStr(e.target.value)} />
                  {outsideHours && <span className="block text-[11px] text-amber-600 mt-1">{t(lang, 'resOutsideHours')}</span>}
                </Field>
              </div>

              <Field label={t(lang, 'resPartySize')}>
                <Stepper value={partySize} min={1} max={30} onChange={setPartySize} />
              </Field>

              <Field label={t(lang, 'resDuration')}>
                <div className="flex gap-2">
                  {DURATIONS.map((d) => (
                    <button
                      key={d}
                      onClick={() => setDurationMin(d)}
                      className={`h-11 flex-1 rounded-xl border text-sm font-semibold tabular-nums transition-colors ${
                        durationMin === d ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-700 hover:border-gray-400'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={t(lang, 'resTable')}>
                <button
                  onClick={() => setTableId(null)}
                  className={`w-full h-11 mb-2 rounded-xl border text-sm font-semibold transition-colors ${
                    tableId === null ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-700 hover:border-gray-400'
                  }`}
                >
                  {t(lang, 'resTableAny')}
                </button>
                <div className="grid grid-cols-4 gap-2">
                  {tables.map((tb) => {
                    const conflict = bookedTables.get(tb.id)
                    const selected = tableId === tb.id
                    return (
                      <button
                        key={tb.id}
                        disabled={!!conflict}
                        onClick={() => setTableId(tb.id)}
                        className={`h-14 rounded-xl border flex flex-col items-center justify-center gap-0.5 transition-all disabled:cursor-not-allowed ${
                          selected
                            ? 'border-gray-900 bg-gray-900 text-white'
                            : conflict
                              ? 'border-gray-200 bg-gray-50 text-gray-400'
                              : 'border-gray-200 text-gray-900 hover:border-gray-400 active:scale-[0.97]'
                        }`}
                      >
                        <span className="text-sm font-black tabular-nums leading-none">{tb.label}</span>
                        {conflict && (
                          <span className="text-[9px] font-semibold leading-none tabular-nums">{formatTime(conflict.reserved_at, lang)}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </Field>

              <Field label={t(lang, 'resPhone')}>
                <input type="tel" inputMode="tel" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>

              <Field label={t(lang, 'resTags')}>
                <div className="flex flex-wrap gap-2">
                  {tagPresets.map((tg) => (
                    <button
                      key={tg}
                      onClick={() => toggleTag(tg)}
                      className={`h-11 px-4 rounded-xl border text-sm font-semibold transition-colors ${
                        tags.includes(tg) ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-700 hover:border-gray-400'
                      }`}
                    >
                      {tg}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={t(lang, 'resNote')}>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t(lang, 'resNotePh')} />
              </Field>
            </div>

            <div className="flex gap-2 mt-6">
              <button onClick={reservation ? () => setScreen('detail') : onClose} className="btn-ghost flex-1">{t(lang, 'cancel')}</button>
              <button onClick={() => save.mutate()} disabled={busy} className="btn-primary flex-1 disabled:opacity-50">{t(lang, 'save')}</button>
            </div>
          </div>
        )}

        {/* ── Посадка: выбор стола ── */}
        {screen === 'seat' && reservation && (
          <div>
            <button onClick={() => setScreen('detail')} className="text-sm text-gray-400 hover:text-gray-600 mb-3">← {t(lang, 'back')}</button>
            <h3 className="text-sm font-bold text-gray-500 mb-3">{t(lang, 'resSeatPickTable')}</h3>
            {freeTables.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">{t(lang, 'noFreeTables')}</p>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {freeTables.map((tb) => (
                  <button
                    key={tb.id}
                    disabled={busy}
                    onClick={() => seat.mutate(tb.id)}
                    className={`aspect-square rounded-xl border-2 bg-white flex items-center justify-center transition-all active:scale-[0.95] disabled:opacity-50 ${
                      tb.id === reservation.table_id ? 'border-gray-900' : 'border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    <span className="text-lg font-black text-gray-900 tabular-nums">{tb.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        className="w-11 h-11 rounded-xl border border-gray-200 text-xl font-bold text-gray-700 hover:border-gray-400 active:scale-[0.95]"
      >−</button>
      <span className="text-lg font-black text-gray-900 tabular-nums w-8 text-center">{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        className="w-11 h-11 rounded-xl border border-gray-200 text-xl font-bold text-gray-700 hover:border-gray-400 active:scale-[0.95]"
      >+</button>
    </div>
  )
}

function BigButton({ label, onClick, disabled, primary, danger }: {
  label: string; onClick: () => void; disabled?: boolean; primary?: boolean; danger?: boolean
}) {
  const cls = primary
    ? 'border-gray-900 bg-gray-900 text-white hover:bg-gray-800'
    : danger
      ? 'border-red-200 text-red-600 hover:border-red-400 hover:bg-red-50'
      : 'border-gray-200 text-gray-900 hover:border-gray-400'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full h-12 rounded-2xl border text-sm font-semibold transition-all active:scale-[0.98] disabled:opacity-50 ${cls}`}
    >
      {label}
    </button>
  )
}
