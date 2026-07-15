import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import { t, formatTime, type Lang } from '../../lib/i18n'
import { PublicApiError } from '../online/publicApi'
import {
  fetchReserveInfo, submitPublicReservation, fetchPublicReservationStatus,
  cancelPublicReservation, fetchAvailability,
  type ReserveInfo, type ReserveStatus,
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

const ACTIVE_KEY = 'kassa-public-reserve' // {clientUuid, locId} — текущая бронь

// Слоты времени по умолчанию: 07:00–23:45, шаг 15 мин. Если владелец задал
// часы приёма (059), окно и шаг приходят из настроек точки (slotParams).
const DEF_FROM_MIN = 7 * 60
const DEF_TO_MIN = 23 * 60 + 45
const DEF_STEP_MIN = 15
const DAYS_AHEAD = 30

/** 'HH:MM' → минуты от полуночи; null/мусор → fallback */
function hmToMin(s: string | null | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '')
  if (!m) return fallback
  return Number(m[1]) * 60 + Number(m[2])
}

export interface SlotParams {
  fromMin: number
  toMin: number
  stepMin: number
}

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

/** Слоты дня в окне [from,to] с шагом; для сегодняшнего — не раньше minTs */
function slotsFor(dateStr: string, todayStr: string, minTs: number, p?: SlotParams): string[] {
  const fromMin = p?.fromMin ?? DEF_FROM_MIN
  const toMin = p?.toMin ?? DEF_TO_MIN
  const step = p?.stepMin && p.stepMin > 0 ? p.stepMin : DEF_STEP_MIN
  const out: string[] = []
  for (let mins = fromMin; mins <= toMin; mins += step) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    if (dateStr === todayStr) {
      const d = new Date(`${dateStr}T00:00:00`)
      d.setHours(h, m, 0, 0)
      if (d.getTime() < minTs) continue
    }
    out.push(`${pad(h)}:${pad(m)}`)
  }
  return out
}

export default function PublicReservePage() {
  const { locId = '' } = useParams()
  // Гостевая страница — всегда иврит (бронь he-first), без переключения языка.
  const lang: Lang = 'he'
  useEffect(() => {
    // <html lang> решает RTL в проде: start/end скомпилированы через :lang(he)
    document.documentElement.lang = lang
  }, [])
  const isRtl = true

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

  // Выбранный слот (шаг 1) и шаг флоу: слот → точное время → контакты
  const [step, setStep] = useState<'slot' | 'times' | 'details'>('slot')
  // Зона зала (072): пожелание гостя, null = без предпочтений. На шаге
  // точного времени зоны показываются секциями (Ontopo-стиль): у каждой
  // свой ряд времён; выбор времени в секции = бронь этой зоны. Задаётся
  // при тапе по слоту вместе со временем.
  const [zoneId, setZoneId] = useState<string | null>(null)
  const [date, setDate] = useState(() => (slotCtx.todayHasSlots ? slotCtx.days[0] : slotCtx.days[1]))
  const [time, setTime] = useState(() => {
    const slots = slotsFor(
      slotCtx.todayHasSlots ? slotCtx.days[0] : slotCtx.days[1],
      slotCtx.todayStr, slotCtx.minTs
    )
    return slots.find((s) => s >= '12:00') ?? slots[0] ?? '12:00'
  })
  const [guests, setGuests] = useState(2)

  // Часы приёма из настроек точки (059): обе границы заданы → окно слотов
  // сужается, иначе дефолт 07:00–23:45. slot_min задаёт шаг.
  const slotParams = useMemo<SlotParams>(() => ({
    fromMin: hmToMin(info?.location.open, DEF_FROM_MIN),
    toMin: hmToMin(info?.location.close, DEF_TO_MIN),
    stepMin: info?.location.slot_min && info.location.slot_min > 0 ? info.location.slot_min : DEF_STEP_MIN,
  }), [info])

  // Лимит гостей (061): настройка владельца, дефолт 20, потолок 50
  const maxParty = useMemo(() => {
    const m = info?.location.max_party
    return m && m >= 1 && m <= 50 ? m : 20
  }, [info])

  const timeSlots = useMemo(
    () => slotsFor(date, slotCtx.todayStr, slotCtx.minTs, slotParams),
    [date, slotCtx, slotParams]
  )

  // Live-доступность (063): только в instant-режиме. Множество СВОБОДНЫХ
  // времён на выбранную дату+число гостей; занятые в UI дизейблятся.
  const instant = info?.location.instant === true
  const { data: avail } = useQuery({
    queryKey: ['reserve_avail', locId, date, guests],
    queryFn: () => fetchAvailability(locId, date, guests),
    enabled: instant && !!info?.location.accepting,
    staleTime: 20_000,
  })
  const freeTimes = useMemo(() => {
    if (!instant || !avail) return null // null = доступность не применяется (все свободны)
    return new Set(avail.slots.filter((s) => s.free).map((s) => s.time))
  }, [instant, avail])

  // Зоны зала (072): выбор осмыслен от двух зон (одну — 066 создаёт всем)
  const zones = useMemo(() => info?.location.zones ?? [], [info])
  const zoneName = zoneId ? zones.find((z) => z.id === zoneId)?.name ?? null : null

  // Сверки во время рендера (реком. React вместо эффекта):
  // 1) Сегодня без слотов (часы приёма подгрузились и окно на сегодня пусто) —
  //    сдвигаем выбор на следующий день.
  if (date === slotCtx.todayStr && timeSlots.length === 0 && slotCtx.days.length > 1) {
    setDate(slotCtx.days[1])
  } else if (timeSlots.length > 0 && !timeSlots.includes(time)) {
    // 2) Выбранное время выпало из окна (часы подгрузились/сменился день) — берём ближайшее.
    setTime(timeSlots.find((s) => s >= '12:00') ?? timeSlots[0])
  }
  // 3) Гостей больше нового лимита — подрезаем.
  if (guests > maxParty) {
    setGuests(maxParty)
  }

  function pickDate(next: string) {
    setDate(next)
    const slots = slotsFor(next, slotCtx.todayStr, slotCtx.minTs, slotParams)
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
            maxParty={maxParty}
            timeSlots={timeSlots}
            instant={instant}
            freeTimes={freeTimes}
            onDate={pickDate}
            onTime={setTime}
            onGuests={setGuests}
            onNext={() => setStep('times')}
          />
        )}
        {step === 'times' && (
          <TimesScreen
            lang={lang}
            locId={locId}
            date={date}
            time={time}
            guests={guests}
            timeSlots={timeSlots}
            instant={instant}
            freeTimes={freeTimes}
            zones={zones}
            todayStr={slotCtx.todayStr}
            onBack={() => setStep('slot')}
            onPick={(nextTime, nextZone) => {
              setTime(nextTime)
              setZoneId(nextZone)
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
            instant={instant}
            zoneId={zoneId}
            zoneName={zoneName}
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
          <h1 className="font-display text-4xl font-bold leading-tight text-gray-900 mt-1">{title ?? ''}</h1>
          {loc?.address && <p className="text-sm text-gray-500 mt-1">{loc.address}</p>}
        </header>
        <div className="flex-1 flex flex-col">{children}</div>
        {/* Подвал (066): часы работы + соцсети — только на экране-лендинге */}
        {hero && loc && <ReserveFooter loc={loc} lang={lang} />}
      </div>
    </div>
  )
}

/**
 * Подвал страницы брони (066): часы работы (свободный текст) и соцкнопки
 * (Instagram/Facebook/Google-отзыв). Пустые поля → блок/кнопка не рендерится;
 * если всё пусто — подвала нет. Тёмная плашка со скруглённым верхом и
 * hairline-чертой отделяет подвал от контента (как на гостевой странице заказа).
 */
function ReserveFooter({ loc, lang }: { loc: NonNullable<ReserveInfo['location']>; lang: Lang }) {
  const links = loc.links
  const hasSocial = !!(links?.instagram || links?.facebook || links?.google_review)
  const hasHours = !!loc.hours
  if (!hasSocial && !hasHours) return null
  const iconBtn =
    'w-12 h-12 rounded-full bg-white/10 text-white flex items-center justify-center active:scale-[0.94] transition-all'
  return (
    <footer className="mt-8 px-4 pt-8 pb-8 flex flex-col items-center gap-5 bg-black/85 border-t border-white/10">
      {hasHours && (
        <div className="text-center">
          <div className="text-xs font-semibold text-white/50 uppercase tracking-wide">{t(lang, 'rsvHoursTitle')}</div>
          <p className="text-sm text-white mt-1 whitespace-pre-line">{loc.hours}</p>
        </div>
      )}
      {(links?.instagram || links?.facebook) && (
        <div className="flex items-center gap-3">
          {links?.instagram && (
            <a href={links.instagram} target="_blank" rel="noopener noreferrer" aria-label="Instagram" className={iconBtn}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" stroke="none" />
              </svg>
            </a>
          )}
          {links?.facebook && (
            <a href={links.facebook} target="_blank" rel="noopener noreferrer" aria-label="Facebook" className={iconBtn}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
                <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
              </svg>
            </a>
          )}
        </div>
      )}
      {links?.google_review && (
        <a
          href={links.google_review}
          target="_blank"
          rel="noopener noreferrer"
          className="h-11 px-5 rounded-full bg-white/10 text-sm font-semibold text-white flex items-center gap-2 active:scale-[0.96] transition-all"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
          </svg>
          {t(lang, 'pubReviewGoogle')}
        </a>
      )}
    </footer>
  )
}

/** «Сегодня» / «пн 13/7» — подпись дня в селекте */
function dayOptionLabel(dateStr: string, todayStr: string, lang: Lang): string {
  if (dateStr === todayStr) return t(lang, 'today')
  const d = new Date(`${dateStr}T12:00:00`)
  const wd = d.toLocaleDateString(lang === 'he' ? 'he-IL' : 'ru-RU', { weekday: 'short' })
  return `${wd} ${d.getDate()}/${d.getMonth() + 1}`
}

/** Ячейка слот-панели: значение — текстом, под ним маленькая стрелка вниз;
 *  невидимый select растянут на всю плитку (тап везде) */
function SlotCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative flex-1 min-w-0 py-3 px-2">
      <div className="text-center font-bold text-gray-900 text-base truncate">{label}</div>
      <div className="flex justify-center text-gray-400 mt-1">
        <Chevron />
      </div>
      {children}
    </div>
  )
}

const SELECT_CLS = 'absolute inset-0 w-full h-full opacity-0 cursor-pointer text-base'

function SlotScreen({ lang, info, days, todayStr, todayHasSlots, date, time, guests, maxParty, timeSlots, instant, freeTimes, onDate, onTime, onGuests, onNext }: {
  lang: Lang
  info: ReserveInfo
  days: string[]
  todayStr: string
  todayHasSlots: boolean
  date: string
  time: string
  guests: number
  maxParty: number
  timeSlots: string[]
  /** instant-режим (063): показываем live-доступность и «Забронировать сейчас» */
  instant: boolean
  /** Свободные времена (Set) или null, если доступность не применяется */
  freeTimes: Set<string> | null
  onDate: (v: string) => void
  onTime: (v: string) => void
  onGuests: (v: number) => void
  onNext: () => void
}) {
  // В instant-режиме день целиком занят, если сетка загружена и пуста на free
  const dayFull = instant && freeTimes !== null && freeTimes.size === 0 && timeSlots.length > 0
  // Выбранное время недоступно — не даём идти дальше
  const timeTaken = instant && freeTimes !== null && !freeTimes.has(time)
  const loc = info.location
  // Навигация (062): координаты → точный пин; иначе текстовый поиск по адресу.
  // query=lat,lng открывает Google Maps на точке (на телефоне — с выбором
  // приложения, включая Waze/Apple Maps через геосхему ОС).
  const mapsUrl =
    loc.lat != null && loc.lng != null
      ? `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`
      : loc.address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.address)}`
        : null
  return (
    <div className="px-4 pb-8 flex flex-col items-center">
      {!todayHasSlots && (
        <div className="w-full mt-3 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3 text-center">
          {t(lang, 'rsvNoSlotsToday')}
        </div>
      )}

      {/* Слот-панель: гости · дата · время (в RTL справа налево — как у Tabit;
          селекты, время дискретно по 15 мин) */}
      <div className="w-full mt-4 rounded-2xl border border-gray-200 shadow-sm flex divide-x divide-gray-100 rtl:divide-x-reverse">
        <SlotCell label={`${guests} ${t(lang, 'resGuestsShort')}`}>
          <select className={SELECT_CLS} value={guests} onChange={(e) => onGuests(Number(e.target.value))} aria-label={t(lang, 'rsvGuests')}>
            {Array.from({ length: maxParty }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n} {t(lang, 'resGuestsShort')}</option>
            ))}
          </select>
        </SlotCell>
        <SlotCell label={dayOptionLabel(date, todayStr, lang)}>
          <select className={SELECT_CLS} value={date} onChange={(e) => onDate(e.target.value)} aria-label={t(lang, 'rsvDate')}>
            {days.map((d) => (
              // Сегодня без слотов — день виден, но выбрать нельзя
              <option key={d} value={d} disabled={d === todayStr && !todayHasSlots}>
                {dayOptionLabel(d, todayStr, lang)}
              </option>
            ))}
          </select>
        </SlotCell>
        <SlotCell label={time}>
          <select className={SELECT_CLS} value={time} onChange={(e) => onTime(e.target.value)} aria-label={t(lang, 'rsvTime')}>
            {timeSlots.map((s) => {
              const full = freeTimes !== null && !freeTimes.has(s)
              return (
                <option key={s} value={s} disabled={full}>
                  {s}{full ? ` · ${t(lang, 'rsvSlotFull')}` : ''}
                </option>
              )
            })}
          </select>
        </SlotCell>
      </div>

      {dayFull && (
        <div className="w-full mt-4 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3 text-center">
          {t(lang, 'rsvNoFreeSlots')}
        </div>
      )}

      <button
        onClick={onNext}
        disabled={timeSlots.length === 0 || dayFull || timeTaken}
        className="w-full h-14 mt-4 rounded-2xl bg-gray-900 text-white font-bold disabled:opacity-40 active:scale-[0.98] transition-all"
      >
        {instant ? t(lang, 'rsvBookNow') : t(lang, 'rsvSubmit')}
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
 * Точное время (Ontopo-стиль): каждая зона зала — отдельная секция со
 * своим рядом ±2 слота вокруг запрошенного времени. В instant-режиме у
 * секции своя live-доступность: свободный слот — «мгновенное подтверждение»
 * (зелёная точка), занятый — ⊘ и дизейбл. Тап по слоту несёт и время, и
 * зону в контакты. Без зон (или одна) — единственная секция «вся точка»
 * (zoneId=null).
 */
function TimesScreen({ lang, locId, date, time, guests, timeSlots, instant, freeTimes, zones, todayStr, onBack, onPick }: {
  lang: Lang
  locId: string
  date: string
  time: string
  guests: number
  timeSlots: string[]
  /** instant-режим (063): каждая секция считает доступность по своей зоне */
  instant: boolean
  /** Свободные времена по всей точке (instant-режим) или null */
  freeTimes: Set<string> | null
  /** Зоны зала (072); от двух зон — секция на зону, иначе одна общая */
  zones: { id: string; name: string }[]
  todayStr: string
  onBack: () => void
  /** (время, zoneId) — zoneId=null для общей секции «без зоны» */
  onPick: (time: string, zoneId: string | null) => void
}) {
  // Ряд из 5 слотов вокруг запрошенного времени (окно у краёв дня сдвигается)
  const chips = useMemo(() => {
    const i = Math.max(0, timeSlots.indexOf(time))
    const start = Math.max(0, Math.min(i - 2, timeSlots.length - 5))
    return timeSlots.slice(start, start + 5)
  }, [timeSlots, time])

  // От двух зон — секция на каждую (zoneId = z.id). Меньше — одна общая
  // секция по всей точке (zoneId = null), доступность из freeTimes.
  const sections = useMemo(
    () => (zones.length >= 2
      ? zones.map((z) => ({ id: z.id, name: z.name }))
      : [{ id: null as string | null, name: null }]),
    [zones]
  )

  // Каждой зоне-секции — свой запрос доступности (только instant). Хук
  // useQueries держит стабильный порядок; общая секция берёт freeTimes.
  const zoneQueries = useQueries({
    queries: sections.map((s) => ({
      queryKey: ['reserve_avail', locId, date, guests, s.id],
      queryFn: () => fetchAvailability(locId, date, guests, s.id),
      enabled: instant && s.id !== null,
      staleTime: 20_000,
    })),
  })

  return (
    <div className="px-4 pb-8">
      <button
        onClick={onBack}
        className="mt-1 h-11 px-3 -ms-3 text-sm font-semibold text-gray-500 flex items-center gap-1 active:scale-[0.96] transition-all"
      >
        <span className="rtl:rotate-180"><BackIcon /></span>
        {t(lang, 'rsvBackToSlot')}
      </button>

      <h2 className="text-lg font-bold text-gray-900 mt-2">
        {instant ? t(lang, 'rsvFoundTitle') : t(lang, 'rsvPickTimeTitle')}
      </h2>
      <p className="text-sm text-gray-500 mt-1">
        {dayOptionLabel(date, todayStr, lang)} · {time} · {guests} {t(lang, 'resGuestsShort')}
      </p>

      <div className="mt-5 space-y-6">
        {sections.map((s, i) => {
          // Свободные времена секции: своя зона → её запрос; общая → freeTimes
          const q = zoneQueries[i]
          const secFree = s.id === null
            ? freeTimes
            : (instant && q?.data
                ? new Set(q.data.slots.filter((sl) => sl.free).map((sl) => sl.time))
                : freeTimes)
          return (
            <ZoneTimeRow
              key={s.id ?? '__any__'}
              lang={lang}
              zoneName={s.name}
              chips={chips}
              time={time}
              instant={instant}
              freeTimes={secFree}
              onPick={(v) => onPick(v, s.id)}
            />
          )
        })}
      </div>
    </div>
  )
}

/**
 * Секция одной зоны на экране времени: заголовок зоны (если есть) и ряд
 * слотов. Свободный instant-слот подписан «мгновенное подтверждение»,
 * дальний/не-instant — «по телефону», занятый — ⊘ и недоступен.
 */
function ZoneTimeRow({ lang, zoneName, chips, time, instant, freeTimes, onPick }: {
  lang: Lang
  zoneName: string | null
  chips: string[]
  time: string
  instant: boolean
  freeTimes: Set<string> | null
  onPick: (v: string) => void
}) {
  return (
    <section>
      {zoneName && (
        <div className="flex items-center gap-2 mb-3">
          <span className="w-5 h-5 flex items-center justify-center text-gray-500 shrink-0"><ChairIcon /></span>
          <h3 className="text-base font-bold text-gray-900">{zoneName}</h3>
        </div>
      )}
      <div className="grid grid-cols-5 gap-2">
        {chips.map((s) => {
          const current = s === time
          // instant: занят, если явно не в множестве свободных
          const full = instant && freeTimes !== null && !freeTimes.has(s)
          // Мгновенное подтверждение — только instant + слот свободен
          const now = instant && (freeTimes === null || freeTimes.has(s))
          return (
            <button
              key={s}
              onClick={() => !full && onPick(s)}
              disabled={full}
              className={`h-16 rounded-xl flex flex-col items-center justify-center gap-0.5 active:scale-[0.96] transition-all ${
                full
                  ? 'bg-gray-50 border border-gray-100 cursor-not-allowed active:scale-100'
                  : current
                    ? 'bg-white border-2 border-gray-900'
                    : 'bg-white border border-gray-200 hover:border-gray-400'
              }`}
            >
              <span className={`text-base font-bold tabular-nums ${full ? 'text-gray-300' : 'text-gray-900'}`}>{s}</span>
              {full ? (
                <span className="text-gray-300" aria-label={t(lang, 'rsvSlotFull')}><BlockedIcon /></span>
              ) : now ? (
                <span className="flex items-center gap-1 text-[11px] text-gray-500 leading-none">
                  <span className="w-1.5 h-1.5 rounded-full bg-lime-500 shrink-0" aria-hidden />
                  {t(lang, 'rsvInstantLabel')}
                </span>
              ) : (
                <span className="text-[11px] text-gray-500 leading-none">{t(lang, 'rsvPhoneLabel')}</span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function reserveErrorText(lang: Lang, code: string): string {
  switch (code) {
    case 'disabled': return t(lang, 'rsvErrDisabled')
    case 'rate_limited': return t(lang, 'rsvErrRate')
    case 'busy': return t(lang, 'rsvErrBusy')
    case 'invalid_time': return t(lang, 'rsvErrTime')
    case 'outside_hours': return t(lang, 'rsvErrHours')
    case 'invalid_phone': return t(lang, 'rsvErrPhone')
    case 'full_slot': return t(lang, 'rsvErrFull')
    case 'invalid_zone': return t(lang, 'rsvErrZone')
    default: return t(lang, 'rsvErrUnknown')
  }
}

function DetailsScreen({ lang, locId, date, time, guests, instant, zoneId, zoneName, todayStr, onBack, onSubmitted }: {
  lang: Lang
  locId: string
  date: string
  time: string
  guests: number
  /** instant-режим (063): CTA — «Подтвердить бронь», не «Отправить заявку» */
  instant: boolean
  /** Пожелание зоны (072); null = без предпочтений */
  zoneId: string | null
  zoneName: string | null
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
        zone_id: zoneId,
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

      {zoneName && (
        <p className="text-sm text-gray-500 mt-2 text-center">
          {t(lang, 'rsvZoneSummary')}: <span className="font-semibold text-gray-900">{zoneName}</span>
        </p>
      )}

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
        {busy ? t(lang, 'pubSubmitting') : instant ? t(lang, 'rsvSendInstant') : t(lang, 'rsvSend')}
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
        {status.zone_name && <> · {status.zone_name}</>}
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

/** Стул — ярлык зоны в списке времён (нейтральный, для любой зоны) */
function ChairIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 11V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6M5 11h14M6 11v8m12-8v8M8 15h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Перечёркнутый круг — слот занят (нет свободного стола в instant-режиме) */
function BlockedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.5 6.5l11 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
