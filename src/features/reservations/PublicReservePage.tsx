import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { t, formatTime, type Lang } from '../../lib/i18n'
import { PublicApiError } from '../online/publicApi'
import {
  fetchReserveInfo, submitPublicReservation, fetchPublicReservationStatus,
  cancelPublicReservation, type ReserveStatus,
} from './publicReserveApi'
import BrandSplash from '../../components/ui/BrandSplash'

/**
 * Публичная страница брони стола (053): форма (дата/время/гости/контакты) →
 * заявка → ожидание подтверждения кассой (поллинг) → подтверждена/отклонена.
 * Гость может отменить бронь. Мобильная, he по умолчанию.
 * Никакого Supabase-клиента: только Edge Function с anon-ключом.
 */

const LANG_KEY = 'kassa-public-lang' // общий с /order — язык гость выбрал один раз
const ACTIVE_KEY = 'kassa-public-reserve' // {clientUuid, locId} — текущая бронь

function readActive(locId: string): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { clientUuid: string; locId: string }
    return parsed.locId === locId ? parsed.clientUuid : null
  } catch {
    return null
  }
}

export default function PublicReservePage() {
  const { locId = '' } = useParams()
  const [lang] = useState<Lang>(() => (localStorage.getItem(LANG_KEY) as Lang) ?? 'he')
  useEffect(() => {
    localStorage.setItem(LANG_KEY, lang)
    // <html lang> решает RTL в проде: start/end скомпилированы через :lang(he)
    document.documentElement.lang = lang
  }, [lang])
  const isRtl = lang === 'he'

  // Незавершённая бронь переживает перезагрузку страницы
  const [activeUuid, setActiveUuid] = useState<string | null>(() => readActive(locId))

  const { data: info, isLoading, isError } = useQuery({
    queryKey: ['public_reserve_info', locId],
    queryFn: () => fetchReserveInfo(locId),
    staleTime: 30_000,
  })

  function startNew() {
    localStorage.removeItem(ACTIVE_KEY)
    setActiveUuid(null)
  }

  const title = info?.location.business_name || info?.location.name
  const logo = info?.location.logo_url

  if (activeUuid) {
    return (
      <Shell isRtl={isRtl} title={title} logo={logo}>
        <StatusScreen lang={lang} clientUuid={activeUuid} onNew={startNew} />
      </Shell>
    )
  }

  if (isLoading) {
    return (
      <>
        <BrandSplash done={false} />
        <Shell isRtl={isRtl}>
          <div className="py-24 text-center text-gray-500">{t(lang, 'loading')}</div>
        </Shell>
      </>
    )
  }
  if (isError || !info) {
    return (
      <>
        <BrandSplash />
        <Shell isRtl={isRtl}>
          <div className="py-24 text-center text-gray-500">{t(lang, 'pubMenuError')}</div>
        </Shell>
      </>
    )
  }

  return (
    <>
      <BrandSplash />
      <Shell isRtl={isRtl} title={title} logo={logo}>
        {info.location.accepting ? (
          <ReserveForm
            lang={lang}
            locId={locId}
            onSubmitted={(uuid) => {
              localStorage.setItem(ACTIVE_KEY, JSON.stringify({ clientUuid: uuid, locId }))
              setActiveUuid(uuid)
            }}
          />
        ) : (
          <div className="mx-4 mt-6 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3">
            {t(lang, 'rsvClosed')}
          </div>
        )}
      </Shell>
    </>
  )
}

/** Колонка страницы: логотип + название заведения, контент под ними */
function Shell({ isRtl, title, logo, children }: {
  isRtl: boolean
  title?: string
  logo?: string | null
  children: React.ReactNode
}) {
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#eceef1]">
      <div className="relative max-w-lg mx-auto min-h-screen flex flex-col bg-white">
        <header className="px-8 pt-8 pb-2 text-center">
          {logo && <img src={logo} alt="" className="w-16 h-16 rounded-full object-cover mx-auto" />}
          <h1 className={`text-3xl font-black leading-tight text-gray-900 ${logo ? 'mt-3' : 'mt-4'}`}>
            {title ?? ''}
          </h1>
        </header>
        <div className="flex-1 flex flex-col">{children}</div>
      </div>
    </div>
  )
}

function toDateInput(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function reserveErrorText(lang: Lang, code: string): string {
  switch (code) {
    case 'disabled': return t(lang, 'rsvErrDisabled')
    case 'rate_limited': return t(lang, 'rsvErrRate')
    case 'busy': return t(lang, 'rsvErrBusy')
    case 'invalid_time': return t(lang, 'rsvErrTime')
    case 'invalid_phone': return t(lang, 'rsvErrPhone')
    default: return t(lang, 'rsvErrUnknown')
  }
}

function ReserveForm({ lang, locId, onSubmitted }: {
  lang: Lang
  locId: string
  onSubmitted: (clientUuid: string) => void
}) {
  const [date, setDate] = useState(() => toDateInput(new Date()))
  const [time, setTime] = useState('')
  const [guests, setGuests] = useState(2)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // client_uuid создаётся один раз на попытку: ретрай после сбоя сети
  // не создаст дубликат (идемпотентность submit_reservation)
  const clientUuid = useMemo(() => crypto.randomUUID(), [])

  // Границы календаря фиксируются на маунте (серверная валидация — своя)
  const [dateBounds] = useState(() => ({
    min: toDateInput(new Date()),
    max: toDateInput(new Date(Date.now() + 30 * 24 * 3600_000)),
  }))
  const phoneDigits = phone.replace(/\D/g, '')
  const valid = date !== '' && time !== '' && name.trim().length > 0 && phoneDigits.length >= 9

  async function submit() {
    if (!valid || busy) return
    // Локальное время визита; серверная граница — от +30 минут
    const [h, m] = time.split(':').map(Number)
    const at = new Date(`${date}T00:00:00`)
    at.setHours(h, m, 0, 0)
    if (at.getTime() < Date.now() + 30 * 60_000) {
      setError(t(lang, 'rsvErrTime'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await submitPublicReservation({
        loc: locId,
        client_uuid: clientUuid,
        name: name.trim(),
        phone: phoneDigits,
        party_size: guests,
        reserved_at: at.toISOString(),
        note: note.trim() || null,
      })
      onSubmitted(clientUuid)
    } catch (e) {
      const code = e instanceof PublicApiError ? e.code : 'unknown'
      setError(reserveErrorText(lang, code))
      setBusy(false)
    }
  }

  const inputCls = 'w-full h-12 rounded-xl border border-gray-200 px-4 text-base focus:outline-none focus:border-gray-900'

  return (
    <div className="px-4 pb-8">
      <h2 className="text-lg font-bold text-gray-900 mt-6 mb-3">{t(lang, 'rsvFormTitle')}</h2>

      <div className="space-y-3">
        <div className="flex gap-2">
          <label className="flex-1">
            <span className="block text-xs font-semibold text-gray-500 mb-1">{t(lang, 'rsvDate')}</span>
            <input
              type="date"
              className={inputCls}
              min={dateBounds.min}
              max={dateBounds.max}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="flex-1">
            <span className="block text-xs font-semibold text-gray-500 mb-1">{t(lang, 'rsvTime')}</span>
            <input
              type="time"
              className={inputCls}
              step={900}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        </div>

        <div>
          <span className="block text-xs font-semibold text-gray-500 mb-1">{t(lang, 'rsvGuests')}</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="w-12 h-12 rounded-xl bg-gray-100 text-xl font-bold text-gray-900 active:scale-[0.94] transition-all disabled:opacity-40"
              disabled={guests <= 1}
              onClick={() => setGuests((g) => Math.max(1, g - 1))}
            >
              −
            </button>
            <span className="w-12 text-center text-xl font-black tabular-nums text-gray-900">{guests}</span>
            <button
              type="button"
              className="w-12 h-12 rounded-xl bg-gray-100 text-xl font-bold text-gray-900 active:scale-[0.94] transition-all disabled:opacity-40"
              disabled={guests >= 20}
              onClick={() => setGuests((g) => Math.min(20, g + 1))}
            >
              +
            </button>
          </div>
        </div>

        <input
          className={inputCls}
          placeholder={t(lang, 'rsvName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={inputCls}
          placeholder={t(lang, 'rsvPhone')}
          type="tel"
          inputMode="tel"
          dir="ltr"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <textarea
          className="w-full rounded-xl border border-gray-200 px-4 py-3 text-base focus:outline-none focus:border-gray-900 resize-none"
          rows={2}
          maxLength={200}
          placeholder={t(lang, 'rsvNote')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {error && <div className="mt-4 rounded-2xl bg-red-50 text-red-600 text-sm font-semibold px-4 py-3">{error}</div>}

      <button
        disabled={!valid || busy}
        onClick={submit}
        className="w-full h-14 mt-4 rounded-2xl bg-gray-900 text-white font-bold disabled:opacity-40 active:scale-[0.98] transition-all"
      >
        {busy ? t(lang, 'pubSubmitting') : t(lang, 'rsvSubmit')}
      </button>
    </div>
  )
}

/** Дата визита в человеческом виде: «пт, 18 июля, 19:30» */
function visitLabel(iso: string, lang: Lang): string {
  const d = new Date(iso)
  const day = d.toLocaleDateString(lang === 'he' ? 'he-IL' : 'ru-RU', {
    weekday: 'short', day: 'numeric', month: 'long',
  })
  return `${day}, ${formatTime(iso, lang)}`
}

/** Статус брони: поллинг каждые 5 секунд; отмена гостем — двухшагово */
function StatusScreen({ lang, clientUuid, onNew }: {
  lang: Lang
  clientUuid: string
  onNew: () => void
}) {
  const [status, setStatus] = useState<ReserveStatus | null>(null)
  const [lost, setLost] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)

  useEffect(() => {
    let stopped = false
    async function poll() {
      try {
        const s = await fetchPublicReservationStatus(clientUuid)
        if (!stopped) {
          setStatus(s)
          setLost(false)
        }
      } catch (e) {
        if (!stopped && e instanceof PublicApiError && e.code === 'not_found') setLost(true)
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [clientUuid])

  async function doCancel() {
    if (cancelBusy) return
    setCancelBusy(true)
    try {
      await cancelPublicReservation(clientUuid)
      setStatus((s) => (s ? { ...s, status: 'cancelled' } : s))
    } catch { /* поллинг догонит актуальный статус */ }
    setCancelBusy(false)
    setConfirmCancel(false)
  }

  if (lost) {
    return (
      <CenterCard>
        <p className="font-bold text-gray-900">{t(lang, 'pubStatusLost')}</p>
        <NewBtn lang={lang} onClick={onNew} />
      </CenterCard>
    )
  }
  if (!status) {
    return <CenterCard><p className="text-gray-500">{t(lang, 'loading')}</p></CenterCard>
  }

  if (status.status === 'rejected') {
    return (
      <CenterCard>
        <p className="text-2xl font-black text-gray-900">{t(lang, 'rsvRejectedTitle')}</p>
        <p className="text-sm text-gray-500 mt-2">{status.reject_reason || t(lang, 'rsvRejectedHint')}</p>
        <NewBtn lang={lang} onClick={onNew} />
      </CenterCard>
    )
  }

  if (status.status === 'cancelled') {
    return (
      <CenterCard>
        <p className="text-2xl font-black text-gray-900">{t(lang, 'rsvCancelledTitle')}</p>
        <NewBtn lang={lang} onClick={onNew} />
      </CenterCard>
    )
  }

  const details = (
    <div className="mt-4 rounded-2xl bg-gray-50 px-4 py-3 text-start">
      <div className="font-bold text-gray-900">{visitLabel(status.reserved_at, lang)}</div>
      <div className="text-sm text-gray-500 mt-1">
        {status.customer_name} · {status.party_size} {t(lang, 'resGuestsShort')}
        {status.table_label && <> · {t(lang, 'tableLabel')} {status.table_label}</>}
      </div>
    </div>
  )

  const cancelBlock = confirmCancel ? (
    <div className="flex gap-2 mt-6">
      <button
        className="flex-1 h-12 rounded-xl bg-gray-100 text-sm font-semibold text-gray-700 active:scale-[0.97] transition-all"
        onClick={() => setConfirmCancel(false)}
      >
        {t(lang, 'back')}
      </button>
      <button
        className="flex-1 h-12 rounded-xl bg-red-600 text-white text-sm font-bold active:scale-[0.97] transition-all disabled:opacity-40"
        disabled={cancelBusy}
        onClick={doCancel}
      >
        {t(lang, 'rsvCancelConfirm')}
      </button>
    </div>
  ) : (
    <button
      className="w-full h-12 mt-6 rounded-xl bg-gray-100 text-sm font-semibold text-gray-700 active:scale-[0.97] transition-all"
      onClick={() => setConfirmCancel(true)}
    >
      {t(lang, 'rsvCancelAction')}
    </button>
  )

  if (status.status === 'new') {
    return (
      <CenterCard>
        <div className="w-10 h-10 mx-auto rounded-full border-4 border-gray-200 border-t-gray-900 animate-spin" />
        <p className="text-xl font-bold text-gray-900 mt-5">{t(lang, 'rsvPendingTitle')}</p>
        <p className="text-sm text-gray-500 mt-2">{t(lang, 'rsvPendingHint')}</p>
        {details}
        {cancelBlock}
      </CenterCard>
    )
  }

  // confirmed
  return (
    <CenterCard>
      <div className="w-14 h-14 mx-auto rounded-full bg-green-100 flex items-center justify-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 13l4 4L19 7" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <p className="text-2xl font-black text-gray-900 mt-4">{t(lang, 'rsvConfirmedTitle')}</p>
      <p className="text-sm text-gray-500 mt-2">{t(lang, 'rsvConfirmedHint')}</p>
      {details}
      {cancelBlock}
    </CenterCard>
  )
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-6">
      <div className="text-center w-full">{children}</div>
    </div>
  )
}

function NewBtn({ lang, onClick }: { lang: Lang; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mt-6 h-12 px-6 rounded-xl bg-gray-900 text-white text-sm font-bold active:scale-[0.97] transition-all"
    >
      {t(lang, 'rsvNewAction')}
    </button>
  )
}
