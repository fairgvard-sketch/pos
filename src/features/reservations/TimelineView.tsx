import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { t, type Lang, type TranslationKey } from '../../lib/i18n'
import { normalizeSchedule, shiftDate, partsInZone } from './schedule'
import {
  blockState, buildRows, groupByZone, halfHourMarks, hourTicks, nowMarkerPct,
  occupancySummary, timelineWindow,
  type BlockState, type PositionedBlock, type TimelineBooking, type TimelineTable,
} from './timeline'
import { fetchTimelineReservations, type Reservation } from './api'
import PartySize from '../../components/ui/PartySize'
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

/** Легенда состояний: цвет — подсказка, подпись — то, что читают */
const LEGEND: { state: BlockState | 'conflict'; dot: string; key: TranslationKey }[] = [
  { state: 'pending', dot: 'bg-amber-400', key: 'rsvPendingShort' },
  { state: 'confirmed', dot: 'bg-gray-900', key: 'resConfirmedBadge' },
  { state: 'arrived', dot: 'bg-emerald-600', key: 'rsvSeatedShort' },
  { state: 'done', dot: 'bg-gray-300', key: 'rsvDoneShort' },
  { state: 'conflict', dot: 'ring-2 ring-red-500 bg-white', key: 'rsvConflict' },
]

export interface TimelineViewProps {
  lang: Lang
  isRtl: boolean
  tables: Table[]
  /** Настройки брони точки — из них берётся окно дня и часовой пояс */
  settings: { reservations?: unknown } | null
  tz: string
  /** Поиск из шапки экрана: несовпавшие визиты гаснут, но остаются на месте */
  query?: string
  onOpen: (reservation: Reservation) => void
}

export default function TimelineView({
  lang, isRtl, tables, settings, tz, query = '', onOpen,
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

  const { data: raw = [], isLoading, isFetching, refetch } = useQuery({
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
      phone: r.customer_phone ?? '',
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
    seats: tb.seats ?? 2,
    zoneId: tb.zone_id ?? null,
    // `tables.zone` — текстовый снимок названия зоны (066), а не объект:
    // читая его как `zone.name`, полотно называло каждую зону «Без зоны»
    zoneName: tb.zone ?? null,
    sortOrder: tb.sort_order ?? 0,
    blocked: !tb.is_active || tb.status === 'disabled',
  })), [tables])

  const rows = useMemo(() => buildRows(timelineTables, bookings, win), [timelineTables, bookings, win])

  // Выключенный стол не часть текущей работы: пустыми строками он делал
  // зал больше и свободнее, чем он есть. Строку сохраняем, только если на
  // таком столе осталась бронь дня — её терять нельзя.
  const operationalRows = useMemo(
    () => rows.filter((row) => !row.table.blocked || row.blocks.length > 0),
    [rows]
  )
  const hiddenTables = rows.length - operationalRows.length
  const zones = useMemo(() => groupByZone(operationalRows), [operationalRows])
  const visibleZones = zoneFilter === null ? zones : zones.filter((z) => z.id === zoneFilter)
  const summary = useMemo(() => occupancySummary(rows, nowMs), [rows, nowMs])

  // Поиск не убирает визиты с полотна: пропавший визит хостес считает
  // несуществующим и зря звонит гостю. Несовпавшие гаснут, место суток
  // остаётся видимым.
  const needle = query.trim().toLowerCase()
  const matchesQuery = useCallback((booking: TimelineBooking) => {
    if (!needle) return true
    return `${booking.guestName} ${booking.phone}`.toLowerCase().includes(needle)
  }, [needle])
  const found = useMemo(() => {
    if (!needle) return null
    const ids = new Set<string>()
    for (const row of operationalRows) {
      for (const block of row.blocks) {
        if (matchesQuery(block.booking)) ids.add(block.booking.id)
      }
    }
    return ids.size
  }, [needle, matchesQuery, operationalRows])

  const ticks = useMemo(() => hourTicks(win, tz), [win, tz])
  const halves = useMemo(() => halfHourMarks(ticks, win), [ticks, win])
  const markerPct = date === todayStr ? nowMarkerPct(nowMs, win) : null
  const trackWidth = Math.max(720, ((win.endMs - win.startMs) / 3_600_000) * HOUR_PX)

  // Прокрутка к «сейчас» — один раз на смену дня. Обновление данных её
  // НЕ трогает: контейнер не перемонтируется, а эффект завязан на дату.
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string | null>(null)
  const scrollToNow = useCallback((smooth = true) => {
    const el = scrollRef.current
    if (!el || markerPct === null) return
    const target = Math.max(0, (markerPct / 100) * trackWidth - el.clientWidth / 3)
    // RTL: прокрутка идёт в отрицательную сторону — знак решает направление
    el.scrollTo({ left: isRtl ? -target : target, behavior: smooth ? 'smooth' : 'auto' })
  }, [markerPct, trackWidth, isRtl])

  useEffect(() => {
    if (scrolledFor.current === date) return
    if (markerPct === null || !scrollRef.current) return
    scrolledFor.current = date
    scrollToNow(false)
  }, [date, markerPct, scrollToNow])

  /** Пролистать полотно на треть экрана: сутки не листают по пикселю */
  function pan(direction: 1 | -1) {
    const el = scrollRef.current
    if (!el) return
    const step = Math.max(240, el.clientWidth * 0.72) * (isRtl ? -direction : direction)
    el.scrollBy({ left: step, behavior: 'smooth' })
  }

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
            <Chevron flipped={isRtl} />
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
            <Chevron flipped={!isRtl} />
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

      {/* Легенда и навигация по суткам. Состояние всегда названо словом:
          цвет — подсказка для тех, кто смотрит на экран целиком, а на
          солнце и в спешке читают подпись. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {LEGEND.map((item) => (
            <span key={item.state} className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className={`w-2.5 h-2.5 rounded-full ${item.dot}`} aria-hidden />
              {t(lang, item.key)}
            </span>
          ))}
        </div>

        <div className="ms-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => pan(-1)}
            className="h-11 px-3 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-100 active:scale-[0.97]"
          >
            {t(lang, 'rsvEarlier')}
          </button>
          {markerPct !== null && (
            <button
              type="button"
              onClick={() => scrollToNow()}
              className="h-11 px-3 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-100 active:scale-[0.97]"
            >
              {t(lang, 'rsvNow')}
            </button>
          )}
          <button
            type="button"
            onClick={() => pan(1)}
            className="h-11 px-3 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-100 active:scale-[0.97]"
          >
            {t(lang, 'rsvLater')}
          </button>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="h-11 px-3 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-100 active:scale-[0.97] disabled:opacity-40"
          >
            {t(lang, 'rsvRefresh')}
          </button>
        </div>
      </div>

      {(hiddenTables > 0 || found !== null) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
          {found !== null && (
            <span role="status">
              {found === 0 ? t(lang, 'rsvSearchNone') : `${found} ${t(lang, 'rsvSearchMatches')}`}
            </span>
          )}
          {hiddenTables > 0 && <span>{t(lang, 'rsvHiddenTables')}: {hiddenTables}</span>}
        </div>
      )}

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
                  {/* «Сейчас» подписано, а не только прочерчено: линия без
                      подписи читается как чужая разметка */}
                  {markerPct !== null && (
                    <span
                      className="absolute bottom-0 -translate-x-1/2 rtl:translate-x-1/2 rounded-md bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
                      style={{ insetInlineStart: `${markerPct}%` }}
                    >
                      {t(lang, 'rsvNow')}
                    </span>
                  )}
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
                        <PartySize n={row.table.seats} lang={lang} className="text-xs text-gray-500" />
                      </div>

                      <div
                        className={`relative h-14 ${row.table.blocked ? 'bg-gray-100' : ''}`}
                        style={{ width: trackWidth }}
                      >
                        {/* Часовая сетка и получас — тише часа: он помогает
                            прицелиться, а не читается как отметка времени */}
                        {halves.map((mark) => (
                          <span
                            key={mark.ts}
                            className="absolute inset-y-0 w-px bg-gray-50"
                            style={{ insetInlineStart: `${mark.leftPct}%` }}
                            aria-hidden
                          />
                        ))}
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
                            className="absolute inset-y-0 w-0.5 bg-blue-600 z-10"
                            style={{ insetInlineStart: `${markerPct}%` }}
                            aria-hidden
                          />
                        )}

                        {row.blocks.map((block) => (
                          <BookingBlock
                            key={block.booking.id}
                            lang={lang}
                            block={block}
                            dimmed={!matchesQuery(block.booking)}
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

/**
 * Стрелка дня. Рисуется SVG, а не символом «‹»: у угловых кавычек включено
 * bidi-зеркалирование, и в иврите браузер разворачивает глиф сам. Вместе с
 * ручной подменой символа получалось два разворота, то есть стрелки внутрь.
 * Направление задаётся здесь явно и от одного признака — раскладки.
 */
function Chevron({ flipped }: { flipped: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`w-5 h-5 mx-auto ${flipped ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
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

function BookingBlock({ lang, block, dimmed, onOpen }: {
  lang: Lang
  block: PositionedBlock
  /** Не попал в поиск: гаснет, но остаётся на месте */
  dimmed?: boolean
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
        ${dimmed ? 'opacity-30' : ''}
        ${block.conflict ? 'ring-2 ring-red-500 ring-offset-1' : ''}
        ${block.clipsStart ? 'rounded-s-none' : ''} ${block.clipsEnd ? 'rounded-e-none' : ''}`}
      style={{ insetInlineStart: `${block.leftPct}%`, width: `${block.widthPct}%`, minWidth: 44 }}
    >
      <span className="block text-xs font-bold truncate">{b.guestName}</span>
      <span className="block text-[11px] opacity-80 truncate">
        <PartySize n={b.partySize} lang={lang} />
        {block.combined && ` · ${t(lang, 'rsvCombined')}`}
        {b.state !== 'confirmed' && ` · ${stateLabel(lang, b.state)}`}
      </span>
    </button>
  )
}
