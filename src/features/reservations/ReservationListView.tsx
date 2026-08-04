import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { t, formatTime, type Lang, type TranslationKey } from '../../lib/i18n'
import { partsInZone, zonedToUtc } from './schedule'
import {
  PAGE_SIZE, VIA_KEYS, VISIT_STATES, createdVia, filterReservations, groupByDay,
  paginate, sortByTime, tableIdsOf, visitState,
  type CreatedVia, type DayRel, type VisitState,
} from './list'
import { fetchReservationsRange, type Reservation } from './api'
import LoadErrorState from '../../components/LoadErrorState'
import { failedNoCache } from '../../lib/queryState'
import type { Table } from '../../types'

/**
 * Лента броней — рабочая таблица, а не сетка карточек.
 *
 * Карточка занимала четверть экрана, и десяток броней уже не помещался
 * целиком; прошедшие дни список не показывал вовсе, а найти бронь можно
 * было только глазами. Таблица отвечает на другой вопрос, чем таймлайн:
 * не «что с залом сейчас», а «какие брони есть, в каком они состоянии и
 * что с ними делать» — поэтому здесь видны и отменённые, и завершённые.
 *
 * Строение и правила отбора те же, что в кабинете (ANGLE → Reservations →
 * List): одна бронь называется одинаково, где бы её ни открыли.
 */

const DAY_MS = 86_400_000

const RANGES = [
  { key: 'day', labelKey: 'today', days: 1 },
  { key: 'week', labelKey: 'rsvRangeNext7', days: 7 },
  { key: 'past', labelKey: 'rsvRangePast7', days: -7 },
] as const

type RangeKey = (typeof RANGES)[number]['key']

const STATE_LABEL: Record<VisitState, TranslationKey> = {
  pending: 'rsvPendingShort',
  confirmed: 'resConfirmedBadge',
  arrived: 'rsvSeatedShort',
  done: 'rsvDoneShort',
  noshow: 'rsvNoShowShort',
  rejected: 'resRejectedBadge',
  cancelled: 'resCancelledBadge',
}

const STATE_BADGE: Record<VisitState, string> = {
  pending: 'badge-yellow',
  confirmed: 'badge-green',
  arrived: 'badge-blue',
  done: 'badge-gray',
  noshow: 'badge-red',
  rejected: 'badge-red',
  cancelled: 'badge-gray',
}

const VIA_LABEL: Record<CreatedVia, TranslationKey> = {
  public: 'rsvViaPublic',
  pos: 'rsvViaPos',
  backoffice: 'rsvViaBackoffice',
  waitlist: 'rsvViaWaitlist',
  unknown: 'rsvViaUnknown',
}

const DAY_LABEL: Record<Exclude<DayRel, null>, TranslationKey> = {
  today: 'today',
  tomorrow: 'rsvTomorrow',
  yesterday: 'rsvYesterday',
}

export interface ReservationListViewProps {
  lang: Lang
  /** Часовой пояс точки: сутки ленты — её сутки, а не устройства */
  tz: string
  tables: Table[]
  onOpen: (reservation: Reservation) => void
}

export default function ReservationListView({ lang, tz, tables, onOpen }: ReservationListViewProps) {
  const [rangeKey, setRangeKey] = useState<RangeKey>('day')
  const [state, setState] = useState<VisitState | ''>('')
  const [zone, setZone] = useState('')
  const [via, setVia] = useState<CreatedVia | ''>('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [search, setSearch] = useState('')
  const [searchQ, setSearchQ] = useState('')
  const [page, setPage] = useState(1)

  // Ввод не перебирает список на каждую букву
  useEffect(() => {
    // Сузили отбор — третья страница могла исчезнуть; возвращаемся к первой
    const id = setTimeout(() => { setSearchQ(search); setPage(1) }, 300)
    return () => clearTimeout(id)
  }, [search])

  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[0]

  // Сутки считаются в часах ТОЧКИ и пересчитываются раз в минуту: иначе
  // «сегодня» после полуночи остаётся вчерашним до перезагрузки экрана
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const todayStr = useMemo(() => {
    const p = partsInZone(new Date(nowMs), tz)
    if (!p) return new Date(nowMs).toISOString().slice(0, 10)
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
  }, [nowMs, tz])

  const window = useMemo(() => {
    const startOfDay = zonedToUtc(todayStr, 0, tz).getTime()
    // Прошедшие дни считаются до конца сегодняшнего: разбирая вчерашнее,
    // хостес видит и то, что уже случилось сегодня
    if (range.days < 0) return { fromMs: startOfDay + range.days * DAY_MS, toMs: startOfDay + DAY_MS }
    return { fromMs: startOfDay, toMs: startOfDay + range.days * DAY_MS }
  }, [todayStr, tz, range.days])

  const listQ = useQuery({
    queryKey: ['reservation_list', window.fromMs, window.toMs],
    queryFn: () => fetchReservationsRange(window.fromMs, window.toMs),
    staleTime: 15_000,
  })
  const rows = listQ.data?.rows
  const capped = listQ.data?.capped ?? false

  const zoneByTable = useMemo(
    () => new Map(tables.map((tb) => [tb.id, tb.zone_id ?? null])),
    [tables],
  )
  const tableById = useMemo(() => new Map(tables.map((tb) => [tb.id, tb])), [tables])
  const zones = useMemo(() => {
    const seen = new Map<string, string>()
    for (const tb of tables) {
      if (tb.zone_id && !seen.has(tb.zone_id)) seen.set(tb.zone_id, tb.zone ?? '')
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }))
  }, [tables])

  const visible = useMemo(() => sortByTime(filterReservations(rows ?? [], {
    state: state || null,
    zone: zone || null,
    via: via || null,
    query: searchQ,
    zoneByTable,
  }), sortDir), [rows, state, zone, via, searchQ, zoneByTable, sortDir])

  const slice = paginate(visible, page, PAGE_SIZE)
  const groups = useMemo(() => groupByDay(slice.items, tz, todayStr), [slice.items, tz, todayStr])

  // Заявки — то, ради чего экран открывают в спешке. Счётчик ведёт к ним
  // одним тапом, вместо того чтобы искать их глазами в общей ленте.
  const pendingCount = useMemo(
    () => (rows ?? []).filter((r) => visitState(r) === 'pending').length,
    [rows],
  )

  const filtersOn = !!(state || zone || via || searchQ.trim())

  const tablesOf = (r: Reservation) => {
    const labels = tableIdsOf(r).map((id) => tableById.get(id)?.label).filter(Boolean)
    return labels.length > 0 ? labels.join(' + ') : '—'
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Отбор одной строкой: глубина, состояние, зал, путь и поиск */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          className="input w-auto"
          value={rangeKey}
          onChange={(e) => { setRangeKey(e.target.value as RangeKey); setPage(1) }}
          aria-label={t(lang, 'rsvColTime')}
        >
          {RANGES.map((r) => <option key={r.key} value={r.key}>{t(lang, r.labelKey)}</option>)}
        </select>
        <select
          className="input w-auto"
          value={state}
          onChange={(e) => { setState(e.target.value as VisitState | ''); setPage(1) }}
          aria-label={t(lang, 'rsvColStatus')}
        >
          <option value="">{t(lang, 'rsvAllStatuses')}</option>
          {VISIT_STATES.map((s) => <option key={s} value={s}>{t(lang, STATE_LABEL[s])}</option>)}
        </select>
        {zones.length > 1 && (
          <select
            className="input w-auto"
            value={zone}
            onChange={(e) => { setZone(e.target.value); setPage(1) }}
            aria-label={t(lang, 'zoneField')}
          >
            <option value="">{t(lang, 'allZones')}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name || t(lang, 'noZone')}</option>)}
          </select>
        )}
        <select
          className="input w-auto"
          value={via}
          onChange={(e) => { setVia(e.target.value as CreatedVia | ''); setPage(1) }}
          aria-label={t(lang, 'rsvColOrigin')}
        >
          <option value="">{t(lang, 'rsvAnyOrigin')}</option>
          {VIA_KEYS.map((v) => <option key={v} value={v}>{t(lang, VIA_LABEL[v])}</option>)}
        </select>
        <input
          className="input w-auto min-w-[12rem] flex-1 max-w-xs"
          placeholder={t(lang, 'historySearchPh')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {pendingCount > 0 && (
          <button
            type="button"
            onClick={() => { setState(state === 'pending' ? '' : 'pending'); setPage(1) }}
            className={`h-11 px-4 rounded-xl text-sm font-bold whitespace-nowrap transition-colors active:scale-[0.97] ${
              state === 'pending' ? 'bg-gray-900 text-white' : 'bg-amber-50 text-amber-700'
            }`}
          >
            {t(lang, 'resSectionNew')} · {pendingCount}
          </button>
        )}
        <button
          type="button"
          onClick={() => void listQ.refetch()}
          disabled={listQ.isFetching}
          className="btn-secondary !py-2.5 !px-4"
        >
          {t(lang, 'rsvRefresh')}
        </button>
      </div>

      {capped && <p className="text-xs text-gray-500">{t(lang, 'rsvListCapped')}</p>}

      {failedNoCache(listQ) ? (
        /* Пустая лента вместо упавшего запроса читалась бы как «броней
           нет» — и хостес сказал бы гостю неправду */
        <div className="pt-12">
          <LoadErrorState title={t(lang, 'dataLoadError')} onRetry={() => void listQ.refetch()} />
        </div>
      ) : rows === undefined ? (
        <ListSkeleton />
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500 text-center pt-12">
          {filtersOn ? t(lang, 'rsvListNoMatch') : t(lang, 'rsvListEmpty')}
        </p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs font-bold uppercase tracking-wide text-gray-500">
                <th scope="col" className="text-start ps-3 w-28">
                  {/* Порядок меняется по нажатию на заголовок — как в любой
                      таблице, к которой владелец привык */}
                  <button
                    type="button"
                    onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
                    className="min-h-11 flex items-center gap-1 uppercase tracking-wide"
                  >
                    {t(lang, 'rsvColTime')} {sortDir === 'asc' ? '↑' : '↓'}
                  </button>
                </th>
                <th scope="col" className="text-start">{t(lang, 'rsvColGuest')}</th>
                <th scope="col" className="text-start w-20">{t(lang, 'rsvColParty')}</th>
                <th scope="col" className="text-start w-32">{t(lang, 'tableLabel')}</th>
                <th scope="col" className="text-start w-40">{t(lang, 'rsvColStatus')}</th>
                <th scope="col" className="text-start w-32">{t(lang, 'rsvColOrigin')}</th>
                <th scope="col" className="text-start">{t(lang, 'rsvColNote')}</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.key}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={7}
                    className="text-start ps-3 pt-4 pb-1 text-sm font-bold text-gray-900"
                  >
                    {group.rel ? t(lang, DAY_LABEL[group.rel]) : dayTitle(group.key, lang)}
                    <span className="ms-2 text-xs font-semibold text-gray-500 tabular-nums">
                      {group.rows.length}
                    </span>
                  </th>
                </tr>
                {group.rows.map((r) => {
                  const st = visitState(r)
                  return (
                    <tr
                      key={r.id}
                      onClick={() => onOpen(r)}
                      className="border-t border-gray-100 cursor-pointer hover:bg-gray-50 active:bg-gray-100"
                    >
                      <td className="ps-3 py-3 align-top tabular-nums font-bold text-gray-900">
                        {formatTime(r.reserved_at, lang)}
                      </td>
                      <td className="py-3 align-top">
                        {/* Открывает и вся строка (палец), и кнопка (клавиатура):
                            строка с role="button" ломает семантику таблицы */}
                        <button type="button" onClick={() => onOpen(r)} className="text-start min-h-11">
                          <span className="block font-semibold text-gray-900 truncate">
                            {r.customer_name}
                            {r.is_test && (
                              <span className="badge-yellow ms-2">{t(lang, 'rsvTestBooking')}</span>
                            )}
                          </span>
                          {r.customer_phone && (
                            <span className="block text-xs text-gray-500 tabular-nums" dir="ltr">
                              {r.customer_phone}
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="py-3 align-top tabular-nums text-gray-900">{r.party_size}</td>
                      <td className="py-3 align-top text-gray-900">{tablesOf(r)}</td>
                      <td className="py-3 align-top">
                        <span className={STATE_BADGE[st]}>{t(lang, STATE_LABEL[st])}</span>
                      </td>
                      <td className="py-3 align-top text-gray-500">{t(lang, VIA_LABEL[createdVia(r)])}</td>
                      <td className="py-3 pe-3 align-top text-gray-500">
                        {/* Заметка обрезается: целиком она есть в окне брони */}
                        <span className="line-clamp-2">{r.note || r.reject_reason || '—'}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            ))}
          </table>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-gray-500 tabular-nums">
              {slice.from}–{slice.to} {t(lang, 'rsvOf')} {slice.total}
            </span>
            {slice.pages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary !py-2.5 !px-4"
                  disabled={slice.page <= 1}
                  onClick={() => setPage(slice.page - 1)}
                >
                  {t(lang, 'rsvPrevPage')}
                </button>
                <span className="text-xs text-gray-500 tabular-nums">
                  {t(lang, 'rsvPage')} {slice.page} {t(lang, 'rsvOf')} {slice.pages}
                </span>
                <button
                  type="button"
                  className="btn-secondary !py-2.5 !px-4"
                  disabled={slice.page >= slice.pages}
                  onClick={() => setPage(slice.page + 1)}
                >
                  {t(lang, 'rsvNextPage')}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Подпись дня из ключа «ГГГГ-ММ-ДД». Дата форматируется как есть, без
 * пересчёта в зону устройства: ключ уже посчитан в часах точки, и второй
 * перевод сдвинул бы поздние вечерние брони на соседний день.
 */
function dayTitle(key: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return key
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString(
    lang === 'he' ? 'he-IL' : 'ru-RU',
    { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' },
  )
}

/** Скелет ленты: та же геометрия, что у загруженной — экран не прыгает */
function ListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="h-12 rounded-xl bg-gray-100" />
      ))}
    </div>
  )
}
