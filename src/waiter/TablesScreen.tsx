import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useLangStore } from '../store/langStore'
import { formatElapsed, t } from '../lib/i18n'
import { formatMoney } from '../lib/money'
import Icon from '../components/Icon'
import { fetchHall, fetchMenu, type HallOpen } from './api'
import { linesCount } from './draft'
import { useWaiterDrafts, useWaiterSession } from './store'
import { problemJobs, ticketState, useTicketTracking } from './tickets'

/** Зал обновляется опросом: Realtime идёт через RLS, а она телефону закрыта */
const HALL_POLL_MS = 5000

export default function TablesScreen() {
  const lang = useLangStore((s) => s.lang)
  const session = useWaiterSession((s) => s.session)!
  const setSession = useWaiterSession((s) => s.setSession)
  const drafts = useWaiterDrafts((s) => s.tables)
  const jobs = useWaiterDrafts((s) => s.jobs)
  const dismissJob = useWaiterDrafts((s) => s.dismissJob)
  const navigate = useNavigate()
  const now = useTicketTracking()

  const hallQ = useQuery({
    queryKey: ['w_hall'],
    queryFn: () => fetchHall(session.token),
    refetchInterval: HALL_POLL_MS,
  })
  // Меню греем заранее: к первому столу оно уже на телефоне
  useQuery({ queryKey: ['w_menu'], queryFn: () => fetchMenu(session.token), staleTime: 5 * 60_000 })

  // «Сколько сидят» тикает само
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const hall = hallQ.data
  const [zone, setZone] = useState<string | null>(null)
  const openByTable = useMemo(
    () => new Map<string, HallOpen>((hall?.open ?? []).map((o) => [o.table_id, o])),
    [hall]
  )
  const tables = (hall?.tables ?? [])
    .filter((tb) => tb.status !== 'disabled')
    .filter((tb) => !zone || tb.zone_id === zone)
  const zones = hall?.zones ?? []
  const problems = problemJobs(jobs, now)

  return (
    <div className="pb-8">
      <header
        className="sticky top-0 z-10 bg-[#f8f9fb] border-b border-gray-100 px-4 pb-3 flex items-center justify-between gap-3"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <div className="min-w-0">
          <div className="text-lg font-bold text-gray-900 truncate">{session.location.name}</div>
          <div className="text-sm text-gray-500 truncate">{session.staff.name}</div>
        </div>
        <button className="btn-secondary shrink-0" onClick={() => setSession(null)}>
          {t(lang, 'wSignOut')}
        </button>
      </header>

      <main className="px-4 pt-4 space-y-4">
        {hall && !hall.shift_open && (
          <p className="card px-4 py-3 text-sm font-medium text-gray-900" role="status">{t(lang, 'wShiftClosed')}</p>
        )}
        {hall && hall.shift_open && !hall.printer_ready && (
          <p className="card px-4 py-3 text-sm font-medium text-gray-900" role="status">{t(lang, 'wPrinterNotReady')}</p>
        )}

        {problems.map((j) => (
          <div key={j.id} className="card px-4 py-3 flex items-center gap-3" role="alert">
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-gray-900">{t(lang, 'tableLabel')} {j.tableLabel}</div>
              <div className="text-sm text-gray-900">{ticketState(j, lang, now).text}</div>
            </div>
            <button className="btn-secondary shrink-0" onClick={() => dismissJob(j.id)}>OK</button>
          </div>
        ))}

        {zones.length > 1 && (
          <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
            {[{ id: null as string | null, name: t(lang, 'all') }, ...zones].map((z) => (
              <button
                key={z.id ?? 'all'}
                onClick={() => setZone(z.id)}
                className={`shrink-0 h-11 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.97] ${
                  zone === z.id ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-700'
                }`}
              >
                {z.name}
              </button>
            ))}
          </div>
        )}

        {hallQ.isPending ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card h-28 animate-pulse" />
            ))}
          </div>
        ) : !hall ? (
          <div className="card p-6 text-center space-y-3">
            <p className="text-gray-900">{t(lang, 'wOffline')}</p>
            <button className="btn-primary" onClick={() => void hallQ.refetch()}>{t(lang, 'wRetry')}</button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {tables.map((tb) => {
              const open = openByTable.get(tb.id)
              const draft = drafts[tb.id]
              const unsent = (draft?.lines.length ?? 0) > 0 || !!draft?.pending
              return (
                <button
                  key={tb.id}
                  onClick={() => navigate(`/waiter/table/${tb.id}`)}
                  className={`card min-h-28 p-4 text-start flex flex-col justify-between gap-2 active:scale-[0.97] transition-transform ${
                    open ? '!border-gray-900' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 w-full">
                    <span className="text-2xl font-bold text-gray-900 truncate">{tb.label}</span>
                    {open?.has_fired && (
                      <span role="img" aria-label={t(lang, 'tableFired')} className="text-red-600 shrink-0">
                        <Icon name="fire" size={18} />
                      </span>
                    )}
                  </div>
                  {open ? (
                    <div className="w-full">
                      <div className="font-semibold text-gray-900 tabular-nums">{formatMoney(open.total, lang)}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {t(lang, 'wItemsCount').replace('{n}', String(open.item_count))} · {formatElapsed(open.opened_at, nowTs, lang)}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500">{t(lang, 'tableFree')}</div>
                  )}
                  {unsent && (
                    <span className="badge-yellow">
                      {t(lang, 'wDraft')}
                      {draft && draft.lines.length > 0 ? ` · ${linesCount(draft.lines)}` : ''}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
