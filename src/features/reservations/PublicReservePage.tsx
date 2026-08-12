import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { t, formatTime, type Lang } from '../../lib/i18n'
import { PublicApiError } from '../online/publicApi'
import { navigateWithTransition } from '../online/viewTransition'
import {
  fetchReserveInfo, submitPublicReservation, fetchReservationView,
  cancelPublicReservation, fetchAvailability, reschedulePublicReservation,
  joinWaitlist, confirmAttendance,
  type ReserveInfo, type ReservationView, type ReserveRule,
} from './publicReserveApi'
import { trackReserveStep, resetFunnelSession } from './funnel'
import BrandSplash from '../../components/ui/BrandSplash'
import {
  hasBookableSlot, normalizeSchedule, partsInZone, shiftDate, slotGrid,
  weeklyHoursRows,
} from './schedule'
import { downloadIcs } from './calendar'
import { updateInstalledMenuName } from '../online/menuManifest'

/**
 * Публичная страница брони стола (053), флоу как у Tabit:
 * шаг 1 — фото-шапка, название+адрес, слот (дата/время/гости — селекты,
 * время только дискретное с шагом 15 мин) → шаг 2 — контакты → заявка →
 * ожидание подтверждения кассой (поллинг) → подтверждена/отклонена.
 * Гость может отменить бронь. Мобильная, he по умолчанию.
 * Никакого Supabase-клиента: только Edge Function с anon-ключом.
 */

const ACTIVE_KEY = 'kassa-public-reserve' // {clientUuid, locId} — текущая бронь

const DEF_STEP_MIN = 15
/** Сколько дней показывать в селекте дат, даже если горизонт записи больше */
const MAX_DAYS_SHOWN = 60
/** Зона по умолчанию: страница брони he-first, продукт израильский */
const DEF_TZ = 'Asia/Jerusalem'

/**
 * Шаг «правила» (145) появляется, ТОЛЬКО если точка их завела: кофейне
 * без условий визита лишний экран между временем и контактами не нужен,
 * а индикатор прогресса честно считает три или четыре шага.
 */
type ReserveStep = 'slot' | 'times' | 'rules' | 'details'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Ключ текущей брони. Приоритет у `?b=` из адреса (118): постоянная ссылка
 * должна открывать бронь на ЛЮБОМ устройстве, в том числе там, где
 * localStorage пуст. Хранилище остаётся вторым источником — для гостя,
 * который просто вернулся на страницу заведения.
 */
function readBookingKey(locId: string): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('b')
    if (fromUrl && UUID_RE.test(fromUrl)) return fromUrl
  } catch { /* нет window.location — не беда, идём в хранилище */ }
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { clientUuid: string; locId: string }
    return parsed.locId === locId ? parsed.clientUuid : null
  } catch {
    return null
  }
}

/** Адрес страницы = постоянная ссылка на бронь; история не засоряется */
function writeBookingUrl(token: string | null): void {
  try {
    const url = new URL(window.location.href)
    if (token) url.searchParams.set('b', token)
    else url.searchParams.delete('b')
    window.history.replaceState(null, '', url.toString())
  } catch { /* окружение без History API — ссылка просто не обновится */ }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Локальная дата момента в часовом поясе ТОЧКИ, а не устройства */
function localDateOf(ms: number, tz: string): string {
  const p = partsInZone(new Date(ms), tz)
  if (!p) {
    const d = new Date(ms)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Сегодняшняя дата в часовом поясе точки */
function todayInZone(nowMs: number, tz: string): string {
  return localDateOf(nowMs, tz)
}

/** Локальное время момента, 'HH:MM' в зоне точки */
function localTimeOf(ms: number, tz: string): string {
  const p = partsInZone(new Date(ms), tz)
  if (!p) {
    const d = new Date(ms)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return `${pad(p.hour)}:${pad(p.minute)}`
}

export default function PublicReservePage() {
  const { locId = '' } = useParams()
  // Гостевая страница — всегда иврит (бронь he-first), без переключения языка.
  const lang: Lang = 'he'
  useEffect(() => {
    // <html lang> решает RTL в проде: start/end скомпилированы через :lang(he).
    // dir выставляем тоже: langStore пишет туда язык КАССЫ (по умолчанию ru →
    // ltr), и на ивритской гостевой странице оставался бы `dir="ltr"` —
    // документ считался бы левосторонним, хотя весь контент правосторонний.
    document.documentElement.lang = lang
    document.documentElement.dir = 'rtl'
  }, [])
  const isRtl = true

  const qc = useQueryClient()

  // Незавершённая бронь переживает перезагрузку страницы
  const [activeUuid, setActiveUuid] = useState<string | null>(() => readBookingKey(locId))

  // Предпросмотр владельца (126). Секрет читается из адреса один раз:
  // страница переписывает URL, получив бронь, и параметр бы потерялся.
  const [previewToken] = useState(
    () => new URLSearchParams(window.location.search).get('preview'),
  )

  const { data: info, isLoading, isError } = useQuery({
    queryKey: ['public_reserve_info', locId, previewToken],
    queryFn: () => fetchReserveInfo(locId, previewToken),
    staleTime: 30_000,
  })
  const preview = info?.location.preview === true

  // Заголовок вкладки и имя устанавливаемого приложения (118). До этого в
  // обоих местах стояло родовое «Angle — Digital Menu»: гость сохранял на
  // домашний экран страницу брони, а получал ярлык меню.
  const pageTitle = info?.location.business_name || info?.location.name
  useEffect(() => {
    if (!pageTitle) return
    const previousTitle = document.title
    document.title = `${t('he', 'rsvPageLabel')} · ${pageTitle}`
    updateInstalledMenuName(pageTitle)
    return () => { document.title = previousTitle }
  }, [pageTitle])

  // «Сейчас» фиксируется на маунте: страница короткоживущая, а серверная
  // валидация окна своя — submit перепроверяет расписание в любом случае.
  const [nowMs] = useState(() => Date.now())

  // Часовой пояс ТОЧКИ (117). До этого сетка считалась в зоне устройства,
  // и гость с телефоном в другой зоне видел одно время, а бронировал другое.
  const tz = info?.location.timezone || DEF_TZ
  // Расписание (117): недельные окна, исключения, lead time и горизонт.
  // Точка без schedule разворачивается в legacy open/close — ровно как на
  // сервере, поэтому показанное и принимаемое не расходятся.
  const schedule = useMemo(() => normalizeSchedule(info?.location), [info])
  const stepMin = info?.location.slot_min && info.location.slot_min > 0
    ? info.location.slot_min : DEF_STEP_MIN

  const todayStr = useMemo(() => todayInZone(nowMs, tz), [nowMs, tz])
  const days = useMemo(() => {
    const count = Math.min(schedule.horizonDays, MAX_DAYS_SHOWN)
    return Array.from({ length: count }, (_, i) => shiftDate(todayStr, i))
  }, [todayStr, schedule])

  // Выбранный слот (шаг 1) и шаг флоу: слот → точное время → контакты
  const [step, setStep] = useState<ReserveStep>('slot')
  // Зона зала (072): пожелание гостя, null = без предпочтений. На шаге
  // точного времени зоны показываются секциями (Ontopo-стиль): у каждой
  // свой ряд времён; выбор времени в секции = бронь этой зоны. Задаётся
  // при тапе по слоту вместе со временем.
  const [zoneId, setZoneId] = useState<string | null>(null)
  // Дата и время выбираются до загрузки расписания, поэтому стартовые
  // значения — заведомо валидная заглушка; ниже идёт сверка при рендере.
  const [date, setDate] = useState(todayStr)
  const [time, setTime] = useState('')
  const [guests, setGuests] = useState(2)
  // Контакты живут выше экранов: возврат к времени и повторный вход в
  // детали не стирают уже набранное имя/телефон.
  const [detailsDraft, setDetailsDraft] = useState({ name: '', phone: '', note: '' })
  // Отмеченные правила (145) живут здесь же, а не в экране: гость,
  // вернувшийся поправить время, не должен расставлять галочки заново.
  const [rulesAck, setRulesAck] = useState<string[]>([])
  // Сервер отклонил согласие: правила успели измениться, пока гость
  // заполнял форму. Возвращаем его на шаг правил с объяснением.
  const [rulesStale, setRulesStale] = useState(false)
  // Слот заняли, пока гость заполнял контакты: экран времени показывает
  // объяснение и перезапрошенную доступность.
  const [conflict, setConflict] = useState(false)
  // Лист ожидания (122): открыт лист-форма
  const [waitlistOpen, setWaitlistOpen] = useState(false)
  const [clientUuid, setClientUuid] = useState(() => crypto.randomUUID())

  // Лимит гостей (061): настройка владельца, дефолт 20, потолок 50
  const maxParty = useMemo(() => {
    const m = info?.location.max_party
    return m && m >= 1 && m <= 50 ? m : 20
  }, [info])

  const daySlots = useMemo(
    () => slotGrid({ schedule, dateStr: date, tz, stepMin, nowMs }),
    [schedule, date, tz, stepMin, nowMs]
  )
  const timeSlots = useMemo(() => daySlots.map((s) => s.time), [daySlots])
  // «Есть ли слоты у дня» спрашивается про каждый день селекта, поэтому
  // считается облегчённой проверкой с выходом по первому слоту.
  const dayOpen = useMemo(
    () => (d: string) => hasBookableSlot({ schedule, dateStr: d, tz, stepMin, nowMs }),
    [schedule, tz, stepMin, nowMs]
  )
  const todayHasSlots = useMemo(() => dayOpen(todayStr), [dayOpen, todayStr])
  // Абсолютный момент выбранного слота: именно он уходит на сервер. Собирать
  // время как «дата + метка» нельзя — у ночной смены метка принадлежит
  // следующим суткам, а весной локального 02:00 может не существовать.
  const selectedAt = useMemo(
    () => daySlots.find((s) => s.time === time)?.at ?? null,
    [daySlots, time]
  )

  // Live-доступность (063): только в instant-режиме. Множество СВОБОДНЫХ
  // времён на выбранную дату+число гостей; занятые в UI дизейблятся.
  // Live-доступность требует включённого приёма: в предпросмотре
  // невыложенной точки RPC отдаст 'disabled', поэтому показываем сетку
  // расписания. Владелец здесь проверяет часы, зоны и вид, а не занятость.
  const instant = info?.location.instant === true
    && (info?.location.published !== false)
  const {
    data: avail,
    isPending: availabilityPending,
    isError: availabilityError,
  } = useQuery({
    queryKey: ['reserve_avail', locId, date, guests],
    queryFn: () => fetchAvailability(locId, date, guests),
    enabled: instant && !!info?.location.accepting,
    staleTime: 20_000,
  })
  const freeTimes = useMemo(() => {
    if (!instant || !avail) return null // null = доступность не применяется (все свободны)
    return new Set(avail.slots.filter((s) => s.free).map((s) => s.time))
  }, [instant, avail])

  // Правила брони (145): нормализованы сервером — клиент только показывает
  const rules = useMemo(() => info?.location.rules ?? [], [info])
  const hasRules = rules.length > 0

  // Зоны зала (072): выбор осмыслен от двух зон (одну — 066 создаёт всем)
  const zones = useMemo(() => info?.location.zones ?? [], [info])
  const zoneName = zoneId ? zones.find((z) => z.id === zoneId)?.name ?? null : null

  // ── Воронка (124) ──────────────────────────────────────────
  // Вершина: страница открыта и приём включён. Закрытую страницу не
  // считаем — это не отказ гостя, а решение заведения. Предпросмотр
  // владельца не считаем тем более: он испортил бы конверсию точки,
  // которая ещё не приняла ни одного настоящего гостя.
  const accepting = info?.location.accepting === true
  const counted = accepting && !preview
  // Вторая заявка начинает вторую воронку с новой сессией (см. startNew).
  // Эпоха входит в зависимости шагов, иначе новая сессия попадала бы в
  // отчёт без вершины: «выбрал время» насчитывалось бы больше, чем
  // «открыл страницу», и доля выходила бы больше ста процентов.
  const [funnelEpoch, setFunnelEpoch] = useState(0)
  useEffect(() => {
    if (counted) trackReserveStep(locId, 'page_view')
  }, [counted, locId, funnelEpoch])

  // Спрос по дате и компании — и главное, НЕудовлетворённый спрос.
  // Считается и в instant-режиме (сервер знает занятость), и без него
  // (пустой день по расписанию), потому что для владельца это одно и то
  // же: гость спросил время, и его не оказалось.
  const freeCount = instant
    ? (avail ? avail.slots.filter((s) => s.free).length : null)
    : timeSlots.length
  useEffect(() => {
    if (!counted || freeCount === null) return
    trackReserveStep(locId, 'availability', { party_size: guests, wanted_date: date })
    if (freeCount === 0) {
      trackReserveStep(locId, 'no_slots', { party_size: guests, wanted_date: date })
    }
  }, [counted, freeCount, locId, guests, date, funnelEpoch])

  // Сверки во время рендера (реком. React вместо эффекта):
  // 1) Выбранный день закрыт или уже прошёл — переходим на ближайший день,
  //    у которого слоты есть. С недельным расписанием (117) закрытым может
  //    быть не только сегодня: у заведения с выходным в субботу первый
  //    доступный день — воскресенье.
  const firstOpenDay = useMemo(
    () => days.find(dayOpen) ?? null,
    [days, dayOpen]
  )
  if (timeSlots.length === 0 && firstOpenDay && date !== firstOpenDay) {
    setDate(firstOpenDay)
  } else if (timeSlots.length > 0 && !timeSlots.includes(time)) {
    // 2) Выбранное время выпало из окна (расписание подгрузилось/сменился
    //    день) — берём ближайшее к обеду.
    setTime(timeSlots.find((s) => s >= '12:00') ?? timeSlots[0])
  }
  // 3) Гостей больше нового лимита — подрезаем.
  if (guests > maxParty) {
    setGuests(maxParty)
  }

  function pickDate(next: string) {
    setDate(next)
    const slots = slotGrid({ schedule, dateStr: next, tz, stepMin, nowMs })
      .map((s) => s.time)
    if (!slots.includes(time)) setTime(slots.find((s) => s >= '12:00') ?? slots[0] ?? '')
  }

  /**
   * Забронировать снова.
   *
   * `seed` — то, что переносить БЕЗОПАСНО: имя гостя и размер компании.
   * Заставлять человека, который только что поужинал у нас, набирать
   * своё имя заново — единственный способ превратить повторный визит в
   * работу.
   *
   * Телефон не переносится, потому что его не отдаёт и сервер
   * (`reservation_public_view`, 118): попавшая не в те руки ссылка не
   * должна выдавать номер. Время и согласие с правилами сбрасываются
   * всегда — вторая бронь это второй визит, а не копия первого.
   */
  function startNew(seed?: { name?: string; guests?: number }) {
    navigateWithTransition('back', () => {
      localStorage.removeItem(ACTIVE_KEY)
      writeBookingUrl(null)
      setActiveUuid(null)
      setStep('slot')
      setZoneId(null)
      if (seed?.guests && seed.guests >= 1 && seed.guests <= maxParty) {
        setGuests(seed.guests)
      }
      setDetailsDraft({ name: seed?.name ?? '', phone: '', note: '' })
      // Вторая бронь — второе согласие: правила подтверждают на визит,
      // а не один раз навсегда.
      setRulesAck([])
      setRulesStale(false)
      setClientUuid(crypto.randomUUID())
      // Вторая бронь — вторая воронка: иначе она склеилась бы с первой и
      // выглядела бы как один гость, дошедший до конца дважды. Эпоха
      // заставляет новую сессию заново отправить вершину и доступность —
      // без этого её шаги попадали в отчёт без начала.
      resetFunnelSession()
      setFunnelEpoch((epoch) => epoch + 1)
    })
  }

  if (activeUuid) {
    return (
      <>
        <BrandSplash />
        <Shell
          isRtl={isRtl}
          info={info}
          lang={lang}
          routeKey="status"
        >
          <BookingScreen
            lang={lang}
            bookingKey={activeUuid}
            tz={info?.location.timezone || DEF_TZ}
            onNew={startNew}
          />
        </Shell>
      </>
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
      <Shell
        isRtl={isRtl}
        info={info}
        lang={lang}
        hero={step === 'slot'}
        routeKey={step}
        onBack={
          step === 'times'
            ? () => navigateWithTransition('back', () => setStep('slot'))
            : step === 'rules'
              ? () => navigateWithTransition('back', () => setStep('times'))
              : step === 'details'
                ? () => navigateWithTransition('back', () => setStep(hasRules ? 'rules' : 'times'))
                : undefined
        }
      >
        {step === 'slot' && (
          <SlotScreen
            lang={lang}
            info={info}
            days={days}
            todayStr={todayStr}
            todayHasSlots={todayHasSlots}
            dayOpen={dayOpen}
            date={date}
            time={time}
            guests={guests}
            maxParty={maxParty}
            timeSlots={timeSlots}
            instant={instant}
            freeTimes={freeTimes}
            availabilityLoading={instant && availabilityPending && !avail}
            availabilityError={instant && availabilityError}
            onDate={pickDate}
            onTime={setTime}
            onGuests={setGuests}
            onNext={() => navigateWithTransition('forward', () => setStep('times'))}
            onWaitlist={() => setWaitlistOpen(true)}
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
            todayStr={todayStr}
            conflict={conflict}
            stepTotal={hasRules ? 4 : 3}
            onPick={(nextTime, nextZone) => {
              trackReserveStep(locId, 'slot_selected', {
                party_size: guests,
                wanted_date: date,
                wanted_time: nextTime,
                zone_id: nextZone,
              })
              navigateWithTransition('forward', () => {
                setConflict(false)
                setTime(nextTime)
                setZoneId(nextZone)
                setStep(hasRules ? 'rules' : 'details')
              })
            }}
          />
        )}
        {step === 'rules' && (
          <RulesScreen
            lang={lang}
            rules={rules}
            date={date}
            time={time}
            guests={guests}
            todayStr={todayStr}
            zoneName={zoneName}
            checked={rulesAck}
            stale={rulesStale}
            onChecked={setRulesAck}
            onNext={() => navigateWithTransition('forward', () => {
              setRulesStale(false)
              setStep('details')
            })}
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
            todayStr={todayStr}
            preview={preview}
            reservedAt={selectedAt}
            draft={detailsDraft}
            onDraft={setDetailsDraft}
            clientUuid={clientUuid}
            rulesAck={rulesAck}
            stepOf={hasRules ? 4 : 3}
            onRulesStale={() => {
              // Правила точки изменились между загрузкой страницы и
              // отправкой. Показываем СВЕЖИЕ — согласие с исчезнувшим
              // текстом ничего не значит.
              qc.invalidateQueries({ queryKey: ['public_reserve_info', locId] })
              setRulesAck([])
              navigateWithTransition('back', () => {
                setRulesStale(true)
                setStep('rules')
              })
            }}
            onConflict={() => {
              // Доступность могла устареть — перезапрашиваем и возвращаем
              // гостя на шаг выбора времени.
              qc.invalidateQueries({ queryKey: ['reserve_avail', locId] })
              navigateWithTransition('back', () => {
                setConflict(true)
                setStep('times')
              })
            }}
            onSubmitted={(key) => {
              navigateWithTransition('forward', () => {
                // Ключом становится серверный public_token (118): именно он
                // уходит в адрес и переживает смену устройства.
                localStorage.setItem(ACTIVE_KEY, JSON.stringify({ clientUuid: key, locId }))
                writeBookingUrl(key)
                setActiveUuid(key)
              })
            }}
          />
        )}
      </Shell>

      {preview && <PreviewBar lang={lang} published={info.location.published !== false} />}

      {waitlistOpen && info && (
        <WaitlistSheet
          lang={lang}
          locId={locId}
          date={date}
          guests={guests}
          zones={zones}
          draft={detailsDraft}
          onDraft={setDetailsDraft}
          onClose={() => setWaitlistOpen(false)}
        />
      )}
    </>
  )
}

/**
 * Каждый шаг бронирования — самостоятельный экран целиком, включая шапку.
 * На переходе предыдущий React-поддерево остаётся смонтированным и уезжает
 * одновременно с новым: фото, заголовки и форма не прыгают между layout.
 */
function Shell({ isRtl, info, lang, hero, routeKey, onBack, children }: {
  isRtl: boolean
  info?: ReserveInfo
  lang: Lang
  hero?: boolean
  routeKey?: string
  onBack?: () => void
  children: React.ReactNode
}) {
  const loc = info?.location
  const title = loc?.business_name || loc?.name
  const currentRouteKey = routeKey ?? '__static__'
  const currentRoute = (
    <div className="public-reserve-route-motion">
      {hero ? (
        <header className={`public-reserve-hero${loc?.header_url ? ' has-media' : ''}`}>
          {loc?.header_url && (
            <img src={loc.header_url} alt="" className="public-reserve-hero-media" />
          )}
          <span className="public-reserve-hero-scrim" aria-hidden />
          <div className="public-reserve-hero-copy">
            {!loc?.header_url && loc?.logo_url && (
              <img src={loc.logo_url} alt="" className="public-reserve-hero-logo" />
            )}
            <div>{t(lang, 'rsvPageLabel')}</div>
            <h1 className="font-display public-reserve-route-focus" tabIndex={-1}>{title ?? ''}</h1>
            {loc?.address && <p>{loc.address}</p>}
          </div>
        </header>
      ) : (
        <header className="public-reserve-compact-header">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t(lang, 'rsvBackToSlot')}
              className="public-reserve-back-button"
            >
              <span className="rtl:rotate-180"><BackIcon /></span>
            </button>
          )}
          <div className="public-reserve-compact-brand">
            {loc?.logo_url && <img src={loc.logo_url} alt="" />}
            <span>
              <small>{t(lang, 'rsvPageLabel')}</small>
              <strong>{title ?? ''}</strong>
            </span>
          </div>
        </header>
      )}
      <main className="flex-1 flex flex-col">{children}</main>
      {hero && loc && <ReserveFooter loc={loc} lang={lang} />}
    </div>
  )
  const focusRoute = useRef(currentRouteKey)

  useEffect(() => {
    if (focusRoute.current === currentRouteKey) return
    const timer = window.setTimeout(() => {
      document
        .querySelector<HTMLElement>('.public-reserve-route-focus')
        ?.focus({ preventScroll: true })
      focusRoute.current = currentRouteKey
    }, 0)
    return () => window.clearTimeout(timer)
  }, [currentRouteKey])

  // Один живой слой: анимацию перехода рисует браузер по снапшотам.
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="public-reserve-shell">
      <div className="public-reserve-screen">{currentRoute}</div>
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
  // Часы работы переехали в зону «часы · навигация» на первом экране (SlotScreen);
  // подвал теперь — только соцсети.
  if (!hasSocial) return null
  const iconBtn =
    'w-12 h-12 rounded-full bg-white/10 text-white flex items-center justify-center active:scale-[0.94] transition-all'
  return (
    <footer className="mt-8 px-4 pt-8 pb-8 flex flex-col items-center gap-5 bg-black/85 border-t border-white/10">
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

/**
 * Полоса предпросмотра (126). Внизу и фиксированно: владелец должен
 * видеть её на любом шаге, а не только на первом экране — иначе,
 * пролистав до формы, он решит, что смотрит боевую страницу.
 *
 * Тёмная и без кнопок: это не элемент интерфейса гостя, а метка режима.
 */
function PreviewBar({ lang, published }: { lang: Lang; published: boolean }) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 bg-gray-900 text-white px-4 py-3 text-center"
      role="status"
    >
      <p className="text-sm font-semibold">{t(lang, 'rsvPreviewBanner')}</p>
      {!published && (
        <p className="text-xs text-gray-300 mt-1">{t(lang, 'rsvPreviewUnpublished')}</p>
      )}
    </div>
  )
}

/**
 * Полоса шагов. `total` — 3 или 4 (145): шаг правил есть не у каждой
 * точки, и рисовать пустое деление «на всякий случай» нельзя — гость
 * считает по нему, сколько экранов ему осталось.
 */
function ReserveProgress({ lang, step, total = 3 }: {
  lang: Lang
  step: number
  total?: number
}) {
  return (
    <div
      className="public-reserve-progress"
      role="progressbar"
      aria-label={`${t(lang, 'rsvStep')} ${step} / ${total}`}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={step}
    >
      {Array.from({ length: total }, (_, i) => i + 1).map((value) => (
        <span key={value} data-active={value <= step || undefined} />
      ))}
    </div>
  )
}

function ReserveSelectionSummary({
  lang, date, time, guests, todayStr, zoneName,
}: {
  lang: Lang
  date: string
  time: string
  guests: number
  todayStr: string
  zoneName?: string | null
}) {
  return (
    <>
      <div className="public-reserve-selection-summary">
        <div>
          <span><CalendarIcon /></span>
          <strong>{dayOptionLabel(date, todayStr, lang)}</strong>
        </div>
        <div>
          <span><ClockIcon /></span>
          <strong className="tabular-nums">{time}</strong>
        </div>
        <div>
          <span><PersonIcon /></span>
          {/* Слово «гостей» здесь дублирует фигурку над ним: в сводке из
              трёх плиток важно число, а не подпись к иконке */}
          <strong className="tabular-nums">{guests}</strong>
        </div>
      </div>
      {zoneName && (
        <p className="public-reserve-zone-summary">
          {t(lang, 'rsvZoneSummary')}: <strong>{zoneName}</strong>
        </p>
      )}
    </>
  )
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

/**
 * Часы работы (066) выводятся двумя выровненными колонками: день слева,
 * интервал справа — чтобы дни были под днями, а время под временем. Формат
 * ввода — «<день> · <время>» построчно (как в плейсхолдере настроек). Первый
 * « · » делит строку; строка без разделителя показывается днём на всю ширину.
 */
function HoursRows({ text }: { text: string }) {
  const rows = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('·')
      return i === -1
        ? { day: line, time: null as string | null }
        : { day: line.slice(0, i).trim(), time: line.slice(i + 1).trim() || null }
    })
  return (
    <div className="mt-1.5 space-y-1 text-sm text-gray-900">
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline justify-between gap-2">
          {/* Время не переносится и не сжимается: диапазон «8:00–22:00» рвался
              по дефису («08:00 –» / «20:00»). День при нехватке места
              переносится целыми словами — обрезать его нельзя, «Вс–Чт»
              и «Вс» значат разное. */}
          <span className="font-semibold min-w-0">{r.day}</span>
          {r.time && (
            <span className="text-gray-600 tabular-nums whitespace-nowrap shrink-0" dir="ltr">{r.time}</span>
          )}
        </div>
      ))}
    </div>
  )
}

/** «вс–чт» из группы дней; имена берём у Intl, отдельных ключей не заводим */
function dayRangeLabel(days: number[], lang: Lang): string {
  const locale = lang === 'he' ? 'he-IL' : 'ru-RU'
  // 2024-01-07 — воскресенье; сдвигом получаем любой день недели
  const name = (dow: number) => new Date(Date.UTC(2024, 0, 7 + dow))
    .toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' })
  if (days.length === 1) return name(days[0])
  return `${name(days[0])}–${name(days[days.length - 1])}`
}

/**
 * Часы работы из недельного расписания (117). Раньше здесь был свободный
 * текст, который владелец вёл вручную ОТДЕЛЬНО от часов приёма броней —
 * из-за этого страница писала «шабат закрыто» и тут же предлагала
 * субботние слоты. Теперь показ и сетка читают одну структуру.
 */
function ScheduleHours({ schedule, lang }: {
  schedule: ReturnType<typeof normalizeSchedule>
  lang: Lang
}) {
  const rows = weeklyHoursRows(schedule)
  return (
    <div className="mt-1.5 space-y-1 text-sm text-gray-900">
      {rows.map((r) => (
        <div key={r.days[0]} className="flex items-baseline justify-between gap-2">
          <span className="font-semibold min-w-0">{dayRangeLabel(r.days, lang)}</span>
          {r.windows.length > 0 ? (
            <span className="text-gray-600 tabular-nums whitespace-nowrap shrink-0" dir="ltr">
              {r.windows.map((w) => `${w[0]}\u2013${w[1]}`).join(', ')}
            </span>
          ) : (
            <span className="text-gray-500 whitespace-nowrap shrink-0">{t(lang, 'rsvDayClosed')}</span>
          )}
        </div>
      ))}
    </div>
  )
}

function SlotScreen({
  lang, info, days, todayStr, todayHasSlots, dayOpen, date, time, guests, maxParty,
  timeSlots, instant, freeTimes, availabilityLoading, availabilityError,
  onDate, onTime, onGuests, onNext, onWaitlist,
}: {
  lang: Lang
  info: ReserveInfo
  days: string[]
  todayStr: string
  todayHasSlots: boolean
  /** Открыт ли день по расписанию (117) — закрытые дни в селекте недоступны */
  dayOpen: (dateStr: string) => boolean
  date: string
  time: string
  guests: number
  maxParty: number
  timeSlots: string[]
  /** instant-режим (063): показываем live-доступность и «Забронировать сейчас» */
  instant: boolean
  /** Свободные времена (Set) или null, если доступность не применяется */
  freeTimes: Set<string> | null
  availabilityLoading: boolean
  availabilityError: boolean
  onDate: (v: string) => void
  onTime: (v: string) => void
  onGuests: (v: number) => void
  onNext: () => void
  /** День занят целиком — гость может встать в лист ожидания (122) */
  onWaitlist: () => void
}) {
  // В instant-режиме день целиком занят, если сетка загружена и пуста на free
  const dayFull = instant && freeTimes !== null && freeTimes.size === 0 && timeSlots.length > 0
  // Выбранное время недоступно — не даём идти дальше
  const timeTaken = instant && freeTimes !== null && !freeTimes.has(time)
  const loc = info.location
  // Навигация (062/067): координаты → точный пин; иначе текстовый поиск по адресу.
  // По тапу гость выбирает приложение — Google Maps или Waze (bottom-sheet).
  const hasCoords = loc.lat != null && loc.lng != null
  const googleMapsUrl = hasCoords
    ? `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`
    : loc.address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.address)}`
      : null
  const wazeUrl = hasCoords
    ? `https://waze.com/ul?ll=${loc.lat},${loc.lng}&navigate=yes`
    : loc.address
      ? `https://waze.com/ul?q=${encodeURIComponent(loc.address)}&navigate=yes`
      : null
  const mapsUrl = googleMapsUrl // есть ли вообще куда навигировать
  const [navOpen, setNavOpen] = useState(false)
  // Расписание для показа часов — тот же разбор, что и для сетки слотов
  const schedule = useMemo(() => normalizeSchedule(loc), [loc])
  const hasHours = !!loc.schedule || !!loc.hours
  // Шаг правил (145) есть не у всех точек — полоса шагов считает честно
  const stepTotal = (loc.rules?.length ?? 0) > 0 ? 4 : 3
  return (
    <div className="px-4 pb-8 flex flex-col items-center">
      <ReserveProgress lang={lang} step={1} total={stepTotal} />

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
            {days.map((d) => {
              // Закрытый день (выходной по расписанию, праздник-исключение
              // или сегодня уже поздно) виден, но выбрать его нельзя.
              const open = dayOpen(d)
              return (
                <option key={d} value={d} disabled={!open}>
                  {dayOptionLabel(d, todayStr, lang)}
                  {open ? '' : ` · ${t(lang, 'rsvDayClosed')}`}
                </option>
              )
            })}
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

      {/* Лист ожидания (122): день занят целиком — предлагаем ждать, а не
          отправляем гостя ни с чем. Тумблер владельца: заведение, которое
          не собирается перезванивать, обещаний не копит. */}
      {dayFull && loc.waitlist && (
        <button
          type="button"
          onClick={onWaitlist}
          className="w-full h-12 mt-3 rounded-2xl border border-gray-300 text-sm font-bold text-gray-900 active:scale-[0.98] transition-all"
        >
          {t(lang, 'rsvJoinWaitlist')}
        </button>
      )}

      {availabilityLoading && (
        <div className="public-reserve-availability-note" aria-live="polite">
          <span aria-hidden />
          {t(lang, 'rsvCheckingSlots')}
        </div>
      )}
      {availabilityError && (
        <div className="w-full mt-4 rounded-2xl bg-red-50 text-red-700 text-sm font-semibold px-4 py-3 text-center" role="alert">
          {t(lang, 'rsvErrAvailability')}
        </div>
      )}

      <button
        onClick={onNext}
        disabled={
          timeSlots.length === 0
          || dayFull
          || timeTaken
          || availabilityLoading
          || availabilityError
        }
        className="w-full h-14 mt-4 rounded-2xl bg-gray-900 text-white font-bold disabled:opacity-40 active:scale-[0.98] transition-all"
      >
        {instant ? t(lang, 'rsvBookNow') : t(lang, 'rsvSubmit')}
      </button>

      <p className="text-sm text-gray-500 mt-4 text-center">{t(lang, 'rsvChooseHint')}</p>

      {/* Зона «часы работы · навигация» (066): часы слева двумя колонками
          (день/время выровнены), кнопки телефона/навигации справа.
          Ширина НЕ 50/50: кнопки занимают ровно свои 80px (shrink-0), всё
          остальное достаётся часам — при делении пополам колонка часов была
          уже, чем требует диапазон «8:00–22:00», и день обрезался, хотя
          рядом с одинокой кнопкой оставалось пустое место.
          Разделитель — только когда есть обе стороны. */}
      {(hasHours || loc.phone || mapsUrl) && (
        <div className={`w-full mt-6 rounded-2xl border border-gray-200 overflow-hidden ${
          hasHours && (loc.phone || mapsUrl)
            ? 'flex divide-x divide-gray-100 rtl:divide-x-reverse'
            : ''
        }`}>
          {hasHours && (
            <div className="min-w-0 grow px-4 py-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{t(lang, 'rsvHoursTitle')}</div>
              {/* Часы показываются из ТОГО ЖЕ расписания, по которому строится
                  сетка слотов (117). Свободный текст остаётся только у точек,
                  которым расписание ещё не заполнили. */}
              {loc.schedule
                ? <ScheduleHours schedule={schedule} lang={lang} />
                : <HoursRows text={loc.hours as string} />}
            </div>
          )}
          {(loc.phone || mapsUrl) && (
            <div className="flex shrink-0 items-center justify-center gap-2 px-3 py-4">
              {loc.phone && (
                <a
                  href={`tel:${loc.phone}`}
                  className="w-20 h-20 rounded-2xl border border-gray-300 flex flex-col items-center justify-center gap-1 text-gray-900 active:scale-[0.96] transition-all"
                >
                  <PhoneIcon />
                  <span className="text-xs font-semibold">{t(lang, 'rsvPhoneBtn')}</span>
                </a>
              )}
              {mapsUrl && (
                <button
                  type="button"
                  onClick={() => setNavOpen(true)}
                  className="w-20 h-20 rounded-2xl border border-gray-300 flex flex-col items-center justify-center gap-1 text-gray-900 active:scale-[0.96] transition-all"
                >
                  <PinIcon />
                  <span className="text-xs font-semibold">{t(lang, 'rsvNavigateBtn')}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {navOpen && (
        <NavChooserSheet
          lang={lang}
          googleMapsUrl={googleMapsUrl}
          wazeUrl={wazeUrl}
          onClose={() => setNavOpen(false)}
        />
      )}
    </div>
  )
}

/** Bottom-sheet выбора навигационного приложения (067): Google Maps / Waze.
 *  Ссылки открываются в новой вкладке; на телефоне ОС передаёт их
 *  соответствующему приложению. Без backdrop-blur (POS-overlay). */
function NavChooserSheet({ lang, googleMapsUrl, wazeUrl, onClose }: {
  lang: Lang
  googleMapsUrl: string | null
  wazeUrl: string | null
  onClose: () => void
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      className="public-reserve-sheet-overlay fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t(lang, 'rsvNavSheetTitle')}
    >
      <div
        className="public-reserve-sheet w-full max-w-lg rounded-t-3xl bg-white px-4 pt-3 pb-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-200" aria-hidden="true" />
        <div className="px-1 pb-3 text-center text-sm font-semibold text-gray-500">
          {t(lang, 'rsvNavSheetTitle')}
        </div>
        <div className="flex flex-col gap-2">
          {googleMapsUrl && (
            <a
              href={googleMapsUrl}
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              className="flex h-14 items-center gap-3 rounded-2xl border border-gray-200 px-4 text-gray-900 active:scale-[0.99] transition-all"
            >
              <GoogleMapsIcon />
              <span className="font-semibold">{t(lang, 'rsvNavGoogleMaps')}</span>
            </a>
          )}
          {wazeUrl && (
            <a
              href={wazeUrl}
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              className="flex h-14 items-center gap-3 rounded-2xl border border-gray-200 px-4 text-gray-900 active:scale-[0.99] transition-all"
            >
              <WazeIcon />
              <span className="font-semibold">{t(lang, 'rsvNavWaze')}</span>
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 h-12 w-full rounded-2xl text-sm font-semibold text-gray-500 active:scale-[0.99] transition-all"
        >
          {t(lang, 'rsvNavCancel')}
        </button>
      </div>
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
function TimesScreen({
  lang, locId, date, time, guests, timeSlots, instant, freeTimes, zones, todayStr,
  conflict, stepTotal, onPick,
}: {
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
  /** Гость вернулся сюда из-за занятого слота (118) */
  conflict: boolean
  /** Сколько всего шагов у потока: 4 с правилами (145), 3 без них */
  stepTotal: number
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
      <ReserveProgress lang={lang} step={2} total={stepTotal} />
      <h2
        className="public-reserve-route-focus text-2xl font-bold text-gray-900 mt-6"
        tabIndex={-1}
      >
        {instant ? t(lang, 'rsvFoundTitle') : t(lang, 'rsvPickTimeTitle')}
      </h2>
      {conflict && (
        <div
          className="w-full mt-4 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3"
          role="alert"
        >
          {t(lang, 'rsvConflictHint')}
        </div>
      )}

      <div className="mt-4">
        <ReserveSelectionSummary
          lang={lang}
          date={date}
          time={time}
          guests={guests}
          todayStr={todayStr}
        />
      </div>

      <div className="mt-5 space-y-6">
        {sections.map((s, i) => {
          // Свободные времена секции: своя зона → её запрос; общая → freeTimes
          const q = zoneQueries[i]
          const secFree = s.id === null
            ? freeTimes
            : (instant && q?.data
                ? new Set(q.data.slots.filter((sl) => sl.free).map((sl) => sl.time))
                : null)
          const checking = instant && s.id !== null && q?.isPending
          const failed = instant && s.id !== null && q?.isError
          return (
            <ZoneTimeRow
              key={s.id ?? '__any__'}
              lang={lang}
              zoneName={s.name}
              chips={chips}
              time={time}
              instant={instant}
              freeTimes={secFree}
              checking={checking}
              failed={failed}
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
function ZoneTimeRow({
  lang, zoneName, chips, time, instant, freeTimes, checking, failed, onPick,
}: {
  lang: Lang
  zoneName: string | null
  chips: string[]
  time: string
  instant: boolean
  freeTimes: Set<string> | null
  checking: boolean
  failed: boolean
  onPick: (v: string) => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const requested = stripRef.current
      ?.querySelector<HTMLElement>('[data-requested="true"]')
    if (!requested) return
    // scrollIntoView надёжно учитывает разные RTL-модели scrollLeft, но
    // некоторые Safari/Chrome заодно двигают документ по вертикали.
    // Возвращаем прежний Y синхронно, до первого paint.
    const scrollY = window.scrollY
    requested.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' })
    window.scrollTo({ top: scrollY, left: 0, behavior: 'auto' })
  }, [time, chips])

  return (
    <section>
      {zoneName && (
        <div className="flex items-center gap-2 mb-3">
          <span className="w-5 h-5 flex items-center justify-center text-gray-500 shrink-0"><ChairIcon /></span>
          <h3 className="text-base font-bold text-gray-900">{zoneName}</h3>
        </div>
      )}
      {failed && (
        <p className="mb-3 text-sm font-semibold text-red-600" role="alert">
          {t(lang, 'rsvErrAvailability')}
        </p>
      )}
      <div ref={stripRef} className="public-reserve-time-strip">
        {chips.map((s) => {
          const current = s === time
          // instant: занят, если явно не в множестве свободных
          const full = failed || checking || (instant && freeTimes !== null && !freeTimes.has(s))
          // Мгновенное подтверждение — только instant + слот свободен
          const now = instant && !checking && !failed && freeTimes !== null && freeTimes.has(s)
          return (
            <button
              key={s}
              data-requested={current || undefined}
              onClick={() => !full && onPick(s)}
              disabled={full}
              aria-label={`${s}${zoneName ? ` · ${zoneName}` : ''} · ${
                checking ? t(lang, 'rsvCheckingSlots') : full ? t(lang, 'rsvSlotFull') : now ? t(lang, 'rsvInstantLabel') : t(lang, 'rsvPhoneLabel')
              }`}
              className={`public-reserve-time-card ${
                full
                  ? 'is-disabled'
                  : current
                    ? 'is-requested'
                    : ''
              }`}
            >
              <span className={`text-base font-bold tabular-nums ${full ? 'text-gray-300' : 'text-gray-900'}`}>{s}</span>
              {checking ? (
                <span className="public-reserve-time-loading" aria-hidden />
              ) : full ? (
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
    case 'waitlist_disabled': return t(lang, 'rsvErrWaitlistOff')
    case 'rules_not_accepted': return t(lang, 'rsvErrRules')
    default: return t(lang, 'rsvErrUnknown')
  }
}

/**
 * Правила брони (145) — самостоятельный шаг между временем и контактами.
 *
 * Порядок внутри экрана: сначала пункты «просто знать», затем те, что
 * требуют отметки. Вперемешку галочку легко пропустить, а отказ сервера
 * из-за неотмеченного пункта гость воспринимает как поломку страницы.
 *
 * Кнопка НЕ дизейблится: неактивная кнопка без объяснения — та самая
 * причина, по которой звонят в заведение. Нажатие показывает, каких
 * именно подтверждений не хватает, и уводит фокус на первое из них.
 */
function RulesScreen({
  lang, rules, date, time, guests, todayStr, zoneName, checked, stale, onChecked, onNext,
}: {
  lang: Lang
  rules: ReserveRule[]
  date: string
  time: string
  guests: number
  todayStr: string
  zoneName: string | null
  checked: string[]
  /** Сервер отклонил прежнее согласие: правила успели измениться */
  stale: boolean
  onChecked: (next: string[]) => void
  onNext: () => void
}) {
  const [showValidation, setShowValidation] = useState(false)
  const acksRef = useRef<HTMLDivElement>(null)

  const notes = rules.filter((rule) => !rule.ack)
  const acks = rules.filter((rule) => rule.ack)
  const missing = acks.filter((rule) => !checked.includes(rule.id))

  function toggle(id: string) {
    onChecked(checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id])
  }

  function next() {
    if (missing.length > 0) {
      setShowValidation(true)
      window.setTimeout(() => {
        acksRef.current
          ?.querySelector<HTMLInputElement>('input[data-missing="true"]')
          ?.focus()
      }, 0)
      return
    }
    onNext()
  }

  return (
    <div className="px-4 pb-8">
      <ReserveProgress lang={lang} step={3} total={4} />
      <h2
        className="public-reserve-route-focus text-2xl font-bold text-gray-900 mt-6"
        tabIndex={-1}
      >
        {t(lang, 'rsvRulesTitle')}
      </h2>
      <p className="text-sm text-gray-500 mt-1">{t(lang, 'rsvRulesHint')}</p>

      <div className="mt-4">
        <ReserveSelectionSummary
          lang={lang}
          date={date}
          time={time}
          guests={guests}
          todayStr={todayStr}
          zoneName={zoneName}
        />
      </div>

      {stale && (
        <div
          className="mt-4 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3"
          role="alert"
        >
          {t(lang, 'rsvErrRules')}
        </div>
      )}

      {notes.length > 0 && (
        <ul className="public-reserve-rules">
          {notes.map((rule) => (
            <li key={rule.id} data-level={rule.level}>
              <span aria-hidden="true" />
              <p><RuleText rule={rule} /></p>
            </li>
          ))}
        </ul>
      )}

      {acks.length > 0 && (
        <div className="public-reserve-rules-acks" ref={acksRef}>
          {acks.map((rule) => {
            const on = checked.includes(rule.id)
            return (
              <label key={rule.id} data-missing={showValidation && !on ? 'true' : undefined}>
                <input
                  type="checkbox"
                  checked={on}
                  data-missing={showValidation && !on ? 'true' : undefined}
                  aria-invalid={showValidation && !on}
                  onChange={() => toggle(rule.id)}
                />
                <span><RuleText rule={rule} /></span>
              </label>
            )
          })}
        </div>
      )}

      {showValidation && missing.length > 0 && (
        <p className="text-sm font-semibold text-red-600 mt-3" role="alert">
          {t(lang, 'rsvRulesNeedAck')}
        </p>
      )}

      <button type="button" onClick={next} className="public-reserve-primary-action">
        {t(lang, 'rsvRulesContinue')}
      </button>
    </div>
  )
}

/** Пункт правила: со ссылкой — ссылкой (условия использования), иначе текстом */
function RuleText({ rule }: { rule: ReserveRule }) {
  if (!rule.url) return <>{rule.text}</>
  return (
    <a href={rule.url} target="_blank" rel="noreferrer noopener" className="underline">
      {rule.text}
    </a>
  )
}

function DetailsScreen({
  lang, locId, date, time, guests, instant, zoneId, zoneName, todayStr, preview,
  reservedAt, draft, onDraft, clientUuid, rulesAck, stepOf, onSubmitted, onConflict,
  onRulesStale,
}: {
  lang: Lang
  locId: string
  date: string
  time: string
  guests: number
  /** Предпросмотр владельца (126): форма проходится, но заявка не уходит */
  preview: boolean
  /** instant-режим (063): CTA — «Подтвердить бронь», не «Отправить заявку» */
  instant: boolean
  /** Пожелание зоны (072); null = без предпочтений */
  zoneId: string | null
  zoneName: string | null
  todayStr: string
  /** Абсолютный момент выбранного слота в зоне ТОЧКИ (117); null = слот
   *  пропал из расписания, пока гость заполнял форму */
  reservedAt: Date | null
  draft: { name: string; phone: string; note: string }
  onDraft: (draft: { name: string; phone: string; note: string }) => void
  clientUuid: string
  /** Отмеченные правила (145); проверяет их сервер, не эта форма */
  rulesAck: string[]
  /** Сколько всего шагов у потока: 4 с правилами, 3 без них */
  stepOf: number
  onSubmitted: (clientUuid: string) => void
  /** Правила точки изменились — согласие устарело и собирается заново */
  onRulesStale: () => void
  /** Слот заняли, пока гость заполнял форму: возвращаем его к выбору
   *  времени со свежей доступностью, не стирая контакты. */
  onConflict: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showValidation, setShowValidation] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)
  const { name, phone, note } = draft

  const phoneDigits = phone.replace(/\D/g, '')
  const nameValid = name.trim().length > 0
  const phoneValid = phoneDigits.length >= 9
  const valid = nameValid && phoneValid

  /**
   * Первое касание формы (124). Отличает «не нашёл подходящего времени»
   * от «начал оформлять и передумал» — а это разные проблемы заведения.
   * Повторные нажатия отсекаются дедупликацией шага.
   */
  function editDraft(next: { name: string; phone: string; note: string }) {
    trackReserveStep(locId, 'form_started', { party_size: guests, wanted_date: date })
    onDraft(next)
  }

  async function submit() {
    if (busy) return
    setShowValidation(true)
    if (!valid) {
      window.setTimeout(() => {
        if (!nameValid) nameRef.current?.focus()
        else phoneRef.current?.focus()
      }, 0)
      return
    }
    // Момент визита приходит из сетки и посчитан в зоне ТОЧКИ (117).
    // Собирать его здесь из `date` и `time` нельзя: у ночной смены метка
    // «01:00» принадлежит следующим суткам, а в зоне устройства то же
    // локальное время означает другой момент. Слот исчез из расписания —
    // просим выбрать время заново, а не отправляем угаданное.
    const at = reservedAt
    if (!at || Number.isNaN(at.getTime())) {
      setError(t(lang, 'rsvErrTime'))
      return
    }
    // Предпросмотр доходит до последнего шага и честно останавливается:
    // владелец видит всю форму, но настоящая бронь отсюда не появляется.
    // Тестовая бронь делается в кабинете и помечается is_test (126).
    if (preview) {
      setError(t(lang, 'rsvPreviewBlocked'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await submitPublicReservation({
        loc: locId,
        client_uuid: clientUuid,
        name: name.trim(),
        phone: phoneDigits,
        party_size: guests,
        reserved_at: at.toISOString(),
        note: note.trim() || null,
        zone_id: zoneId,
        rules_ack: rulesAck,
      })
      // Конец воронки (124). Здесь, а не в onSubmitted: `reservation_id`
      // есть только тут, и именно он связывает канал привода с бронью.
      trackReserveStep(locId, 'submitted', {
        party_size: guests,
        wanted_date: date,
        wanted_time: time,
        zone_id: zoneId,
        reservation_id: result.reservation_id,
      })
      // Старый сервер (до 118) токена не вернёт — тогда ключом остаётся
      // client_uuid, и страница работает как раньше.
      onSubmitted(result.public_token ?? clientUuid)
    } catch (e) {
      const code = e instanceof PublicApiError ? e.code : 'unknown'
      setBusy(false)
      // Конфликт — не тупик: пока гость набирал имя, слот заняли. Форму
      // сохраняем (контакты живут выше экранов) и показываем СВЕЖИЕ
      // варианты времени вместо красной надписи в никуда.
      if (code === 'full_slot' || code === 'outside_hours' || code === 'invalid_time') {
        onConflict()
        return
      }
      // Правила изменились, пока гость заполнял форму (145): красная
      // надпись под именем тут бесполезна — вернуть надо к самим правилам.
      if (code === 'rules_not_accepted') {
        onRulesStale()
        return
      }
      setError(reserveErrorText(lang, code))
    }
  }

  return (
    <div className="px-4 pb-8">
      <ReserveProgress lang={lang} step={stepOf} total={stepOf} />
      <h2
        className="public-reserve-route-focus text-2xl font-bold text-gray-900 mt-6"
        tabIndex={-1}
      >
        {t(lang, 'rsvDetailsTitle')}
      </h2>

      <div className="mt-4">
        <ReserveSelectionSummary
          lang={lang}
          date={date}
          time={time}
          guests={guests}
          todayStr={todayStr}
          zoneName={zoneName}
        />
      </div>

      <div className="public-reserve-details-fields">
        <label>
          <span>{t(lang, 'rsvName')}</span>
          <input
            ref={nameRef}
            autoComplete="name"
            value={name}
            aria-invalid={showValidation && !nameValid}
            aria-describedby={showValidation && !nameValid ? 'reserve-name-error' : undefined}
            onChange={(event) => editDraft({ ...draft, name: event.target.value })}
          />
          {showValidation && !nameValid && (
            <small id="reserve-name-error">{t(lang, 'rsvErrName')}</small>
          )}
        </label>
        <label>
          <span>{t(lang, 'rsvPhone')}</span>
          <input
            ref={phoneRef}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            value={phone}
            aria-invalid={showValidation && !phoneValid}
            aria-describedby={showValidation && !phoneValid ? 'reserve-phone-error' : undefined}
            onChange={(event) => editDraft({ ...draft, phone: event.target.value })}
          />
          {showValidation && !phoneValid && (
            <small id="reserve-phone-error">{t(lang, 'rsvErrPhone')}</small>
          )}
        </label>
        <label>
          <span>{t(lang, 'rsvNote')}</span>
          <textarea
            rows={3}
            maxLength={200}
            value={note}
            onChange={(event) => editDraft({ ...draft, note: event.target.value })}
          />
          <em>{note.length}/200</em>
        </label>
      </div>

      {error && (
        <div className="mt-4 rounded-2xl bg-red-50 text-red-700 text-sm font-semibold px-4 py-3" role="alert">
          {error}
        </div>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="public-reserve-primary-action"
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

/**
 * Постоянная страница брони (118). Открывается и по ссылке `?b=<токен>`, и
 * из localStorage прежнего гостя, поэтому доступ к брони больше не умирает
 * вместе с браузером, в котором её оформили.
 *
 * Всё, что здесь можно сделать, разрешает СЕРВЕР (`can_cancel` /
 * `can_reschedule`): правило отсечки живёт в одном месте. Клиент лишь
 * объясняет отказ человеческими словами.
 */
function BookingScreen({ lang, bookingKey, tz, onNew }: {
  lang: Lang
  bookingKey: string
  tz: string
  onNew: (seed?: { name?: string; guests?: number }) => void
}) {
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [rescheduling, setRescheduling] = useState(false)
  const [attendBusy, setAttendBusy] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const qc = useQueryClient()

  const { data: view, error: viewError } = useQuery({
    queryKey: ['reserve_view', bookingKey],
    queryFn: () => fetchReservationView(bookingKey),
    // Ждём решения кассы — опрашиваем часто; решённую бронь опрашивать
    // незачем, она не меняется сама по себе.
    refetchInterval: (query) => (query.state.data?.status === 'new' ? 5000 : false),
    retry: (_count, error) => !(error instanceof PublicApiError && error.code === 'not_found'),
  })

  // Ссылка ведёт в никуда: бронь удалили или ключ чужой. Выводим из ошибки
  // запроса, а не отдельным состоянием — иначе оно живёт своей жизнью.
  const lost = viewError instanceof PublicApiError && viewError.code === 'not_found'

  async function doCancel() {
    if (cancelBusy) return
    setCancelBusy(true)
    setCancelError(null)
    try {
      await cancelPublicReservation(bookingKey)
      await qc.invalidateQueries({ queryKey: ['reserve_view', bookingKey] })
      setConfirmCancel(false)
    } catch (e) {
      const code = e instanceof PublicApiError ? e.code : 'unknown'
      setCancelError(guestBlockText(lang, code))
    }
    setCancelBusy(false)
  }

  if (lost) {
    return (
      <CenterCard>
        <p className="font-bold text-gray-900">{t(lang, 'pubStatusLost')}</p>
        {/* Брони нет — переносить в новую нечего */}
        <NewBtn lang={lang} onClick={() => onNew()} />
      </CenterCard>
    )
  }
  if (!view) {
    return <CenterCard><p className="text-gray-500">{t(lang, 'loading')}</p></CenterCard>
  }

  const loc = view.location
  /*
   * Что переносится в повторную бронь: имя и размер компании. Телефон
   * сервер наружу не отдаёт (118) — попавшая не в те руки ссылка не
   * должна выдавать номер.
   */
  const repeatSeed = { name: view.customer_name, guests: view.party_size }
  const hasCoords = loc.lat != null && loc.lng != null
  const googleMapsUrl = hasCoords
    ? `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`
    : loc.address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.address)}`
      : null
  const wazeUrl = hasCoords
    ? `https://waze.com/ul?ll=${loc.lat},${loc.lng}&navigate=yes`
    : loc.address
      ? `https://waze.com/ul?q=${encodeURIComponent(loc.address)}&navigate=yes`
      : null

  if (view.status === 'rejected') {
    return (
      <CenterCard>
        <p className="text-2xl font-black text-gray-900">{t(lang, 'rsvRejectedTitle')}</p>
        <p className="text-sm text-gray-500 mt-2">{view.reject_reason || t(lang, 'rsvRejectedHint')}</p>
        <NewBtn lang={lang} onClick={() => onNew(repeatSeed)} />
      </CenterCard>
    )
  }

  // no_show (102) для гостя равнозначен отменённой брони — визит не состоялся
  if (view.status === 'cancelled' || view.status === 'no_show') {
    return (
      <CenterCard>
        <p className="text-2xl font-black text-gray-900">{t(lang, 'rsvCancelledTitle')}</p>
        <NewBtn lang={lang} onClick={() => onNew(repeatSeed)} />
      </CenterCard>
    )
  }

  const details = (
    <div className="mt-4 rounded-2xl bg-gray-50 px-4 py-3 text-start">
      <div className="font-bold text-gray-900">{visitLabel(view.reserved_at, lang)}</div>
      <div className="text-sm text-gray-500 mt-1">
        {view.customer_name} · {view.party_size} {t(lang, 'resGuestsShort')}
        {view.zone_name && <> · {view.zone_name}</>}
        {view.table_label && <> · {t(lang, 'tableLabel')} {view.table_label}</>}
      </div>
      {loc.address && <div className="text-sm text-gray-500 mt-1">{loc.address}</div>}
    </div>
  )

  // Дорога и звонок: страница брони должна отвечать «как доехать» сама,
  // не отправляя гостя обратно на витрину.
  const contacts = (loc.phone || googleMapsUrl) ? (
    <div className="mt-3 flex gap-2">
      {loc.phone && (
        <a
          href={`tel:${loc.phone}`}
          className="flex-1 h-12 rounded-xl border border-gray-300 text-sm font-semibold text-gray-900 flex items-center justify-center gap-2 active:scale-[0.97] transition-all"
        >
          <PhoneIcon />
          {t(lang, 'rsvPhoneBtn')}
        </a>
      )}
      {googleMapsUrl && (
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          className="flex-1 h-12 rounded-xl border border-gray-300 text-sm font-semibold text-gray-900 flex items-center justify-center gap-2 active:scale-[0.97] transition-all"
        >
          <PinIcon />
          {t(lang, 'rsvNavigateBtn')}
        </button>
      )}
    </div>
  ) : null

  const actions = (
    <>
      {/* Просьба подтвердить приход (122). Кнопка появляется, только когда
          заведение действительно попросило: без этого гость не понимает,
          что от него хотят. */}
      {view.status === 'confirmed' && view.confirm_requested_at && !view.guest_confirmed_at && (
        <button
          type="button"
          disabled={attendBusy}
          onClick={async () => {
            setAttendBusy(true)
            try {
              await confirmAttendance(bookingKey)
              await qc.invalidateQueries({ queryKey: ['reserve_view', bookingKey] })
            } catch { /* поллинг догонит актуальный статус */ }
            setAttendBusy(false)
          }}
          className="w-full h-12 mt-3 rounded-xl bg-gray-900 text-white text-sm font-bold active:scale-[0.97] transition-all disabled:opacity-40"
        >
          {t(lang, 'rsvConfirmAttend')}
        </button>
      )}
      {view.guest_confirmed_at && (
        <p className="text-sm font-semibold text-green-700 mt-3">
          {t(lang, 'rsvAttendConfirmed')}
        </p>
      )}

      {view.can_reschedule && (
        <button
          type="button"
          onClick={() => setRescheduling(true)}
          className="w-full h-12 mt-3 rounded-xl border border-gray-300 text-sm font-semibold text-gray-900 active:scale-[0.97] transition-all"
        >
          {t(lang, 'rsvReschedule')}
        </button>
      )}
      {view.can_cancel ? (
        confirmCancel ? (
          <div className="flex gap-2 mt-3">
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
            className="w-full h-12 mt-3 rounded-xl bg-gray-100 text-sm font-semibold text-gray-700 active:scale-[0.97] transition-all"
            onClick={() => setConfirmCancel(true)}
          >
            {t(lang, 'rsvCancelAction')}
          </button>
        )
      ) : (
        // Кнопки нет — объясняем почему. Неактивная кнопка без причины
        // заставляет звонить в заведение, а ровно этого мы и избегаем.
        <p className="text-sm text-gray-500 mt-3">
          {guestBlockText(lang, view.cancel_block ?? 'unknown')}
        </p>
      )}
      {cancelError && (
        <p className="text-sm font-semibold text-red-600 mt-3" role="alert">{cancelError}</p>
      )}
      {loc.policy && <p className="text-xs text-gray-500 mt-3">{loc.policy}</p>}
    </>
  )

  const sheets = (
    <>
      {navOpen && googleMapsUrl && (
        <NavChooserSheet
          lang={lang}
          googleMapsUrl={googleMapsUrl}
          wazeUrl={wazeUrl}
          onClose={() => setNavOpen(false)}
        />
      )}
      {rescheduling && (
        <RescheduleSheet
          lang={lang}
          view={view}
          tz={tz}
          bookingKey={bookingKey}
          onClose={() => setRescheduling(false)}
          onDone={async () => {
            await qc.invalidateQueries({ queryKey: ['reserve_view', bookingKey] })
            setRescheduling(false)
          }}
        />
      )}
    </>
  )

  if (view.status === 'new') {
    return (
      <CenterCard>
        <div className="public-reserve-status-spinner w-10 h-10 mx-auto rounded-full border-4 border-gray-200 border-t-gray-900" />
        <p className="text-xl font-bold text-gray-900 mt-5">{t(lang, 'rsvPendingTitle')}</p>
        <p className="text-sm text-gray-500 mt-2">{t(lang, 'rsvPendingHint')}</p>
        {details}
        {contacts}
        {actions}
        {sheets}
      </CenterCard>
    )
  }

  // confirmed / completed (102): после визита карточка остаётся
  // подтверждённой, но действовать уже нечего
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
      {view.status === 'confirmed' && (
        <button
          type="button"
          onClick={() => downloadIcs({
            uid: view.public_token,
            start: new Date(view.reserved_at),
            durationMin: view.duration_min,
            summary: `${t(lang, 'rsvPageLabel')} · ${loc.name}`,
            location: loc.address,
            description: `${view.customer_name} · ${view.party_size} ${t(lang, 'resGuestsShort')}`,
          })}
          className="w-full h-12 mt-4 rounded-xl border border-gray-300 text-sm font-semibold text-gray-900 flex items-center justify-center gap-2 active:scale-[0.97] transition-all"
        >
          <CalendarIcon />
          {t(lang, 'rsvAddToCalendar')}
        </button>
      )}
      {contacts}
      {view.status === 'completed'
        ? <NewBtn lang={lang} onClick={() => onNew(repeatSeed)} />
        : actions}
      {sheets}
    </CenterCard>
  )
}

/** Почему действие недоступно — человеческими словами, а не кодом */
function guestBlockText(lang: Lang, code: string): string {
  switch (code) {
    case 'too_late': return t(lang, 'rsvBlockTooLate')
    case 'pos_mode': return t(lang, 'rsvBlockSeated')
    case 'reschedule_limit': return t(lang, 'rsvBlockLimit')
    case 'not_active': return t(lang, 'rsvBlockInactive')
    default: return t(lang, 'rsvErrUnknown')
  }
}

/**
 * Перенос брони: та же сетка слотов, что и при первичном бронировании,
 * поэтому гость не встречает второй, непохожей логики выбора времени.
 * Неудачная попытка не трогает уже существующую бронь — это гарантирует
 * сервер, здесь мы только показываем ошибку и оставляем лист открытым.
 */
function RescheduleSheet({ lang, view, tz, bookingKey, onClose, onDone }: {
  lang: Lang
  view: ReservationView
  tz: string
  bookingKey: string
  onClose: () => void
  onDone: () => void
}) {
  const { locId = '' } = useParams()
  const [nowMs] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: info } = useQuery({
    queryKey: ['public_reserve_info', locId],
    queryFn: () => fetchReserveInfo(locId),
    staleTime: 30_000,
  })
  const schedule = useMemo(() => normalizeSchedule(info?.location), [info])
  const stepMin = info?.location.slot_min && info.location.slot_min > 0
    ? info.location.slot_min : DEF_STEP_MIN

  const todayStr = useMemo(() => todayInZone(nowMs, tz), [nowMs, tz])
  const days = useMemo(() => {
    const count = Math.min(schedule.horizonDays, MAX_DAYS_SHOWN)
    return Array.from({ length: count }, (_, i) => shiftDate(todayStr, i))
      .filter((d) => hasBookableSlot({ schedule, dateStr: d, tz, stepMin, nowMs }))
  }, [todayStr, schedule, tz, stepMin, nowMs])

  // Лист открывается на дате И времени САМОЙ брони, а не на первом
  // свободном дне: иначе гость, сдвигающий время на полчаса, молча
  // переносит визит на другой день (поймано живой приёмкой).
  const currentDate = useMemo(
    () => localDateOf(new Date(view.reserved_at).getTime(), tz),
    [view.reserved_at, tz]
  )
  const [date, setDate] = useState('')
  const effectiveDate = date
    || (days.includes(currentDate) ? currentDate : days[0])
    || ''
  const slots = useMemo(
    () => (effectiveDate
      ? slotGrid({ schedule, dateStr: effectiveDate, tz, stepMin, nowMs })
      : []),
    [schedule, effectiveDate, tz, stepMin, nowMs]
  )
  const currentTime = useMemo(
    () => localTimeOf(new Date(view.reserved_at).getTime(), tz),
    [view.reserved_at, tz]
  )
  const [time, setTime] = useState('')
  const preferred = time || (effectiveDate === currentDate ? currentTime : '')
  const effectiveTime = slots.some((s) => s.time === preferred)
    ? preferred
    : slots[0]?.time ?? ''
  const selected = slots.find((s) => s.time === effectiveTime) ?? null

  async function submit() {
    if (busy || !selected) return
    setBusy(true)
    setError(null)
    try {
      await reschedulePublicReservation(bookingKey, selected.at.toISOString(), view.zone_id)
      onDone()
    } catch (e) {
      const code = e instanceof PublicApiError ? e.code : 'unknown'
      setError(code === 'full_slot' ? t(lang, 'rsvErrFull') : guestBlockText(lang, code))
      setBusy(false)
    }
  }

  // Модалка ведёт себя как соседний NavChooserSheet: фон не прокручивается,
  // Escape закрывает. Иначе гость на телефоне «проваливается» сквозь лист.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      className="public-reserve-sheet-overlay fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t(lang, 'rsvReschedule')}
    >
      <div
        className="public-reserve-sheet w-full max-w-lg rounded-t-3xl bg-white px-4 pt-3 pb-6 shadow-xl text-start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-200" aria-hidden="true" />
        <h3 className="text-lg font-bold text-gray-900">{t(lang, 'rsvReschedule')}</h3>
        <p className="text-sm text-gray-500 mt-1">{t(lang, 'rsvRescheduleHint')}</p>

        {days.length === 0 ? (
          <p className="mt-4 text-sm font-semibold text-amber-700">{t(lang, 'rsvNoFreeSlots')}</p>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-gray-500">{t(lang, 'rsvDate')}</span>
              <select
                className="h-12 rounded-xl border border-gray-300 px-3 text-base"
                value={effectiveDate}
                onChange={(e) => { setDate(e.target.value); setTime('') }}
              >
                {days.map((d) => (
                  <option key={d} value={d}>{dayOptionLabel(d, todayStr, lang)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-gray-500">{t(lang, 'rsvTime')}</span>
              <select
                className="h-12 rounded-xl border border-gray-300 px-3 text-base tabular-nums"
                value={effectiveTime}
                onChange={(e) => setTime(e.target.value)}
              >
                {slots.map((s) => (
                  <option key={s.time} value={s.time}>{s.time}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {error && (
          <p className="mt-3 text-sm font-semibold text-red-600" role="alert">{error}</p>
        )}

        <div className="flex gap-2 mt-5">
          <button
            type="button"
            className="flex-1 h-12 rounded-xl bg-gray-100 text-sm font-semibold text-gray-700 active:scale-[0.97] transition-all"
            onClick={onClose}
          >
            {t(lang, 'cancel')}
          </button>
          <button
            type="button"
            className="flex-1 h-12 rounded-xl bg-gray-900 text-white text-sm font-bold active:scale-[0.97] transition-all disabled:opacity-40"
            disabled={busy || !selected}
            onClick={submit}
          >
            {busy ? t(lang, 'pubSubmitting') : t(lang, 'rsvRescheduleConfirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Лист ожидания (122): день занят, но гость готов ждать. Просим ровно то,
 * что нужно хостес для подбора — диапазон времени и зоны, — и ни строчкой
 * больше: это ещё не бронь, а согласие подождать.
 *
 * Контакты берутся из общего черновика сценария: гость, дошедший сюда с
 * шага деталей, не вводит имя и телефон заново.
 */
function WaitlistSheet({ lang, locId, date, guests, zones, draft, onDraft, onClose }: {
  lang: Lang
  locId: string
  date: string
  guests: number
  zones: { id: string; name: string }[]
  draft: { name: string; phone: string; note: string }
  onDraft: (d: { name: string; phone: string; note: string }) => void
  onClose: () => void
}) {
  const [from, setFrom] = useState('18:00')
  const [to, setTo] = useState('21:00')
  const [pickedZones, setPickedZones] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientUuid] = useState(() => crypto.randomUUID())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const phoneDigits = draft.phone.replace(/\D/g, '')
  const valid = draft.name.trim().length > 0 && phoneDigits.length >= 9 && to > from

  async function submit() {
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    try {
      await joinWaitlist({
        loc: locId,
        client_uuid: clientUuid,
        name: draft.name.trim(),
        phone: phoneDigits,
        party_size: guests,
        date,
        time_from: from,
        time_to: to,
        zone_ids: pickedZones,
        note: draft.note.trim() || null,
      })
      // Лист ожидания — тоже исход воронки, а не её обрыв (124): гость
      // никуда не ушёл, ему просто нечего было забронировать.
      trackReserveStep(locId, 'waitlisted', { party_size: guests, wanted_date: date })
      setDone(true)
    } catch (e) {
      const code = e instanceof PublicApiError ? e.code : 'unknown'
      setError(reserveErrorText(lang, code))
    }
    setBusy(false)
  }

  return (
    <div
      className="public-reserve-sheet-overlay fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t(lang, 'rsvJoinWaitlist')}
    >
      <div
        className="public-reserve-sheet w-full max-w-lg rounded-t-3xl bg-white px-4 pt-3 pb-6 shadow-xl text-start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-200" aria-hidden />

        {done ? (
          <div className="py-6 text-center">
            <p className="text-xl font-bold text-gray-900">{t(lang, 'rsvWaitlistDoneTitle')}</p>
            <p className="text-sm text-gray-500 mt-2">{t(lang, 'rsvWaitlistDoneHint')}</p>
            <button
              type="button"
              onClick={onClose}
              className="w-full h-12 mt-5 rounded-xl bg-gray-900 text-white text-sm font-bold"
            >
              {t(lang, 'close')}
            </button>
          </div>
        ) : (
          <>
            <h3 className="text-lg font-bold text-gray-900">{t(lang, 'rsvJoinWaitlist')}</h3>
            <p className="text-sm text-gray-500 mt-1">{t(lang, 'rsvWaitlistHint')}</p>

            <div className="grid grid-cols-2 gap-3 mt-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-gray-500">{t(lang, 'rsvWaitFrom')}</span>
                <input
                  type="time" value={from} onChange={(e) => setFrom(e.target.value)}
                  className="h-12 rounded-xl border border-gray-300 px-3 text-base"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-gray-500">{t(lang, 'rsvWaitTo')}</span>
                <input
                  type="time" value={to} onChange={(e) => setTo(e.target.value)}
                  className="h-12 rounded-xl border border-gray-300 px-3 text-base"
                />
              </label>
            </div>

            {zones.length >= 2 && (
              <div className="mt-3">
                <span className="text-xs font-semibold text-gray-500">{t(lang, 'rsvWaitZones')}</span>
                <div className="flex flex-wrap gap-2 mt-1.5">
                  {zones.map((z) => (
                    <button
                      key={z.id}
                      type="button"
                      onClick={() => setPickedZones((cur) => (
                        cur.includes(z.id) ? cur.filter((x) => x !== z.id) : [...cur, z.id]
                      ))}
                      className={`h-11 px-4 rounded-xl border text-sm font-semibold ${
                        pickedZones.includes(z.id)
                          ? 'bg-gray-900 text-white border-gray-900'
                          : 'border-gray-300 text-gray-700'
                      }`}
                    >
                      {z.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="public-reserve-details-fields">
              <label>
                <span>{t(lang, 'rsvName')}</span>
                <input
                  autoComplete="name" value={draft.name}
                  onChange={(e) => onDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                <span>{t(lang, 'rsvPhone')}</span>
                <input
                  type="tel" inputMode="tel" autoComplete="tel" dir="ltr" value={draft.phone}
                  onChange={(e) => onDraft({ ...draft, phone: e.target.value })}
                />
              </label>
            </div>

            {error && (
              <p className="mt-3 text-sm font-semibold text-red-600" role="alert">{error}</p>
            )}

            <div className="flex gap-2 mt-4">
              <button
                type="button" onClick={onClose}
                className="flex-1 h-12 rounded-xl bg-gray-100 text-sm font-semibold text-gray-700"
              >
                {t(lang, 'cancel')}
              </button>
              <button
                type="button" disabled={busy || !valid} onClick={submit}
                className="flex-1 h-12 rounded-xl bg-gray-900 text-white text-sm font-bold disabled:opacity-40"
              >
                {busy ? t(lang, 'pubSubmitting') : t(lang, 'rsvWaitlistSubmit')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-[#f8f8f7] px-4 py-8">
      <div
        className="text-center w-full rounded-3xl border border-gray-100 bg-white px-6 py-8 shadow-sm"
        aria-live="polite"
      >
        {children}
      </div>
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

/** Пин-маркер Google Maps в фирменных цветах */
function GoogleMapsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 22s7-6.7 7-12a7 7 0 1 0-14 0c0 5.3 7 12 7 12Z" fill="#34A853" />
      <path d="M12 3a7 7 0 0 0-6.3 4l6.3 6L18.6 8.6A7 7 0 0 0 12 3Z" fill="#4285F4" />
      <path d="M5.7 7A7 7 0 0 0 5 10c0 2.3 1.3 4.6 2.8 6.5L12 13 5.7 7Z" fill="#FBBC04" />
      <circle cx="12" cy="10" r="2.5" fill="#fff" />
    </svg>
  )
}

/** Логотип-маска Waze (упрощённая), в фирменном голубом */
function WazeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3a8 8 0 0 1 8 8c0 2.7-.8 4.1-.8 5.3 0 .9.5 1.4.5 2.1 0 .8-.7 1.3-1.5 1.3-1.2 0-1.9-1-3-1a15 15 0 0 1-3.2.3A8 8 0 0 1 12 3Z" fill="#33CCFF" />
      <circle cx="9.5" cy="10.5" r="1.1" fill="#0a1b2a" />
      <circle cx="14.5" cy="10.5" r="1.1" fill="#0a1b2a" />
      <path d="M9 14c.7 1 2 1.6 3 1.6s2.3-.6 3-1.6" stroke="#0a1b2a" strokeWidth="1.3" strokeLinecap="round" />
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
