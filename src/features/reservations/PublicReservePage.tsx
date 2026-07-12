import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { t, formatTime, type Lang } from '../../lib/i18n'
import { PublicApiError } from '../online/publicApi'
import {
  fetchReserveInfo, submitPublicReservation, fetchPublicReservationStatus,
  cancelPublicReservation, type ReserveInfo, type ReserveStatus,
} from './publicReserveApi'
import BrandSplash from '../../components/ui/BrandSplash'

/**
 * Публичная страница брони стола (053), флоу как у Tabit:
 * шаг 1 — фото-шапка, название+адрес, слот (дата/время/гости — селекты,
 * время только дискретное с шагом 15 мин) → шаг 2 — контакты → заявка →
 * ожидание подтверждения кассой (поллинг) → подтверждена/отклонена.
 * Гость может отменить бронь. Мобильная, he по умолчанию.
 * Никакого Supabase-клиента: только Edge Function с anon-ключом.
 */

const LANG_KEY = 'kassa-public-lang' // общий с /order — язык гость выбрал один раз
const ACTIVE_KEY = 'kassa-public-reserve' // {clientUuid, locId} — текущая бронь

// Слоты времени: 07:00–23:45 с шагом 15 минут (рабочих часов в модели нет —
// неподходящее время касса просто отклонит)
const SLOT_FROM_H = 7
const SLOT_TO_H = 23
const DAYS_AHEAD = 30

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

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Слоты дня; для сегодняшнего — не раньше minTs (бронь минимум за 30 мин) */
function slotsFor(dateStr: string, todayStr: string, minTs: number): string[] {
  const out: string[] = []
  for (let h = SLOT_FROM_H; h <= SLOT_TO_H; h++) {
    for (const m of [0, 15, 30, 45]) {
      if (dateStr === todayStr) {
        const d = new Date(`${dateStr}T00:00:00`)
        d.setHours(h, m, 0, 0)
        if (d.getTime() < minTs) continue
      }
      out.push(`${pad(h)}:${pad(m)}`)
    }
  }
  return out
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

  // Календарь и «сейчас» фиксируются на маунте (страница короткоживущая;
  // серверная валидация окна — своя, submit перепроверяет)
  const [slotCtx] = useState(() => {
    const now = new Date()
    const todayStr = toDateInput(now)
    const minTs = now.getTime() + 30 * 60_000
    const days: string[] = []
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
      days.push(toDateInput(d))
    }
    const todayHasSlots = slotsFor(todayStr, todayStr, minTs).length > 0
    return { todayStr, minTs, days, todayHasSlots }
  })

  // Выбранный слот (шаг 1) и шаг флоу: слот → точное время (чипы) → контакты
  const [step, setStep] = useState<'slot' | 'times' | 'details'>('slot')
  const [date, setDate] = useState(() => (slotCtx.todayHasSlots ? slotCtx.days[0] : slotCtx.days[1]))
  const [time, setTime] = useState(() => {
    const slots = slotsFor(
      slotCtx.todayHasSlots ? slotCtx.days[0] : slotCtx.days[1],
      slotCtx.todayStr, slotCtx.minTs
    )
    return slots.find((s) => s >= '12:00') ?? slots[0] ?? '12:00'
  })
  const [guests, setGuests] = useState(2)

  const timeSlots = useMemo(
    () => slotsFor(date, slotCtx.todayStr, slotCtx.minTs),
    [date, slotCtx]
  )

  function pickDate(next: string) {
    setDate(next)
    const slots = slotsFor(next, slotCtx.todayStr, slotCtx.minTs)
    if (!slots.includes(time)) setTime(slots.find((s) => s >= '12:00') ?? slots[0] ?? '12:00')
  }

  function startNew() {
    localStorage.removeItem(ACTIVE_KEY)
    setActiveUuid(null)
    setStep('slot')
  }

  if (activeUuid) {
    return (
      <Shell isRtl={isRtl} info={info} lang={lang}>
        <StatusScreen lang={lang} clientUuid={activeUuid} onNew={startNew} />
      </Shell>
    )
  }

  if (isLoading) {
    return (
      <>
        <BrandSplash done={false} />
        <Shell isRtl={isRtl} lang={lang}>
          <div className="py-24 text-center text-gray-500">{t(lang, 'loading')}</div>
        </Shell>
      </>
    )
  }
  if (isError || !info) {
    return (
      <>
        <BrandSplash />
        <Shell isRtl={isRtl} lang={lang}>
          <div className="py-24 text-center text-gray-500">{t(lang, 'pubMenuError')}</div>
        </Shell>
      </>
    )
  }

  if (!info.location.accepting) {
    return (
      <>
        <BrandSplash />
        <Shell isRtl={isRtl} info={info} lang={lang} hero>
          <div className="mx-4 mt-6 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3">
            {t(lang, 'rsvClosed')}
          </div>
        </Shell>
      </>
    )
  }

  return (
    <>
      <BrandSplash />
      <Shell isRtl={isRtl} info={info} lang={lang} hero={step === 'slot'}>
        {step === 'slot' && (
          <SlotScreen
            lang={lang}
            info={info}
            days={slotCtx.days}
            todayStr={slotCtx.todayStr}
            todayHasSlots={slotCtx.todayHasSlots}
            date={date}
            time={time}
            guests={guests}
            timeSlots={timeSlots}
            onDate={pickDate}
            onTime={setTime}
            onGuests={setGuests}
            onNext={() => setStep('times')}
          />
        )}
        {step === 'times' && (
          <TimesScreen
            lang={lang}
            date={date}
            time={time}
            guests={guests}
            timeSlots={timeSlots}
            todayStr={slotCtx.todayStr}
            onBack={() => setStep('slot')}
            onPick={(v) => {
              setTime(v)
              setStep('details')
            }}
          />
        )}
        {step === 'details' && (
          <DetailsScreen
            lang={lang}
            locId={locId}
            date={date}
            time={time}
            guests={guests}
            todayStr={slotCtx.todayStr}
            onBack={() => setStep('times')}
            onSubmitted={(uuid) => {
              localStorage.setItem(ACTIVE_KEY, JSON.stringify({ clientUuid: uuid, locId }))
              setActiveUuid(uuid)
            }}
          />
        )}
      </Shell>
    </>
  )
}

/**
 * Колонка страницы. hero — фото-шапка во всю ширину (общая картинка
 * с гостевой страницей заказа), под ней ярлык/название/адрес по центру.
 * Без hero (шаг контактов, статус) — только название и адрес.
 */
function Shell({ isRtl, info, lang, hero, children }: {
  isRtl: boolean
  info?: ReserveInfo
  lang: Lang
  hero?: boolean
  children: React.ReactNode
}) {
  const loc = info?.location
  const title = loc?.business_name || loc?.name
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="min-h-screen bg-[#eceef1]">
      <div className="relative max-w-lg mx-auto min-h-screen flex flex-col bg-white">
        {hero && loc?.header_url && (
          <div className="h-48 shrink-0 overflow-hidden">
            <img src={loc.header_url} alt="" className="w-full h-full object-cover" />
          </div>
        )}
        <header className="px-6 pt-6 pb-2 text-center">
          {hero && !loc?.header_url && loc?.logo_url && (
            <img src={loc.logo_url} alt="" className="w-16 h-16 rounded-full object-cover mx-auto mb-3" />
          )}
          <div className="text-sm text-gray-500">{t(lang, 'rsvPageLabel')}</div>
          <h1 className="text-3xl font-black leading-tight text-gray-900 mt-1">{title ?? ''}</h1>
          {loc?.address && <p className="text-sm text-gray-500 mt-1">{loc.address}</p>}
        </header>
        <div className="flex-1 flex flex-col">{children}</div>
      </div>
    </div>
  )
}

/** «Сегодня» / «пн 13/7» — подпись дня в селекте */
function dayOptionLabel(dateStr: string, todayStr: string, lang: Lang): string {
  if (dateStr === todayStr) return t(lang, 'today')
  const d = new Date(`${dateStr}T12:00:00`)
  const wd = d.toLocaleDateString(lang === 'he' ? 'he-IL' : 'ru-RU', { weekday: 'short' })
  return `${wd} ${d.getDate()}/${d.getMonth() + 1}`
}

/** Ячейка слот-панели: значение — текстом, невидимый select растянут на всю плитку (тап везде) */
function SlotCell({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="relative flex-1 min-w-0 py-3">
      <div className="flex justify-center text-gray-400">{icon}</div>
      <div className="mt-1 px-6 text-center font-bold text-gray-900 text-base truncate">{label}</div>
      <span className="pointer-events-none absolute top-3 end-2 text-gray-400">
        <Chevron />
      </span>
      {children}
    </div>
  )
}

const SELECT_CLS = 'absolute inset-0 w-full h-full opacity-0 cursor-pointer text-base'

function SlotScreen({ lang, info, days, todayStr, todayHasSlots, date, time, guests, timeSlots, onDate, onTime, onGuests, onNext }: {
  lang: Lang
  info: ReserveInfo
  days: string[]
  todayStr: string
  todayHasSlots: boolean
  date: string
  time: string
  guests: number
  timeSlots: string[]
  onDate: (v: string) => void
  onTime: (v: string) => void
  onGuests: (v: number) => void
  onNext: () => void
}) {
  const loc = info.location
  const mapsUrl = loc.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.address)}`
    : null
  return (
    <div className="px-4 pb-8 flex flex-col items-center">
      {!todayHasSlots && (
        <div className="w-full mt-3 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3 text-center">
          {t(lang, 'rsvNoSlotsToday')}
        </div>
      )}

      {/* Слот-панель: дата · время · гости (селекты, время дискретно по 15 мин) */}
      <div className="w-full mt-4 rounded-2xl border border-gray-200 shadow-sm flex divide-x divide-gray-100 rtl:divide-x-reverse">
        <SlotCell icon={<CalendarIcon />} label={dayOptionLabel(date, todayStr, lang)}>
          <select className={SELECT_CLS} value={date} onChange={(e) => onDate(e.target.value)} aria-label={t(lang, 'rsvDate')}>
            {days.map((d) => (
              // Сегодня без слотов — день виден, но выбрать нельзя
              <option key={d} value={d} disabled={d === todayStr && !todayHasSlots}>
                {dayOptionLabel(d, todayStr, lang)}
              </option>
            ))}
          </select>
        </SlotCell>
        <SlotCell icon={<ClockIcon />} label={time}>
          <select className={SELECT_CLS} value={time} onChange={(e) => onTime(e.target.value)} aria-label={t(lang, 'rsvTime')}>
            {timeSlots.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </SlotCell>
        <SlotCell icon={<PersonIcon />} label={`${guests} ${t(lang, 'resGuestsShort')}`}>
          <select className={SELECT_CLS} value={guests} onChange={(e) => onGuests(Number(e.target.value))} aria-label={t(lang, 'rsvGuests')}>
            {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n} {t(lang, 'resGuestsShort')}</option>
            ))}
          </select>
        </SlotCell>
      </div>

      <button
        onClick={onNext}
        disabled={timeSlots.length === 0}
        className="h-14 px-10 mt-6 rounded-2xl bg-gray-900 text-white font-bold disabled:opacity-40 active:scale-[0.98] transition-all"
      >
        {t(lang, 'rsvSubmit')}
      </button>

      <p className="text-sm text-gray-500 mt-4 text-center">{t(lang, 'rsvChooseHint')}</p>

      {(loc.phone || mapsUrl) && (
        <div className="flex gap-3 mt-6">
          {loc.phone && (
            <a
              href={`tel:${loc.phone}`}
              className="w-24 h-20 rounded-2xl border border-gray-300 flex flex-col items-center justify-center gap-1 text-gray-900 active:scale-[0.96] transition-all"
            >
              <PhoneIcon />
              <span className="text-xs font-semibold">{t(lang, 'rsvPhoneBtn')}</span>
            </a>
          )}
          {mapsUrl && (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noreferrer"
              className="w-24 h-20 rounded-2xl border border-gray-300 flex flex-col items-center justify-center gap-1 text-gray-900 active:scale-[0.96] transition-all"
            >
              <PinIcon />
              <span className="text-xs font-semibold">{t(lang, 'rsvNavigateBtn')}</span>
            </a>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Точное время (как у Tabit): чипы вокруг запрошенного слота, ±2 по
 * 15 минут (окно сдвигается у краёв дня). Запрошенное — в жирной рамке;
 * тап по любому чипу ведёт к контактам с этим временем.
 */
function TimesScreen({ lang, date, time, guests, timeSlots, todayStr, onBack, onPick }: {
  lang: Lang
  date: string
  time: string
  guests: number
  timeSlots: string[]
  todayStr: string
  onBack: () => void
  onPick: (v: string) => void
}) {
  const chips = useMemo(() => {
    const i = Math.max(0, timeSlots.indexOf(time))
    const start = Math.max(0, Math.min(i - 2, timeSlots.length - 5))
    return timeSlots.slice(start, start + 5)
  }, [timeSlots, time])

  return (
    <div className="px-4 pb-8">
      <button
        onClick={onBack}
        className="mt-1 h-11 px-3 -ms-3 text-sm font-semibold text-gray-500 flex items-center gap-1 active:scale-[0.96] transition-all"
      >
        <span className="rtl:rotate-180"><BackIcon /></span>
        {t(lang, 'rsvBackToSlot')}
      </button>

      <h2 className="text-lg font-bold text-gray-900 mt-2">{t(lang, 'rsvPickTimeTitle')}</h2>
      <p className="text-sm text-gray-500 mt-1">
        {dayOptionLabel(date, todayStr, lang)} · {guests} {t(lang, 'resGuestsShort')}
      </p>

      <div className="grid grid-cols-5 gap-2 mt-4">
        {chips.map((s) => {
          const current = s === time
          return (
            <button
              key={s}
              onClick={() => onPick(s)}
              className={`h-14 rounded-xl bg-white text-base font-bold tabular-nums text-gray-900 active:scale-[0.96] transition-all ${
                current ? 'border-2 border-gray-900' : 'border border-gray-200 hover:border-gray-400'
              }`}
            >
              {s}
            </button>
          )
        })}
      </div>
    </div>
  )
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

function DetailsScreen({ lang, locId, date, time, guests, todayStr, onBack, onSubmitted }: {
  lang: Lang
  locId: string
  date: string
  time: string
  guests: number
  todayStr: string
  onBack: () => void
  onSubmitted: (clientUuid: string) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // client_uuid создаётся один раз на попытку: ретрай после сбоя сети
  // не создаст дубликат (идемпотентность submit_reservation)
  const clientUuid = useMemo(() => crypto.randomUUID(), [])

  const phoneDigits = phone.replace(/\D/g, '')
  const valid = name.trim().length > 0 && phoneDigits.length >= 9

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
      <button
        onClick={onBack}
        className="mt-1 h-11 px-3 -ms-3 text-sm font-semibold text-gray-500 flex items-center gap-1 active:scale-[0.96] transition-all"
      >
        <span className="rtl:rotate-180"><BackIcon /></span>
        {t(lang, 'rsvBackToSlot')}
      </button>

      {/* Выбранный слот — статичная сводка, менять — «назад к выбору» */}
      <div className="rounded-2xl bg-gray-50 flex divide-x divide-gray-200 rtl:divide-x-reverse text-center mt-2">
        <div className="flex-1 py-3">
          <div className="flex justify-center text-gray-400"><CalendarIcon /></div>
          <div className="font-bold text-gray-900 mt-1">{dayOptionLabel(date, todayStr, lang)}</div>
        </div>
        <div className="flex-1 py-3">
          <div className="flex justify-center text-gray-400"><ClockIcon /></div>
          <div className="font-bold text-gray-900 mt-1 tabular-nums">{time}</div>
        </div>
        <div className="flex-1 py-3">
          <div className="flex justify-center text-gray-400"><PersonIcon /></div>
          <div className="font-bold text-gray-900 mt-1">{guests} {t(lang, 'resGuestsShort')}</div>
        </div>
      </div>

      <h2 className="text-base font-bold text-gray-900 mt-6 mb-3 text-center">{t(lang, 'rsvDetailsTitle')}</h2>

      <div className="space-y-3">
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
        {busy ? t(lang, 'pubSubmitting') : t(lang, 'rsvSend')}
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
    <div className="flex-1 flex items-center justify-center px-6 py-10">
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

// ── Иконки (инлайн, наследуют currentColor) ──────────────────

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PersonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function PhoneIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
