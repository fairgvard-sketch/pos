import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { t, type Lang } from '../../lib/i18n'
import { normalizeSchedule, shiftDate, partsInZone } from './schedule'
import {
  blockState, buildRows, groupByZone, hourTicks, nowMarkerPct, occupancySummary,
  timelineWindow,
  type BlockState, type PositionedBlock, type TimelineBooking, type TimelineTable,
} from './timeline'
import { fetchTimelineReservations, type Reservation } from './api'
import type { Table } from '../../types'

/**
 * Таймлайн хостес: столы по вертикали, время по горизонтали, визит —
 * блок. Отвечает на вопрос «что с залом в ближайшие часы» за один взгляд,
 * чего список карточек не умеет в принципе.
 *
 * Данные о занятости приходят из `reservation_tables` (119): клиент не
 * выводит её из массивов и не может разойтись с сервером. Геометрия —
 * в `timeline.ts`, здесь только отрисовка и взаимодействие.
 */

/** Ширина часа в пикселях: под палец, а не под мышь */
const HOUR_PX = 132
const LABEL_W = 132

const STATE_STYLE: Record<BlockState, string> = {
  pending: 'bg-amber-50 border-amber-300 text-amber-900',
  confirmed: 'bg-white border-gray-300 text-gray-900',
  arrived: 'bg-gray-900 border-gray-900 text-white',
  done: 'bg-gray-100 border-gray-200 text-gray-500',
  noshow: 'bg-red-50 border-red-200 text-red-700',
}

function stateLabel(lang: Lang, state: BlockState): string {
  switch (state) {
    case 'pending': return t(lang, 'rsvPendingShort')
    case 'arrived': return t(lang, 'rsvSeatedShort')
    case 'done': return t(lang, 'rsvDoneShort')
    case 'noshow': return t(lang, 'rsvNoShowShort')
    default: return t(lang, 'resConfirmedBadge')
  }
}

export interface TimelineViewProps {
  lang: Lang
  isRtl: boolean
  tables: Table[]
  /** Настройки брони точки — из них берётся окно дня и часовой пояс */
  settings: { reservations?: unknown } | null
  tz: string
  onOpen: (reservation: Reservation) => void
}

export default function TimelineView({
  lang, isRtl, tables, settings, tz, onOpen,
}: TimelineViewProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Пересчитывается раз в минуту вместе с nowMs — один вызов Intl, зато
  // «сегодня» честно переключается в полночь по времени ТОЧКИ.
  const todayStr = useMemo(() => {
    const p = partsInZone(new Date(nowMs), tz)
    if (!p) return new Date(nowMs).toISOString().slice(0, 10)
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
  }, [nowMs, tz])

  const [date, setDate] = useState(todayStr)
  const [zoneFilter, setZoneFilter] = useState<string | null>(null)

  const schedule = useMemo(
    () => normalizeSchedule((settings as { reservations?: never })?.reservations ?? null),
    [settings]
  )

  // Окно считается дважды: сперва без броней (чтобы знать, что грузить),
  // затем с ними — ручная бронь на нерабочее время расширяет день.
  const baseWindow = useMemo(
    () => timelineWindow(date, tz, schedule),
    [date, tz, schedule]
  )

  const { data: raw = [], isLoading } = useQuery({
    queryKey: ['reservation_timeline', date],
    queryFn: () => fetchTimelineReservations(baseWindow.startMs, baseWindow.endMs),
    staleTime: 15_000,
  })

  const bookings = useMemo<TimelineBooking[]>(() => raw.map((r) => {
    const start = new Date(r.reserved_at).getTime()
    const linked = (r.tables_link ?? []).map((l) => l.table_id)
    return {
      id: r.id,
      // Связь 119 — источник истины; массивы остаются фолбэком для строк,
      // записанных клиентом старой версии.
      tableIds: linked.length > 0
        ? linked
        : [r.table_id, ...(r.hold_table_ids ?? [])].filter((x): x is string => !!x),
      startMs: start,
      endMs: start + (r.duration_min || 90) * 60_000,
      state: blockState(r.status, r.arrived_at ?? null, r.order_id),
      guestName: r.customer_name,
      partySize: r.party_size,
      posSeated: r.order_id != null,
      zoneName: r.zone?.name ?? null,
      note: r.note,
    }
  }), [raw])

  const win = useMemo(
    () => timelineWindow(date, tz, schedule, bookings),
    [date, tz, schedule, bookings]
  )

  const timelineTables = useMemo<TimelineTable[]>(() => tables.map((tb) => ({
    id: tb.id,
    label: tb.label,
    seats: (tb as Table & { seats?: number }).seats ?? 2,
    zoneId: (tb as Table & { zone_id?: string | null }).zone_id ?? null,
    zoneName: (tb as Table & { zone?: { name?: string } | null }).zone?.name ?? null,
    sortOrder: tb.sort_order ?? 0,
    blocked: !tb.is_active || tb.status === 'disabled',
  })), [tables])

  const rows = useMemo(() => buildRows(timelineTables, bookings, win), [timelineTables, bookings, win])
  const zones = useMemo(() => groupByZone(rows), [rows])
  const visibleZones = zoneFilter === null ? zones : zones.filter((z) => z.id === zoneFilter)
  const summary = useMemo(() => occupancySummary(rows, nowMs), [rows, nowMs])

  const ticks = useMemo(() => hourTicks(win, tz), [win, tz])
  const markerPct = date === todayStr ? nowMarkerPct(nowMs, win) : null
  const trackWidth = Math.max(720, ((win.endMs - win.startMs) / 3_600_000) * HOUR_PX)

  // Прокрутка к «сейчас» — один раз на смену дня. Обновление данных её
  // НЕ трогает: контейнер не перемонтируется, а эффект завязан на дату.
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string | null>(null)
  useEffect(() => {
    if (scrolledFor.current === date) return
    const el = scrollRef.current
    if (!el || markerPct === null) return
    scrolledFor.current = date
    const target = (markerPct / 100) * trackWidth - el.clientWidth / 3
    el.scrollLeft = isRtl ? -Math.max(0, target) : Math.max(0, target)
  }, [date, markerPct, trackWidth, isRtl])

  return (
    <div className="flex flex-col gap-3">
      {/* Шапка: день, зоны, сводка «что происходит» */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t(lang, 'prevDay')}
            className="h-11 w-11 rounded-xl border border-gray-300 text-gray-700 active:scale-[0.97] transition-all"
            onClick={() => setDate((d) => shiftDate(d, -1))}
          >
            <span className="rtl:hidden">‹</span><span className="hidden rtl:inline">›</span>
          </button>
          <button
            type="button"
            className={`h-11 px-4 rounded-xl border text-sm font-semibold active:scale-[0.97] transition-all ${
              date === todayStr
                ? 'bg-gray-900 text-white border-gray-900'
                : 'border-gray-300 text-gray-700'
            }`}
            onClick={() => setDate(todayStr)}
          >
            {t(lang, 'today')}
          </button>
          <button
            type="button"
            aria-label={t(lang, 'nextDay')}
            className="h-11 w-11 rounded-xl border border-gray-300 text-gray-700 active:scale-[0.97] transition-all"
            onClick={() => setDate((d) => shiftDate(d, 1))}
          >
            <span className="rtl:hidden">›</span><span className="hidden rtl:inline">‹</span>
          </button>
        </div>

        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          aria-label={t(lang, 'rsvDate')}
          className="h-11 rounded-xl border border-gray-300 px-3 text-sm"
        />

        {zones.length > 1 && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={`h-11 px-3 rounded-xl border text-sm font-semibold ${
                zoneFilter === null ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'
              }`}
              onClick={() => setZoneFilter(null)}
            >
              {t(lang, 'allZones')}
            </button>
            {zones.map((z) => (
              <button
                key={z.id ?? '__none__'}
                type="button"
                className={`h-11 px-3 rounded-xl border text-sm font-semibold ${
                  zoneFilter === z.id ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'
                }`}
                onClick={() => setZoneFilter(z.id)}
              >
                {z.name ?? t(lang, 'noZone')}
              </button>
            ))}
          </div>
        )}

        <div className="ms-auto flex items-center gap-4 text-sm">
          <Stat label={t(lang, 'rsvBusyTables')} value={`${summary.busyTables}/${summary.totalTables}`} />
          <Stat label={t(lang, 'rsvFreeSeats')} value={`${summary.freeSeats}`} />
          <Stat label={t(lang, 'rsvSoonHour')} value={`${summary.soon}`} />
          {summary.pending > 0 && (
            <Stat label={t(lang, 'rsvPendingShort')} value={`${summary.pending}`} accent />
          )}
        </div>
      </div>

      {isLoading && (
        <div className="py-10 text-center text-gray-500">{t(lang, 'loading')}</div>
      )}

      {/* Полотно: слева липкая колонка столов, справа прокручиваемое время */}
      {!isLoading && (
        <div className="rounded-2xl border border-gray-200 overflow-hidden bg-white">
          <div ref={scrollRef} className="overflow-x-auto">
            <div style={{ width: LABEL_W + trackWidth }}>
              {/* Шкала часов */}
              <div className="flex sticky top-0 z-20 bg-white border-b border-gray-200">
                <div
                  className="shrink-0 bg-white border-e border-gray-200"
                  style={{ width: LABEL_W }}
                />
                <div className="relative h-9" style={{ width: trackWidth }}>
                  {ticks.map((tick) => (
                    <span
                      key={tick.ts}
                      className="absolute top-2 -translate-x-1/2 rtl:translate-x-1/2 text-xs font-semibold text-gray-500 tabular-nums"
                      style={{ insetInlineStart: `${tick.leftPct}%` }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
              </div>

              {visibleZones.map((zone) => (
                <div key={zone.id ?? '__none__'}>
                  {zones.length > 1 && (
                    <div className="flex">
                      <div
                        className="shrink-0 bg-gray-50 border-e border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-500"
                        style={{ width: LABEL_W }}
                      >
                        {zone.name ?? t(lang, 'noZone')}
                      </div>
                      <div className="bg-gray-50 border-b border-gray-100" style={{ width: trackWidth }} />
                    </div>
                  )}

                  {zone.rows.map((row) => (
                    <div key={row.table.id} className="flex border-b border-gray-100 last:border-b-0">
                      <div
                        className="shrink-0 border-e border-gray-200 px-3 py-2 flex items-center gap-2"
                        style={{ width: LABEL_W }}
                      >
                        <span className="font-bold text-gray-900">{row.table.label}</span>
                        <span className="text-xs text-gray-500">
                          {row.table.seats} {t(lang, 'resGuestsShort')}
                        </span>
                      </div>

                      <div
                        className={`relative h-14 ${row.table.blocked ? 'bg-gray-100' : ''}`}
                        style={{ width: trackWidth }}
                      >
                        {/* Часовая сетка */}
                        {ticks.map((tick) => (
                          <span
                            key={tick.ts}
                            className="absolute inset-y-0 w-px bg-gray-100"
                            style={{ insetInlineStart: `${tick.leftPct}%` }}
                            aria-hidden
                          />
                        ))}

                        {row.table.blocked && (
                          <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-gray-400">
                            {t(lang, 'rsvTableBlocked')}
                          </span>
                        )}

                        {markerPct !== null && (
                          <span
                            className="absolute inset-y-0 w-0.5 bg-red-500 z-10"
                            style={{ insetInlineStart: `${markerPct}%` }}
                            aria-hidden
                          />
                        )}

                        {row.blocks.map((block) => (
                          <BookingBlock
                            key={block.booking.id}
                            lang={lang}
                            block={block}
                            onOpen={() => {
                              const source = raw.find((r) => r.id === block.booking.id)
                              if (source) onOpen(source)
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}

              {visibleZones.every((z) => z.rows.length === 0) && (
                <div className="py-10 text-center text-gray-500">{t(lang, 'rsvNoTables')}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-xs text-gray-500">{label}</span>
      <strong className={`text-base tabular-nums ${accent ? 'text-amber-700' : 'text-gray-900'}`}>
        {value}
      </strong>
    </span>
  )
}

function BookingBlock({ lang, block, onOpen }: {
  lang: Lang
  block: PositionedBlock
  onOpen: () => void
}) {
  const b = block.booking
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${b.guestName} · ${b.partySize}`}
      className={`absolute top-1.5 bottom-1.5 rounded-lg border px-2 text-start overflow-hidden
        active:scale-[0.99] transition-transform ${STATE_STYLE[b.state]}
        ${block.conflict ? 'ring-2 ring-red-500 ring-offset-1' : ''}
        ${block.clipsStart ? 'rounded-s-none' : ''} ${block.clipsEnd ? 'rounded-e-none' : ''}`}
      style={{ insetInlineStart: `${block.leftPct}%`, width: `${block.widthPct}%`, minWidth: 44 }}
    >
      <span className="block text-xs font-bold truncate">{b.guestName}</span>
      <span className="block text-[11px] opacity-80 truncate">
        {b.partySize} {t(lang, 'resGuestsShort')}
        {block.combined && ` · ${t(lang, 'rsvCombined')}`}
        {b.state !== 'confirmed' && ` · ${stateLabel(lang, b.state)}`}
      </span>
    </button>
  )
}
