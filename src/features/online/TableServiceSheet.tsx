import { useState } from 'react'
import { t, type Lang } from '../../lib/i18n'
import {
  PublicApiError,
  submitPublicServiceRequest,
  type PublicServiceRequestKind,
} from './publicApi'

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

export default function TableServiceSheet({
  open,
  lang,
  locId,
  tableToken,
  tableLabel,
  onClose,
  mode = 'sheet',
}: {
  open: boolean
  lang: Lang
  locId: string
  tableToken: string
  tableLabel: string
  onClose: () => void
  mode?: 'sheet' | 'page'
}) {
  const [error, setError] = useState<string | null>(null)

  async function send(kind: PublicServiceRequestKind) {
    const clientUuid = crypto.randomUUID()
    navigator.vibrate?.(18)
    setError(null)
    try {
      await submitPublicServiceRequest({
        loc: locId,
        table_token: tableToken,
        client_uuid: clientUuid,
        kind,
      })
    } catch (requestError) {
      setError(errorLabel(lang, requestError))
    }
  }

  if (!open) return null

  const requestButton = (kind: PublicServiceRequestKind, variant: 'quick' | 'row') => {
    return (
      <label
        key={kind}
        className={variant === 'quick' ? 'angle-table-service-quick' : 'angle-table-service-row'}
      >
        <HapticRequestControl
          label={t(lang, labels[kind])}
          onActivate={() => void send(kind)}
        />
        <span className={`angle-table-service-icon is-${kind}`} aria-hidden><ServiceIcon kind={kind} /></span>
        <span className="angle-table-service-label" aria-hidden>{t(lang, labels[kind])}</span>
        {variant === 'row' && <span className="angle-table-service-chevron" aria-hidden>›</span>}
      </label>
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

      <label className="angle-table-service-primary">
        <HapticRequestControl
          label={t(lang, 'serviceCallWaiter')}
          onActivate={() => void send('call_waiter')}
        />
        <span className="angle-table-service-primary-icon is-call_waiter" aria-hidden><ServiceIcon kind="call_waiter" /></span>
        <span className="angle-table-service-primary-copy" aria-hidden>
          <strong>{t(lang, 'serviceCallWaiter')}</strong>
          <small>{t(lang, 'serviceCallHint')}</small>
        </span>
      </label>

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

function HapticRequestControl({
  label,
  onActivate,
}: {
  label: string
  onActivate: () => void
}) {
  return (
    <input
      {...{ switch: '' }}
      type="checkbox"
      role="button"
      aria-label={label}
      className="angle-service-haptic-control"
      onChange={(event) => {
        // Safari 18+ gives its native switch a physical tap. Resetting the
        // control keeps every touch actionable without exposing toggle state.
        event.currentTarget.checked = false
        onActivate()
      }}
    />
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
  return <svg className="angle-service-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 17.5h14M7.5 17.5v-5a4.5 4.5 0 0 1 9 0v5M12 5v2.5M4 20.5h16" /><path d="M9.5 12.5h5M18.5 5.25h2M19.5 4.25v2" /></svg>
}
