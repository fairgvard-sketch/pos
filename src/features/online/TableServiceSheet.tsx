import { useEffect, useMemo, useState } from 'react'
import { t, type Lang } from '../../lib/i18n'
import {
  fetchPublicServiceRequest,
  PublicApiError,
  submitPublicServiceRequest,
  type PublicServiceRequestKind,
  type PublicServiceRequestStatus,
} from './publicApi'

const STORAGE_KEY = 'angle-table-service-requests-v1'
const KEEP_MS = 6 * 60 * 60_000

interface StoredContext {
  locId: string
  tableToken: string
  requests: PublicServiceRequestStatus[]
}

const labels: Record<PublicServiceRequestKind, Parameters<typeof t>[1]> = {
  call_waiter: 'serviceCallWaiter',
  water: 'serviceWater',
  cutlery: 'serviceCutlery',
  napkins: 'serviceNapkins',
  bread: 'serviceBread',
  next_course: 'serviceNextCourse',
  hold_course: 'serviceHoldCourse',
  problem: 'serviceProblem',
  bill: 'serviceBill',
}

function readStored(locId: string, tableToken: string): PublicServiceRequestStatus[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const stored = JSON.parse(raw) as StoredContext
    if (stored.locId !== locId || stored.tableToken !== tableToken || !Array.isArray(stored.requests)) {
      return []
    }
    const cutoff = Date.now() - KEEP_MS
    return stored.requests
      .filter((request) => new Date(request.created_at).getTime() >= cutoff)
      .slice(-10)
  } catch {
    return []
  }
}

function statusLabel(lang: Lang, status: PublicServiceRequestStatus['status']): string {
  if (status === 'accepted') return t(lang, 'serviceAcceptedGuest')
  if (status === 'completed') return t(lang, 'serviceCompletedGuest')
  if (status === 'cancelled') return t(lang, 'serviceCancelledGuest')
  return t(lang, 'serviceSentGuest')
}

function errorLabel(lang: Lang, error: unknown): string {
  if (error instanceof PublicApiError) {
    if (error.code === 'rate_limited' || error.code === 'busy') return t(lang, 'serviceBusyError')
    if (error.code === 'invalid_table') return t(lang, 'pubTableQrExpired')
    if (error.code === 'module_disabled' || error.code === 'service_unavailable') {
      return t(lang, 'serviceUnavailable')
    }
  }
  return t(lang, 'serviceSendError')
}

export function TableServiceButton({
  lang,
  activeCount,
  onClick,
}: {
  lang: Lang
  activeCount: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t(lang, 'serviceOpen')}
      className="relative h-11 min-w-11 px-3 rounded-full bg-gray-100 text-gray-900 flex items-center justify-center gap-2 text-sm font-bold active:scale-[0.96] transition-all"
    >
      <ServiceIcon kind="call_waiter" />
      <span>{t(lang, 'serviceTab')}</span>
      {activeCount > 0 && (
        <span className="absolute -top-1 -end-1 min-w-[18px] h-[18px] px-1 rounded-full bg-gray-900 text-white text-[10px] flex items-center justify-center tabular-nums">
          {activeCount}
        </span>
      )}
    </button>
  )
}

export default function TableServiceSheet({
  open,
  lang,
  locId,
  tableToken,
  tableLabel,
  onClose,
  onActiveCountChange,
  mode = 'sheet',
}: {
  open: boolean
  lang: Lang
  locId: string
  tableToken: string
  tableLabel: string
  onClose: () => void
  onActiveCountChange?: (count: number) => void
  mode?: 'sheet' | 'page'
}) {
  const [requests, setRequests] = useState<PublicServiceRequestStatus[]>(
    () => readStored(locId, tableToken),
  )
  const [sendingKind, setSendingKind] = useState<PublicServiceRequestKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activeRequests = useMemo(
    () => requests.filter((request) => request.status === 'new' || request.status === 'accepted'),
    [requests],
  )
  const activeByKind = useMemo(
    () => new Map(activeRequests.map((request) => [request.kind, request])),
    [activeRequests],
  )
  const visibleRequests = useMemo(() => requests.slice(-4).reverse(), [requests])
  const activeIds = activeRequests.map((request) => request.client_uuid).join(',')

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ locId, tableToken, requests }))
    onActiveCountChange?.(activeRequests.length)
  }, [activeRequests.length, locId, onActiveCountChange, requests, tableToken])

  // Poll only while an unfinished task exists. Returning to the foreground
  // refreshes immediately, so a sleeping phone never waits for the next tick.
  useEffect(() => {
    if (activeRequests.length === 0) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      const updates = await Promise.all(activeRequests.map(async (request) => {
        try {
          return await fetchPublicServiceRequest(request.client_uuid)
        } catch {
          return request
        }
      }))
      if (stopped) return
      setRequests((current) => current.map((request) =>
        updates.find((update) => update.client_uuid === request.client_uuid) ?? request,
      ))
    }
    const loop = () => {
      void poll()
      timer = setTimeout(loop, 5_000)
    }
    loop()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  // `activeIds` stays stable when a poll returns the same state, preventing
  // this effect from restarting into a tight request loop after each fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIds])

  async function send(kind: PublicServiceRequestKind) {
    if (activeByKind.has(kind) || sendingKind) return
    const clientUuid = crypto.randomUUID()
    const optimistic: PublicServiceRequestStatus = {
      client_uuid: clientUuid,
      kind,
      status: 'new',
      table_label: tableLabel,
      created_at: new Date().toISOString(),
      accepted_at: null,
      completed_at: null,
    }
    setError(null)
    setSendingKind(kind)
    setRequests((current) => [...current, optimistic])
    try {
      const result = await submitPublicServiceRequest({
        loc: locId,
        table_token: tableToken,
        client_uuid: clientUuid,
        kind,
      })
      const tracked = await fetchPublicServiceRequest(result.client_uuid)
      setRequests((current) => {
        const withoutOptimistic = current.filter((request) => request.client_uuid !== clientUuid)
        const existingIndex = withoutOptimistic.findIndex(
          (request) => request.client_uuid === tracked.client_uuid,
        )
        if (existingIndex >= 0) {
          return withoutOptimistic.map((request, index) => index === existingIndex ? tracked : request)
        }
        return [...withoutOptimistic, tracked]
      })
    } catch (requestError) {
      setRequests((current) => current.filter((request) => request.client_uuid !== clientUuid))
      setError(errorLabel(lang, requestError))
    } finally {
      setSendingKind(null)
    }
  }

  if (!open) return null

  const callWaiter = activeByKind.get('call_waiter')
  const callWaiterSending = sendingKind === 'call_waiter'

  const requestButton = (kind: PublicServiceRequestKind, variant: 'quick' | 'row') => {
    const active = activeByKind.get(kind)
    const sending = sendingKind === kind
    return (
      <button
        key={kind}
        type="button"
        disabled={!!active || !!sendingKind}
        onClick={() => void send(kind)}
        className={`${variant === 'quick' ? 'angle-table-service-quick' : 'angle-table-service-row'} ${active ? 'is-active' : ''}`}
      >
        <span className="angle-table-service-icon"><ServiceIcon kind={kind} /></span>
        <span className="angle-table-service-label">{t(lang, labels[kind])}</span>
        {(active || sending) && (
          <span className="angle-table-service-state">
            {sending ? t(lang, 'serviceSending') : statusLabel(lang, active!.status)}
          </span>
        )}
        {variant === 'row' && !active && !sending && <span className="angle-table-service-chevron" aria-hidden>›</span>}
      </button>
    )
  }

  const content = (
    <section
      role={mode === 'sheet' ? 'dialog' : undefined}
      aria-modal={mode === 'sheet' ? 'true' : undefined}
      aria-labelledby="table-service-title"
      onClick={mode === 'sheet' ? (event) => event.stopPropagation() : undefined}
      className={mode === 'page' ? 'angle-table-service-page public-menu-route-focus' : 'angle-table-service-sheet'}
      tabIndex={mode === 'page' ? -1 : undefined}
    >
      {mode === 'sheet' && (
        <button type="button" onClick={onClose} aria-label={t(lang, 'close')} className="angle-table-service-close">×</button>
      )}

      {mode === 'sheet' ? (
        <div className="angle-table-service-intro">
          <p>{t(lang, 'pubTable')} {tableLabel}</p>
          <h1 id="table-service-title">{t(lang, 'serviceCallWaiter')}</h1>
          <span>{t(lang, 'serviceCallHint')}</span>
        </div>
      ) : (
        <h1 id="table-service-title" className="sr-only">{t(lang, 'serviceCallWaiter')}</h1>
      )}

      <button
        type="button"
        disabled={!!callWaiter || !!sendingKind}
        onClick={() => void send('call_waiter')}
        className={`angle-table-service-primary ${callWaiter ? 'is-active' : ''}`}
      >
        <span className="angle-table-service-primary-icon"><ServiceIcon kind="call_waiter" /></span>
        <span className="angle-table-service-primary-copy">
          <strong>{t(lang, 'serviceCallWaiter')}</strong>
          <small>
            {callWaiterSending
              ? t(lang, 'serviceSending')
              : callWaiter
                ? statusLabel(lang, callWaiter.status)
                : t(lang, 'serviceCallHint')}
          </small>
        </span>
      </button>

      {visibleRequests.length > 0 && (
        <div className="angle-table-service-activity" aria-live="polite">
          {visibleRequests.map((request) => (
            <div key={request.client_uuid}>
              <span className={`angle-table-service-dot is-${request.status}`} />
              <p>
                <strong>{t(lang, labels[request.kind])}</strong>
                <small>{statusLabel(lang, request.status)}</small>
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="angle-table-service-group">
        <h2>{t(lang, 'serviceQuickRequests')}</h2>
        <div className="angle-table-service-quick-grid">
          {(['water', 'cutlery', 'napkins'] as PublicServiceRequestKind[]).map((kind) => requestButton(kind, 'quick'))}
        </div>
      </div>

      <div className="angle-table-service-group">
        <h2>{t(lang, 'serviceOtherRequests')}</h2>
        <div className="angle-table-service-row-list">
          {(['problem', 'next_course', 'hold_course', 'bill'] as PublicServiceRequestKind[]).map((kind) => requestButton(kind, 'row'))}
        </div>
      </div>

      {error && <p className="angle-table-service-error" role="alert">{error}</p>}
    </section>
  )

  if (mode === 'page') return content

  return (
    <div className="angle-table-service-backdrop" onClick={onClose} role="presentation">
      {content}
    </div>
  )
}

function ServiceIcon({ kind }: { kind: PublicServiceRequestKind }) {
  if (kind === 'water') {
    return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3.25s5 5.5 5 9.65a5 5 0 0 1-10 0c0-4.15 5-9.65 5-9.65Z" /><path d="M9.4 13.3a2.8 2.8 0 0 0 2.1 2.35" /></svg>
  }
  if (kind === 'cutlery') {
    return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6.25 3.5v7.25M3.75 3.5v4.75a2.5 2.5 0 0 0 5 0V3.5M6.25 10.75v9.75M15.75 3.5v17M15.75 3.5c2.9 2 4 4.65 4 7.75h-4" /></svg>
  }
  if (kind === 'napkins') {
    return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 6.25h10.75L19 9.5v9.25H8.25L5 15.5V6.25Z" /><path d="M8.25 9.5H19M8.25 9.5v9.25" /><path d="m15.75 6.25 0 3.25L19 9.5" /></svg>
  }
  if (kind === 'bread') {
    return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 15c-2-1-2-4 0-5 0-3 3-5 7-5s7 2 7 5c2 1 2 4 0 5-1 3-4 4-7 4s-6-1-7-4Z" /><path d="m9 8-1 3M13 7l-1 4M17 8l-1 3" /></svg>
  }
  if (kind === 'next_course') {
    return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4.5 18h15M6.5 18a5.5 5.5 0 0 1 11 0M12 7.25v5" /><path d="m9.5 9.75 2.5-2.5 2.5 2.5" /></svg>
  }
  if (kind === 'hold_course') {
    return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4.5 18h15M6.5 18a5.5 5.5 0 0 1 11 0" /><path d="M9.5 7.25v5M14.5 7.25v5" /></svg>
  }
  if (kind === 'bill') {
    return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M7 3.5h10v17l-2-1.35L13 20.5l-2-1.35L9 20.5l-2-1.35V3.5Z" /><path d="M10 8h4M10 12h4M10 16h2.5" /></svg>
  }
  if (kind === 'problem') {
    return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5.75M12 16.75h.01" /></svg>
  }
  return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 17.5h14M7.5 17.5v-5a4.5 4.5 0 0 1 9 0v5M12 5v2.5M4 20.5h16" /><path d="M9.5 12.5h5" /></svg>
}
