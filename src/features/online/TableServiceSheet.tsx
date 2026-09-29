import { useState, type ReactNode } from 'react'
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
  let glyph: ReactNode

  switch (kind) {
    case 'water':
      glyph = (
        <>
          <path className="angle-service-glyph-accent" d="M9.3 16.1h13.4L22 26H10l-.7-9.9Z" />
          <path d="M8 6h16l-1.55 20H9.55L8 6Z" />
          <path d="M9.25 15.75c2.2-1.4 4.25 1.4 6.45 0s4.25 1.4 6.45 0" />
        </>
      )
      break
    case 'cutlery':
      glyph = (
        <>
          <path d="M7 5v8.5M4.25 5v5.5a2.75 2.75 0 0 0 5.5 0V5M7 13.5V27" />
          <path d="M20 5v22M20 5c4 2.55 5.3 6.25 5.3 11H20" />
          <path d="M4.25 9.5h5.5" />
        </>
      )
      break
    case 'napkins':
      glyph = (
        <>
          <path className="angle-service-glyph-accent" d="M6 6h20v20H6V6Z" />
          <path d="M6 6h20v20H6V6Z" />
          <path d="m6 6 20 20M6 26l10-10L26 6" />
          <path d="M9 29h17a3 3 0 0 0 3-3V9" />
        </>
      )
      break
    case 'bread':
      glyph = (
        <>
          <path className="angle-service-glyph-accent" d="M5.5 18.5c-2.2-1.4-2-5 .35-6.1C6.25 8.3 10.2 6 16 6s9.75 2.3 10.15 6.4c2.35 1.1 2.55 4.7.35 6.1C25.2 23.5 21.5 26 16 26s-9.2-2.5-10.5-7.5Z" />
          <path d="M5.5 18.5c-2.2-1.4-2-5 .35-6.1C6.25 8.3 10.2 6 16 6s9.75 2.3 10.15 6.4c2.35 1.1 2.55 4.7.35 6.1C25.2 23.5 21.5 26 16 26s-9.2-2.5-10.5-7.5Z" />
          <path d="m11 10-1.25 4M16 9l-1.25 4.5M21 10l-1.25 4" />
        </>
      )
      break
    case 'next_course':
      glyph = (
        <>
          <path className="angle-service-glyph-accent" d="M7.5 24a8.5 8.5 0 0 1 17 0h-17Z" />
          <path d="M5 24h22M7.5 24a8.5 8.5 0 0 1 17 0M16 14.5V5" />
          <path d="m12.5 8.5 3.5-3.5 3.5 3.5" />
          <path d="M4 27h24" />
        </>
      )
      break
    case 'hold_course':
      glyph = (
        <>
          <path className="angle-service-glyph-accent" d="M7.5 24a8.5 8.5 0 0 1 17 0h-17Z" />
          <path d="M5 24h22M7.5 24a8.5 8.5 0 0 1 17 0M4 27h24" />
          <path d="M12.5 5v8M19.5 5v8" strokeWidth="2.4" />
        </>
      )
      break
    case 'bill':
      glyph = (
        <>
          <path className="angle-service-glyph-accent" d="M8 4h16v24l-2.65-1.75L18.7 28l-2.7-1.75L13.3 28l-2.65-1.75L8 28V4Z" />
          <path d="M8 4h16v24l-2.65-1.75L18.7 28l-2.7-1.75L13.3 28l-2.65-1.75L8 28V4Z" />
          <path d="M12 10h8M12 15h8M12 20h4.5" />
          <circle cx="20" cy="20" r="1.1" fill="currentColor" stroke="none" />
        </>
      )
      break
    case 'problem':
      glyph = (
        <>
          <path className="angle-service-glyph-accent" d="M6 5h20v17H14l-6.5 5v-5H6V5Z" />
          <path d="M6 5h20v17H14l-6.5 5v-5H6V5Z" />
          <path d="M16 10v6M16 19.5h.01" strokeWidth="2.4" />
        </>
      )
      break
    default:
      glyph = (
        <>
          <path className="angle-service-glyph-accent" d="M7.5 23a8.5 8.5 0 0 1 17 0h-17Z" />
          <path d="M5 23h22M7.5 23a8.5 8.5 0 0 1 17 0M16 13.5V9M13.5 9h5M4 27h24" />
          <path d="M6.5 11.5 4.5 9.5M25.5 11.5l2-2" />
        </>
      )
  }

  return (
    <svg
      className="angle-service-glyph"
      data-service-icon={kind}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {glyph}
    </svg>
  )
}
