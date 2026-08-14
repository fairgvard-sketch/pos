import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { t, type Lang } from '../../lib/i18n'
import { PublicApiError } from '../online/publicApi'
import { navigateWithTransition } from '../online/viewTransition'
import {
  fetchReserveInfo, submitPublicReservation, fetchReservationView,
  cancelPublicReservation, fetchAvailability, reschedulePublicReservation,
  joinWaitlist, confirmAttendance, beginReservationPrepayment,
  type ReserveInfo, type ReservationView, type ReserveRule,
  type ReservePrepayRule,
} from './publicReserveApi'
import { trackReserveStep, resetFunnelSession } from './funnel'
import {
  composeName, composeNote, draftErrors, isDraftValid, reserveFlow, stepAfter,
  stepBefore, stepIndex, EMPTY_DRAFT, EXTRA_KEYS,
  type DetailsDraft, type ReserveStep,
} from './reserveFlow'
import BrandSplash from '../../components/ui/BrandSplash'
import {
  dayWindows, dowOf, formatWindows, hasBookableSlot, hmToMin, isOpenAt,
  normalizeSchedule, partsInZone, shiftDate, slotGrid, weeklyHoursRows,
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
  const [detailsDraft, setDetailsDraft] = useState<DetailsDraft>(EMPTY_DRAFT)
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
  // Ключ попытки оплаты (164) создаётся ДО первой попытки: повторный тап
  // «оплатить» и повтор после таймаута обязаны попасть в ту же попытку.
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID())
  const [payBusy, setPayBusy] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)

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
  // Ключ содержит зону явным null: при точке без зон это ТОТ ЖЕ ключ, что
  // и у экрана времени, и оба экрана делят один ответ вместо двух запросов.
  const {
    data: avail,
    isError: availabilityError,
  } = useQuery({
    queryKey: ['reserve_avail', locId, date, guests, null],
    queryFn: () => fetchAvailability(locId, date, guests, null),
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

  // Предоплата (164). Решает СЕРВЕР: он присылает политику только тогда,
  // когда она включена И провайдер платежей настроен и здоров. Клиент не
  // имеет права вывести «нужна предоплата» из суммы в настройках — иначе
  // гость упёрся бы в экран оплаты, за которым ничего нет.
  // Правило приходит, только когда платёж реально можно принять (164).
  // Обязательна ли предоплата ЭТОЙ компании — решает порог по размеру.
  const prepayRule = info?.location.prepay ?? null
  const hasPrepay = prepayRule !== null && guests >= prepayRule.from_party
  const flow = useMemo(
    () => reserveFlow({ hasRules, hasPrepay }),
    [hasRules, hasPrepay]
  )

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
  // 4) Зона по умолчанию — первая живая. Доступность обязана относиться к
  //    конкретному залу: null сервер понимает как «любой стол» (072), и
  //    это другое обещание, а не «зал, который гость просто не трогал».
  //    Точка без зон остаётся с null — там «любой стол» и есть правда.
  if (zones.length > 0 && !zones.some((z) => z.id === zoneId)) {
    setZoneId(zones[0].id)
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
      // Переносим только имя: телефон сервер наружу не отдаёт, а почту
      // и пожелания второй визит подтверждает заново.
      setDetailsDraft({ ...EMPTY_DRAFT, firstName: seed?.name ?? '' })
      // Вторая бронь — второе согласие: правила подтверждают на визит,
      // а не один раз навсегда.
      setRulesAck([])
      setRulesStale(false)
      setClientUuid(crypto.randomUUID())
      setAttemptKey(crypto.randomUUID())
      setPayError(null)
      // Вторая бронь — вторая воронка: иначе она склеилась бы с первой и
      // выглядела бы как один гость, дошедший до конца дважды. Эпоха
      // заставляет новую сессию заново отправить вершину и доступность —
      // без этого её шаги попадали в отчёт без начала.
      resetFunnelSession()
      setFunnelEpoch((epoch) => epoch + 1)
    })
  }

  /**
   * Гость согласился с условиями предоплаты и идёт платить.
   *
   * Здесь бронь ещё НЕ оплачена: сервер лишь удерживает стол и называет
   * обязывающую сумму. Дальше гостя ведёт страница провайдера, а
   * «оплачено» появляется только из проверенного вебхука.
   *
   * Платёжного адаптера в проекте нет, поэтому сервер честно отвечает
   * prepay_unavailable — и мы показываем это, а не рисуем успех.
   */
  async function startPrepayment() {
    if (payBusy || !selectedAt) return
    setPayBusy(true)
    setPayError(null)
    try {
      const result = await beginReservationPrepayment({
        loc: locId,
        client_uuid: clientUuid,
        attempt_key: attemptKey,
        name: composeName(detailsDraft),
        first_name: detailsDraft.firstName.trim(),
        last_name: detailsDraft.lastName.trim(),
        email: detailsDraft.email.trim(),
        phone: detailsDraft.phone.replace(/\D/g, ''),
        party_size: guests,
        reserved_at: selectedAt.toISOString(),
        note: null,
        zone_id: zoneId,
        rules_ack: rulesAck,
      })
      trackReserveStep(locId, 'submitted', {
        party_size: guests,
        wanted_date: date,
        wanted_time: time,
        zone_id: zoneId,
        reservation_id: result.reservation_id,
      })
      // Адрес платёжной страницы формирует сервер. Его нет — значит
      // платить негде, и притворяться, что бронь готова, нельзя.
      if (result.redirect_url) {
        window.location.assign(result.redirect_url)
        return
      }
      setPayError(t(lang, 'rsvPrepayUnavailable'))
      setPayBusy(false)
    } catch (e) {
      const code = e instanceof PublicApiError ? e.code : 'unknown'
      setPayBusy(false)
      if (code === 'prepay_unavailable') {
        setPayError(t(lang, 'rsvErrPrepayUnavailable'))
        return
      }
      if (code === 'hold_expired') {
        setPayError(t(lang, 'rsvErrHoldExpired'))
        return
      }
      if (code === 'full_slot' || code === 'outside_hours' || code === 'invalid_time') {
        qc.invalidateQueries({ queryKey: ['reserve_avail', locId] })
        navigateWithTransition('back', () => {
          setConflict(true)
          setStep('times')
        })
        return
      }
      setPayError(reserveErrorText(lang, code))
    }
  }

  if (activeUuid) {
    return (
      <>
        <BrandSplash />
        <Shell
          isRtl={isRtl}
          info={info}
          lang={lang}
          // Карточка брони рисует своё фото и логотип: компактная шапка
          // сверху была бы вторым названием заведения подряд.
          hero
          routeKey="status"
        >
          <BookingScreen
            lang={lang}
            locId={locId}
            info={info}
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
        // «Назад» ходит по тому же списку шагов, что и «вперёд»:
        // симметрия обязана быть выведенной, а не написанной второй раз.
        onBack={
          step === 'slot'
            ? undefined
            : () => navigateWithTransition('back', () => setStep(stepBefore(flow, step)))
        }
      >
        {step === 'slot' && (
          <EntryScreen
            lang={lang}
            locId={locId}
            info={info}
            days={days}
            todayStr={todayStr}
            todayHasSlots={todayHasSlots}
            dayOpen={dayOpen}
            date={date}
            guests={guests}
            maxParty={maxParty}
            timeSlots={timeSlots}
            instant={instant}
            freeTimes={freeTimes}
            availabilityError={instant && availabilityError}
            schedule={schedule}
            nowMs={nowMs}
            tz={tz}
            onDate={pickDate}
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
            zones={zones}
            todayStr={todayStr}
            waitlistEnabled={info.location.waitlist === true}
            conflict={conflict}
            step={stepIndex(flow, 'times')}
            stepTotal={flow.length}
            zoneId={zoneId}
            onZone={setZoneId}
            onTime={setTime}
            onEditSlot={() => navigateWithTransition('back', () => setStep('slot'))}
            onWaitlist={() => setWaitlistOpen(true)}
            onNext={() => {
              trackReserveStep(locId, 'slot_selected', {
                party_size: guests,
                wanted_date: date,
                wanted_time: time,
                zone_id: zoneId,
              })
              navigateWithTransition('forward', () => {
                setConflict(false)
                setStep(stepAfter(flow, 'times') ?? 'details')
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
            step={stepIndex(flow, 'rules')}
            stepTotal={flow.length}
            onChecked={setRulesAck}
            onNext={() => navigateWithTransition('forward', () => {
              setRulesStale(false)
              setStep(stepAfter(flow, 'rules') ?? 'details')
            })}
          />
        )}
        {step === 'prepay' && prepayRule && (
          <PrepayScreen
            lang={lang}
            rule={prepayRule}
            guests={guests}
            date={date}
            time={time}
            todayStr={todayStr}
            zoneName={zoneName}
            step={stepIndex(flow, 'prepay')}
            stepTotal={flow.length}
            busy={payBusy}
            error={payError}
            onPay={startPrepayment}
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
            stepOf={stepIndex(flow, 'details')}
            stepTotal={flow.length}
            prepay={hasPrepay}
            onPrepay={() => navigateWithTransition('forward', () => setStep('prepay'))}
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
  /** Экран сам рисует шапку с фото (вход и карточка брони) — общей
   *  компактной шапки тогда нет */
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
      {/* На первом экране шапки нет: фото и лист — часть самого экрана,
          иначе лист не смог бы наехать на фото скруглённым верхом. */}
      {!hero && (
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
 * Лист «о заведении» — заменил постоянную чёрную плашку соцсетей (066).
 *
 * Часы, адрес, маршрут и соцсети нужны гостю один раз и по запросу, а не
 * всё время под формой: первый экран должен принадлежать брони. Сегодняшняя
 * строка выделена, остальная неделя идёт ниже — гость чаще спрашивает
 * «а сейчас открыто?», чем «а что в четверг?».
 *
 * Кнопки нет там, где нет ссылки: пустой кружок соцсети означал бы, что
 * заведение есть в Instagram, хотя владелец ссылку не заводил.
 */
function VenueSheet({ lang, loc, schedule, todayStr, onDirections, onClose }: {
  lang: Lang
  loc: NonNullable<ReserveInfo['location']>
  schedule: ReturnType<typeof normalizeSchedule>
  todayStr: string
  /** Маршрут открывает общий выбор приложения (067), а не жёсткий Google */
  onDirections: (() => void) | null
  onClose: () => void
}) {
  const links = loc.links
  const title = loc.business_name || loc.name
  const todayDow = dowOf(todayStr)
  const rows = useMemo(() => weeklyHoursRows(schedule), [schedule])

  return (
    <SheetOverlay label={t(lang, 'rsvVenueSheetTitle')} onClose={onClose}>
      <div className="public-reserve-venue-sheet">
        <div className="public-reserve-venue-head">
          <div>
            <h3>{title}</h3>
            {loc.address && <p>{loc.address}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(lang, 'rsvVenueClose')}
            className="public-reserve-venue-close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Только дни недели. Отдельной строки «сейчас закрыто» здесь нет:
            сегодняшний день и так выделен в списке, а над ним висела вторая
            жирная строка с тем же интервалом — две одинаковые строки подряд
            читались как две разные записи расписания.
            Состояние «открыто/закрыто сейчас» осталось на первом экране,
            в полосе часов: там оно и нужно, до открытия листа. */}
        <div className="public-reserve-venue-hours">
          {rows.map((row) => (
            <div key={row.days[0]} data-today={row.days.includes(todayDow ?? -1) || undefined}>
              <span>{dayRangeLabel(row.days, lang)}</span>
              <span>{formatWindows(row.windows) || t(lang, 'rsvDayClosed')}</span>
            </div>
          ))}
        </div>

        {(loc.address || onDirections) && (
          <div className="public-reserve-venue-address">
            {loc.address && <span>{loc.address}</span>}
            {onDirections && (
              <button
                type="button"
                onClick={() => { onClose(); onDirections() }}
                className="public-reserve-venue-route"
              >
                {t(lang, 'rsvVenueDirections')}
              </button>
            )}
          </div>
        )}

        {(links?.instagram || links?.facebook || links?.google_review) && (
          <div className="public-reserve-venue-socials">
            {links?.instagram && (
              <a
                href={links.instagram}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t(lang, 'rsvSocialInstagram')}
              >
                <InstagramIcon />
              </a>
            )}
            {links?.facebook && (
              <a
                href={links.facebook}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t(lang, 'rsvSocialFacebook')}
              >
                <FacebookIcon />
              </a>
            )}
            {links?.google_review && (
              <a
                href={links.google_review}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t(lang, 'rsvSocialGoogle')}
              >
                <GoogleGIcon />
              </a>
            )}
          </div>
        )}
      </div>
    </SheetOverlay>
  )
}

/**
 * Общая обвязка нижнего листа: затемнение, Escape, блокировка прокрутки
 * фона, ловушка фокуса и возврат фокуса открывшему элементу.
 *
 * Раньше каждый лист повторял половину этого сам и ни один не удерживал
 * фокус — с клавиатуры и со скринридером фокус уходил за спину открытого
 * листа, в форму под ним.
 */
function SheetOverlay({ label, onClose, children }: {
  label: string
  onClose: () => void
  children: React.ReactNode
}) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<Element | null>(null)

  useEffect(() => {
    openerRef.current = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = sheetRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    // Фокус на САМ лист, а не на первую кнопку внутри: Tab дальше идёт
    // по листу, но обводка фокуса не загорается на «закрыть» — гость,
    // открывший часы пальцем, видел бы обведённый крестик без причины.
    window.setTimeout(() => sheetRef.current?.focus({ preventScroll: true }), 0)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
      // Фокус возвращается кнопке, которая лист открыла
      const opener = openerRef.current
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [onClose])

  return (
    <div
      className="public-reserve-sheet-overlay fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div
        ref={sheetRef}
        tabIndex={-1}
        className="public-reserve-sheet w-full max-w-lg rounded-t-3xl bg-white px-4 pt-3 shadow-xl text-start"
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-gray-200" aria-hidden="true" />
        {children}
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
 * Первый экран (утверждённый референс): короткое фото заведения, белый лист
 * со скруглённым верхом поверх него, круглый логотип на шве, название и
 * адрес вплотную, затем ДАТА и ниже КОМПАНИЯ — обе полосой во всю ширину.
 *
 * Времени здесь нет намеренно: доступность зависит от зоны зала, а зону
 * гость выбирает на следующем экране. Показать время до зоны — значит
 * показать время, посчитанное не для того зала.
 */
function EntryScreen({
  lang, locId, info, days, todayStr, todayHasSlots, dayOpen, date, guests, maxParty,
  timeSlots, instant, freeTimes, availabilityError, schedule, nowMs, tz,
  onDate, onGuests, onNext, onWaitlist,
}: {
  lang: Lang
  locId: string
  info: ReserveInfo
  days: string[]
  todayStr: string
  todayHasSlots: boolean
  /** Открыт ли день по расписанию (117) — закрытые дни в селекте недоступны */
  dayOpen: (dateStr: string) => boolean
  date: string
  guests: number
  maxParty: number
  timeSlots: string[]
  /** instant-режим (063): у даты есть живая занятость */
  instant: boolean
  /** Свободные времена (Set) или null, если доступность не применяется */
  freeTimes: Set<string> | null
  availabilityError: boolean
  schedule: ReturnType<typeof normalizeSchedule>
  nowMs: number
  tz: string
  onDate: (v: string) => void
  onGuests: (v: number) => void
  onNext: () => void
  /** День занят целиком — гость может встать в лист ожидания (122) */
  onWaitlist: () => void
}) {
  // В instant-режиме день целиком занят, если сетка загружена и пуста на free
  const dayFull = instant && freeTimes !== null && freeTimes.size === 0 && timeSlots.length > 0
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
  const [venueOpen, setVenueOpen] = useState(false)
  const title = loc.business_name || loc.name
  // Сегодняшние часы в полосе: тот же разбор, что и у сетки слотов (117)
  const nowMinutes = useMemo(() => {
    const [h, m] = localTimeOf(nowMs, tz).split(':')
    return Number(h) * 60 + Number(m)
  }, [nowMs, tz])
  const openNow = useMemo(
    () => isOpenAt(schedule, todayStr, nowMinutes),
    [schedule, todayStr, nowMinutes]
  )
  const todayHours = useMemo(
    () => formatWindows(dayWindows(schedule, todayStr)),
    [schedule, todayStr]
  )

  return (
    <div className="public-reserve-entry">
      <div className="public-reserve-entry-hero">
        {loc.header_url && <img src={loc.header_url} alt="" />}
        {/* Меню того же заведения: гость пришёл бронировать, но почти
            всегда хочет сначала посмотреть, что здесь готовят. Слаг/UUID
            берём из адреса — тот же ключ, по которому открыта бронь. */}
        <a href={`/order/${locId}`} className="public-reserve-menu-pill">
          {t(lang, 'rsvMenuLink')}
        </a>
      </div>

      <div className={`public-reserve-entry-sheet${loc.logo_url ? ' has-logo' : ''}`}>
        {loc.logo_url && (
          <img src={loc.logo_url} alt="" className="public-reserve-entry-logo" />
        )}
        <h1
          className="font-display public-reserve-entry-title public-reserve-route-focus"
          tabIndex={-1}
        >
          {title}
        </h1>
        {loc.address && (
          <p className="public-reserve-entry-address">{loc.address}</p>
        )}

        {!todayHasSlots && (
          <div className="w-full mt-4 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3 text-center">
            {t(lang, 'rsvNoSlotsToday')}
          </div>
        )}

        <div className="public-reserve-quick-grid">
          {/* Дата — всегда над компанией: сначала «когда», потом «сколько нас».
              Подписи «дата» нет: строка «вс 16/8» и так читается датой, а
              освободившееся место отдано самой дате. Шеврон уехал к
              дальнему краю — он относится ко всей строке, а не к цифрам. */}
          <div className="public-reserve-quick-box">
            <span className="public-reserve-quick-value">
              {dayOptionLabel(date, todayStr, lang)}
            </span>
            <span className="public-reserve-quick-chevron rtl:rotate-180" aria-hidden="true">
              <ChevronStart />
            </span>
            {/* Родной select: единственный контрол, который умеет и открыть
                привычный колесо-пикер телефона, и показать закрытый день
                недоступным. У input[type=date] выключить можно только
                диапазон, а выходные заведения лежат внутри него. */}
            <select
              className="public-reserve-date-input"
              value={date}
              onChange={(e) => onDate(e.target.value)}
              aria-label={t(lang, 'rsvDate')}
            >
              {days.map((d) => {
                const open = dayOpen(d)
                return (
                  <option key={d} value={d} disabled={!open}>
                    {dayOptionLabel(d, todayStr, lang)}
                    {open ? '' : ` · ${t(lang, 'rsvDayClosed')}`}
                  </option>
                )
              })}
            </select>
          </div>

          <div className="public-reserve-quick-box">
            <span>{t(lang, 'rsvEntryPartyLabel')}</span>
            {/* Степпер, а не select: размер компании меняют на ±1, и два
                тапа по «+» быстрее, чем открыть список и найти строку.
                Края явно выключены — предел заведения виден, а не угадан. */}
            <div className="public-reserve-stepper">
              <button
                type="button"
                onClick={() => onGuests(Math.max(1, guests - 1))}
                disabled={guests <= 1}
                aria-label={t(lang, 'rsvPartyMinus')}
              >
                −
              </button>
              <strong className="tabular-nums" aria-live="polite">{guests}</strong>
              <button
                type="button"
                onClick={() => onGuests(Math.min(maxParty, guests + 1))}
                disabled={guests >= maxParty}
                aria-label={t(lang, 'rsvPartyPlus')}
              >
                +
              </button>
            </div>
          </div>
        </div>

        {/* Часы и маршрут — компактная полоса, а не постоянный чёрный блок */}
        <div className="public-reserve-venue-strip">
          <button
            type="button"
            onClick={() => setVenueOpen(true)}
            className="public-reserve-hours-button"
            aria-label={t(lang, 'rsvVenueHoursOpen')}
          >
            <span className="public-reserve-hours-copy">
              <span>
                <i data-closed={!openNow || undefined} aria-hidden />
                {t(lang, openNow ? 'rsvVenueOpenNow' : 'rsvVenueClosedNow')}
              </span>
              <strong>{todayHours || t(lang, 'rsvDayClosed')}</strong>
            </span>
            <span className="rtl:rotate-180 text-gray-400"><ChevronStart /></span>
          </button>
          {mapsUrl && (
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              className="public-reserve-route-button"
            >
              <RouteIcon />
              <span>{t(lang, 'rsvNavigateBtn')}</span>
            </button>
          )}
        </div>

        {dayFull && (
          <div className="w-full mt-3 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3 text-center">
            {t(lang, 'rsvNoFreeSlots')}
          </div>
        )}
        {dayFull && loc.waitlist && (
          <button
            type="button"
            onClick={onWaitlist}
            className="w-full h-12 mt-3 rounded-2xl border border-gray-300 text-sm font-bold text-gray-900 active:scale-[0.98] transition-all"
          >
            {t(lang, 'rsvJoinWaitlist')}
          </button>
        )}
        {availabilityError && (
          <div className="w-full mt-3 rounded-2xl bg-red-50 text-red-700 text-sm font-semibold px-4 py-3 text-center" role="alert">
            {t(lang, 'rsvErrAvailability')}
          </div>
        )}

        <div className="public-reserve-bottom">
          <button
            type="button"
            onClick={onNext}
            disabled={timeSlots.length === 0 || dayFull}
            className="public-reserve-cta"
          >
            {t(lang, 'rsvShowTimes')}
          </button>
        </div>
      </div>

      {venueOpen && (
        <VenueSheet
          lang={lang}
          loc={loc}
          schedule={schedule}
          todayStr={todayStr}
          onDirections={mapsUrl ? () => setNavOpen(true) : null}
          onClose={() => setVenueOpen(false)}
        />
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
  return (
    <SheetOverlay label={t(lang, 'rsvNavSheetTitle')} onClose={onClose}>
      <>
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
      </>
    </SheetOverlay>
  )
}

/**
 * Второй экран: СНАЧАЛА зона зала, ПОТОМ время в этой зоне.
 *
 * Порядок не косметический. Свободное время считается для конкретного
 * набора столов, поэтому «19:00 свободно» без зоны — утверждение ни о
 * чём: в зале свободно, на террасе занято. Прежний экран показывал
 * секцию на каждую зону сразу и тем самым просил гостя сравнивать
 * четыре ряда времён вместо одного вопроса «где вам удобнее сесть».
 *
 * Смена зоны обнуляет выбранное время, если в новой зоне его нет:
 * запрос доступности ключуется зоной, поэтому ответ старой зоны в новую
 * не попадает физически, а выбор гостя проверяется отдельно.
 *
 * Итоговое решение всё равно за сервером: здесь только предложение, а
 * конфликт на submit возвращает гостя сюда со свежей сеткой.
 */
function TimesScreen({
  lang, locId, date, guests, timeSlots, instant, zones, todayStr, waitlistEnabled,
  conflict, step, stepTotal, zoneId, time, onZone, onTime, onNext, onEditSlot, onWaitlist,
}: {
  lang: Lang
  locId: string
  date: string
  guests: number
  /** Сетка расписания на дату (117) — метки времени без учёта занятости */
  timeSlots: string[]
  /** instant-режим (063): у слотов есть живая занятость */
  instant: boolean
  /** Зоны зала (072) с активными столами */
  zones: { id: string; name: string }[]
  todayStr: string
  /** Лист ожидания включён владельцем (122) — обещание перезвонить */
  waitlistEnabled: boolean
  /** Гость вернулся сюда из-за занятого слота (118) */
  conflict: boolean
  /** Номер этого шага и всего шагов в потоке — считает reserveFlow */
  step: number
  stepTotal: number
  zoneId: string | null
  time: string
  onZone: (zoneId: string | null) => void
  onTime: (time: string) => void
  onNext: () => void
  /** Вернуться к дате и числу гостей */
  onEditSlot: () => void
  onWaitlist: () => void
}) {
  // Время, которое гость разглядывает в «занято» — экран объяснения
  const [blocked, setBlocked] = useState<string | null>(null)

  // Доступность ИМЕННО выбранной зоны. Зона входит в ключ, поэтому ответ
  // прошлой зоны не может быть показан как ответ новой — устаревший
  // запрос отсекается самим кэшем, а не гонкой промисов.
  const {
    data: avail,
    isPending,
    isError,
  } = useQuery({
    queryKey: ['reserve_avail', locId, date, guests, zoneId],
    queryFn: () => fetchAvailability(locId, date, guests, zoneId),
    enabled: instant,
    staleTime: 20_000,
  })

  const freeTimes = useMemo(() => {
    if (!instant || !avail) return null // null = занятость не применяется
    return new Set(avail.slots.filter((s) => s.free).map((s) => s.time))
  }, [instant, avail])

  const loading = instant && isPending
  const free = useMemo(
    () => timeSlots.filter((s) => freeTimes === null || freeTimes.has(s)),
    [timeSlots, freeTimes]
  )
  // Зона занята целиком: сетка расписания есть, а свободного в ней нет
  const zoneFull = !loading && !isError && timeSlots.length > 0 && free.length === 0

  // Выбор гостя действителен, только пока он свободен в ТЕКУЩЕЙ зоне.
  // Производная величина, а не состояние: иначе смена зоны оставляла бы
  // подсвеченным время, которого в новой зоне нет.
  const selected = time && free.includes(time) ? time : ''

  function pickZone(next: string | null) {
    if (next === zoneId) return
    onZone(next)
    setBlocked(null)
    // Время не переносим вслепую: в новой зоне оно может быть занято.
    // Сверка идёт по её собственной доступности, когда та приедет.
    if (time) onTime(time)
  }

  const zoneName = zoneId ? zones.find((z) => z.id === zoneId)?.name ?? null : null

  if (blocked) {
    return (
      <UnavailableTime
        lang={lang}
        blocked={blocked}
        free={free}
        zoneName={zoneName}
        waitlistEnabled={waitlistEnabled}
        onPick={(next) => { setBlocked(null); onTime(next); onNext() }}
        onBack={() => setBlocked(null)}
        onWaitlist={onWaitlist}
        onAnotherDay={onEditSlot}
      />
    )
  }

  return (
    <div className="public-reserve-step-page">
      <ReserveProgress lang={lang} step={step} total={stepTotal} />
      <h2 className="public-reserve-route-focus public-reserve-step-title" tabIndex={-1}>
        {t(lang, 'rsvVisitTitle')}
      </h2>
      <p className="public-reserve-step-hint">{t(lang, 'rsvVisitHint')}</p>

      {conflict && (
        <div
          className="w-full mt-4 rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3"
          role="alert"
        >
          {t(lang, 'rsvConflictHint')}
        </div>
      )}

      <div className="public-reserve-summary">
        <div>
          <strong>{dayOptionLabel(date, todayStr, lang)}</strong>
          <small>{guests} {t(lang, 'resGuestsShort')}</small>
        </div>
        <button type="button" onClick={onEditSlot}>{t(lang, 'rsvChangeSelection')}</button>
      </div>

      {/* Зона — выше времени. Одна зона тоже показывается: гость должен
          понимать, куда его сажают, даже когда выбора нет. */}
      {zones.length > 0 && (
        <>
          <div className="public-reserve-field-label">{t(lang, 'rsvZoneQuestion')}</div>
          <div className="public-reserve-zones" role="group" aria-label={t(lang, 'rsvZoneQuestion')}>
            {zones.map((z) => (
              <button
                key={z.id}
                type="button"
                className="public-reserve-zone"
                aria-pressed={z.id === zoneId}
                onClick={() => pickZone(z.id)}
              >
                <span className="public-reserve-zone-icon" aria-hidden="true"><ChairIcon /></span>
                <b>{z.name}</b>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="public-reserve-field-label">
        {t(lang, 'rsvTimesForZone')}
        {zoneName && <> · {zoneName}</>}
      </div>

      {isError ? (
        <p className="text-sm font-semibold text-red-600" role="alert">
          {t(lang, 'rsvErrAvailability')}
        </p>
      ) : loading ? (
        // Скелет ровно на месте времён: зоны и сводка не мигают
        <>
          <div className="public-reserve-times" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className="public-reserve-time-skeleton" />
            ))}
          </div>
          <p className="sr-only" role="status">{t(lang, 'rsvLoadingTimes')}</p>
        </>
      ) : zoneFull ? (
        <ZoneFullNote
          lang={lang}
          waitlistEnabled={waitlistEnabled}
          onWaitlist={onWaitlist}
          onAnotherDay={onEditSlot}
        />
      ) : (
        <div className="public-reserve-times">
          {timeSlots.map((s) => {
            const taken = freeTimes !== null && !freeTimes.has(s)
            return (
              <button
                key={s}
                type="button"
                className="public-reserve-time tabular-nums"
                aria-pressed={s === selected}
                aria-disabled={taken || undefined}
                aria-label={`${s}${zoneName ? ` · ${zoneName}` : ''}${
                  taken ? ` · ${t(lang, 'rsvSlotFull')}` : ''
                }`}
                // Занятое время не мёртвая кнопка: тап объясняет, что
                // произошло, и показывает ближайшее свободное.
                onClick={() => (taken ? setBlocked(s) : onTime(s))}
              >
                {s}
                {taken && <small>{t(lang, 'rsvSlotFull')}</small>}
              </button>
            )
          })}
        </div>
      )}

      <div className="public-reserve-bottom">
        <button
          type="button"
          onClick={onNext}
          disabled={!selected}
          className="public-reserve-cta"
        >
          {selected ? t(lang, 'rsvContinue') : t(lang, 'rsvPickTimeFirst')}
        </button>
      </div>
    </div>
  )
}

/** Разница между метками времени в минутах — для подписи «на 30 мин раньше» */
function minutesBetween(from: string, to: string): number {
  const a = hmToMin(from)
  const b = hmToMin(to)
  if (a === null || b === null) return 0
  return Math.abs(b - a)
}

/**
 * Выбранное время занято. Экран объясняет это словами и предлагает
 * ближайшее свободное В ТОЙ ЖЕ ЗОНЕ — молча переносить гостя в другой
 * зал нельзя, он выбирал зал осознанно.
 */
function UnavailableTime({
  lang, blocked, free, zoneName, waitlistEnabled, onPick, onBack, onWaitlist, onAnotherDay,
}: {
  lang: Lang
  blocked: string
  free: string[]
  zoneName: string | null
  waitlistEnabled: boolean
  onPick: (time: string) => void
  onBack: () => void
  onWaitlist: () => void
  onAnotherDay: () => void
}) {
  const target = hmToMin(blocked) ?? 0
  const earlier = [...free].filter((s) => (hmToMin(s) ?? 0) < target).pop() ?? null
  const later = free.find((s) => (hmToMin(s) ?? 0) > target) ?? null

  return (
    <div className="public-reserve-step-page">
      <div className="public-reserve-empty-head">
        <div className="public-reserve-empty-icon" aria-hidden="true"><ClockIcon /></div>
        <h2 className="public-reserve-route-focus public-reserve-step-title" tabIndex={-1}>
          <span className="tabular-nums">{blocked}</span> · {t(lang, 'rsvUnavailableTitle')}
        </h2>
        <p className="public-reserve-step-hint">
          {(earlier || later) ? t(lang, 'rsvUnavailableHint') : t(lang, 'rsvZoneFull')}
          {zoneName && <> · {zoneName}</>}
        </p>
      </div>

      {(earlier || later) && (
        <div className="public-reserve-alternatives">
          {earlier && (
            <button type="button" className="public-reserve-alternative" onClick={() => onPick(earlier)}>
              <strong className="tabular-nums">{earlier}</strong>
              <small>
                {minutesBetween(earlier, blocked)} {t(lang, 'rsvMinShort')} {t(lang, 'rsvAltEarlier')}
              </small>
            </button>
          )}
          {later && (
            <button type="button" className="public-reserve-alternative" onClick={() => onPick(later)}>
              <strong className="tabular-nums">{later}</strong>
              <small>
                {minutesBetween(blocked, later)} {t(lang, 'rsvMinShort')} {t(lang, 'rsvAltLater')}
              </small>
            </button>
          )}
        </div>
      )}

      {/* Лист ожидания — только если владелец его включил: заведение,
          которое не собирается перезванивать, обещаний не копит (122). */}
      {waitlistEnabled && (
        <div className="public-reserve-waitlist-card">
          <strong>{t(lang, 'rsvJoinWaitlist')}</strong>
          <p>{t(lang, 'rsvWaitlistHint')}</p>
          <button type="button" onClick={onWaitlist}>{t(lang, 'rsvWaitlistSubmit')}</button>
        </div>
      )}

      <button type="button" className="public-reserve-link-action" onClick={onAnotherDay}>
        {t(lang, 'rsvPickAnotherDay')}
      </button>

      <div className="public-reserve-bottom">
        <button type="button" onClick={onBack} className="public-reserve-cta">
          {t(lang, 'rsvBackToZones')}
        </button>
      </div>
    </div>
  )
}

/** В выбранной зоне на этот день свободного времени нет вовсе */
function ZoneFullNote({ lang, waitlistEnabled, onWaitlist, onAnotherDay }: {
  lang: Lang
  waitlistEnabled: boolean
  onWaitlist: () => void
  onAnotherDay: () => void
}) {
  return (
    <div role="status">
      <div className="w-full rounded-2xl bg-amber-50 text-amber-800 text-sm font-semibold px-4 py-3">
        {t(lang, 'rsvZoneFull')}
      </div>
      {waitlistEnabled && (
        <div className="public-reserve-waitlist-card">
          <strong>{t(lang, 'rsvJoinWaitlist')}</strong>
          <p>{t(lang, 'rsvWaitlistHint')}</p>
          <button type="button" onClick={onWaitlist}>{t(lang, 'rsvWaitlistSubmit')}</button>
        </div>
      )}
      <button type="button" className="public-reserve-link-action" onClick={onAnotherDay}>
        {t(lang, 'rsvPickAnotherDay')}
      </button>
    </div>
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
  lang, rules, date, time, guests, todayStr, zoneName, checked, stale, step, stepTotal,
  onChecked, onNext,
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
  step: number
  stepTotal: number
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
    <div className="public-reserve-step-page">
      <ReserveProgress lang={lang} step={step} total={stepTotal} />
      <div className="public-reserve-notice-head">
        <span className="public-reserve-notice-icon" aria-hidden="true"><InfoIcon /></span>
        <h2 className="public-reserve-route-focus public-reserve-step-title" tabIndex={-1}>
          {t(lang, 'rsvRulesTitle')}
        </h2>
      </div>
      <p className="public-reserve-step-hint">{t(lang, 'rsvRulesHint')}</p>

      <div className="public-reserve-summary">
        <div>
          <strong>
            {dayOptionLabel(date, todayStr, lang)} · <span className="tabular-nums">{time}</span>
          </strong>
          <small>
            {guests} {t(lang, 'resGuestsShort')}
            {zoneName && <> · {zoneName}</>}
          </small>
        </div>
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

      <div className="public-reserve-bottom">
        {/* Кнопка выключена, пока не отмечено обязательное, — и рядом
            написано, чего именно не хватает. Молча неактивная кнопка это
            та самая причина, по которой звонят в заведение. */}
        {missing.length > 0 && (
          <p className="public-reserve-cta-note" id="reserve-rules-need" role="status">
            {t(lang, 'rsvRulesNeedAck')}
          </p>
        )}
        <button
          type="button"
          onClick={next}
          disabled={missing.length > 0}
          aria-describedby={missing.length > 0 ? 'reserve-rules-need' : undefined}
          className="public-reserve-cta"
        >
          {t(lang, 'rsvRulesContinue')}
        </button>
      </div>
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
  reservedAt, draft, onDraft, clientUuid, rulesAck, stepOf, stepTotal, prepay,
  onSubmitted, onConflict, onRulesStale, onPrepay,
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
  draft: DetailsDraft
  onDraft: (draft: DetailsDraft) => void
  clientUuid: string
  /** Отмеченные правила (145); проверяет их сервер, не эта форма */
  rulesAck: string[]
  /** Номер этого шага и всего шагов в потоке */
  stepOf: number
  stepTotal: number
  /** Требуется предоплата (164) — тогда дальше экран условий, а не бронь */
  prepay: boolean
  onSubmitted: (clientUuid: string) => void
  /** Правила точки изменились — согласие устарело и собирается заново */
  onRulesStale: () => void
  /** Слот заняли, пока гость заполнял форму: возвращаем его к выбору
   *  времени со свежей доступностью, не стирая контакты. */
  onConflict: () => void
  /** Перейти к экрану предоплаты вместо немедленной отправки */
  onPrepay: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showValidation, setShowValidation] = useState(false)
  const firstRef = useRef<HTMLInputElement>(null)
  const lastRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)

  const errors = draftErrors(draft)
  const valid = isDraftValid(draft)

  const extraLabels: Record<string, string> = {
    birthday: t(lang, 'rsvExtraBirthday'),
    high_chair: t(lang, 'rsvExtraHighChair'),
    accessibility: t(lang, 'rsvExtraAccessibility'),
  }

  /**
   * Первое касание формы (124). Отличает «не нашёл подходящего времени»
   * от «начал оформлять и передумал» — а это разные проблемы заведения.
   * Повторные нажатия отсекаются дедупликацией шага.
   */
  function editDraft(next: DetailsDraft) {
    trackReserveStep(locId, 'form_started', { party_size: guests, wanted_date: date })
    onDraft(next)
  }

  function focusFirstError() {
    window.setTimeout(() => {
      if (errors.firstName) firstRef.current?.focus()
      else if (errors.lastName) lastRef.current?.focus()
      else if (errors.phone) phoneRef.current?.focus()
      else if (errors.email) emailRef.current?.focus()
    }, 0)
  }

  async function submit() {
    if (busy) return
    setShowValidation(true)
    if (!valid) {
      focusFirstError()
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
    // Предоплата (164): бронь НЕ создаётся до подтверждённой оплаты.
    // Отсюда — только переход к условиям; заявку отправит уже тот экран.
    if (prepay) {
      onPrepay()
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
        // Собранное имя шлём и мы: сервер, выложенный до 163, других
        // полей не знает, а по `customer_name` живут касса и выгрузки.
        name: composeName(draft),
        first_name: draft.firstName.trim(),
        last_name: draft.lastName.trim(),
        email: draft.email.trim(),
        phone: draft.phone.replace(/\D/g, ''),
        party_size: guests,
        reserved_at: at.toISOString(),
        note: composeNote(draft, extraLabels),
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
    <div className="public-reserve-step-page">
      <ReserveProgress lang={lang} step={stepOf} total={stepTotal} />
      <h2 className="public-reserve-route-focus public-reserve-step-title" tabIndex={-1}>
        {t(lang, 'rsvDetailsHeading')}
      </h2>
      <p className="public-reserve-step-hint">{t(lang, 'rsvDetailsSubhint')}</p>

      <div className="public-reserve-summary">
        <div>
          <strong>
            {dayOptionLabel(date, todayStr, lang)} · <span className="tabular-nums">{time}</span>
          </strong>
          <small>
            {guests} {t(lang, 'resGuestsShort')}
            {zoneName && <> · {zoneName}</>}
          </small>
        </div>
      </div>

      <div className="public-reserve-details-fields">
        {/* Имя и фамилия делят строку, а на узком экране встают друг под
            друга: сжимать их до нечитаемой ширины хуже, чем перенести. */}
        <div className="public-reserve-field-row">
          <label>
            <span id="reserve-first-label">{t(lang, 'rsvFirstName')}</span>
            <input
              ref={firstRef}
            aria-labelledby="reserve-first-label"
              autoComplete="given-name"
              value={draft.firstName}
              aria-invalid={showValidation && errors.firstName}
              aria-describedby={showValidation && errors.firstName ? 'reserve-first-error' : undefined}
              onChange={(e) => editDraft({ ...draft, firstName: e.target.value })}
            />
            {showValidation && errors.firstName && (
              <small id="reserve-first-error">{t(lang, 'rsvErrFirstName')}</small>
            )}
          </label>
          <label>
            <span id="reserve-last-label">{t(lang, 'rsvLastName')}</span>
            <input
              ref={lastRef}
            aria-labelledby="reserve-last-label"
              autoComplete="family-name"
              value={draft.lastName}
              aria-invalid={showValidation && errors.lastName}
              aria-describedby={showValidation && errors.lastName ? 'reserve-last-error' : undefined}
              onChange={(e) => editDraft({ ...draft, lastName: e.target.value })}
            />
            {showValidation && errors.lastName && (
              <small id="reserve-last-error">{t(lang, 'rsvErrLastName')}</small>
            )}
          </label>
        </div>

        <label>
          <span id="reserve-phone-label">{t(lang, 'rsvPhone')}</span>
          <input
            ref={phoneRef}
            aria-labelledby="reserve-phone-label"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            value={draft.phone}
            aria-invalid={showValidation && errors.phone}
            aria-describedby={showValidation && errors.phone ? 'reserve-phone-error' : undefined}
            onChange={(e) => editDraft({ ...draft, phone: e.target.value })}
          />
          {showValidation && errors.phone && (
            <small id="reserve-phone-error">{t(lang, 'rsvErrPhone')}</small>
          )}
        </label>

        <label>
          <span id="reserve-email-label">{t(lang, 'rsvEmail')}</span>
          <input
            ref={emailRef}
            aria-labelledby="reserve-email-label"
            type="email"
            inputMode="email"
            autoComplete="email"
            dir="ltr"
            placeholder="name@example.com"
            value={draft.email}
            aria-invalid={showValidation && errors.email}
            aria-describedby={
              showValidation && errors.email ? 'reserve-email-error' : 'reserve-email-hint'
            }
            onChange={(e) => editDraft({ ...draft, email: e.target.value })}
          />
          {showValidation && errors.email
            ? <small id="reserve-email-error">{t(lang, 'rsvErrEmail')}</small>
            : (
              // Обычная строка под полем, а не <em>: тот позиционируется
              // абсолютно (счётчик символов в углу textarea) и лёг бы
              // поверх плейсхолдера самого поля.
              <small id="reserve-email-hint" data-hint="true">
                {t(lang, 'rsvEmailHint')}
              </small>
            )}
        </label>
      </div>

      {/* Пожелания уезжают в ту же заметку, которую читает хостес: это
          не декоративные чипы, у них есть адресат. */}
      <div className="public-reserve-field-label">
        {t(lang, 'rsvExtras')} <span className="font-normal">({t(lang, 'rsvExtrasOptional')})</span>
      </div>
      <div className="public-reserve-chips">
        {EXTRA_KEYS.map((key) => {
          const on = draft.extras.includes(key)
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => editDraft({
                ...draft,
                extras: on ? draft.extras.filter((x) => x !== key) : [...draft.extras, key],
              })}
            >
              {extraLabels[key]}
            </button>
          )
        })}
      </div>

      <div className="public-reserve-details-fields">
        <label>
          <span id="reserve-note-label">{t(lang, 'rsvNote')}</span>
          <textarea
            aria-labelledby="reserve-note-label"
            rows={2}
            maxLength={200}
            value={draft.note}
            onChange={(e) => editDraft({ ...draft, note: e.target.value })}
          />
          <em>{draft.note.length}/200</em>
        </label>
      </div>

      {error && (
        <div className="mt-4 rounded-2xl bg-red-50 text-red-700 text-sm font-semibold px-4 py-3" role="alert">
          {error}
        </div>
      )}

      <div className="public-reserve-bottom">
        {/* Подпись говорит, что произойдёт дальше: «подтвердить» там, где
            бронь появится сразу, и «к оплате» там, где сначала платят. */}
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="public-reserve-cta"
        >
          {busy
            ? t(lang, 'pubSubmitting')
            : prepay
              ? t(lang, 'rsvToPrepay')
              : instant
                ? t(lang, 'rsvConfirmBooking')
                : t(lang, 'rsvSend')}
        </button>
      </div>
    </div>
  )
}



/** Минорные единицы → «₪100» в валюте точки */
function formatMinor(amountMinor: number, currency: string, lang: Lang): string {
  try {
    return new Intl.NumberFormat(lang === 'he' ? 'he-IL' : 'ru-RU', {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(amountMinor / 100)
  } catch {
    // Неизвестная валюта не повод показать пустое место вместо суммы
    return `${Math.round(amountMinor / 100)} ${currency}`
  }
}

/**
 * Экран условий предоплаты (164) — ПОСЛЕ контактов и только когда сервер
 * прислал правило. Появиться иначе он не может: правила нет, пока у точки
 * нет здорового платёжного провайдера.
 *
 * Суммы здесь показанные, а не обязывающие: обязывающую называет сервер,
 * когда бронь встаёт в удержание, и он же сверяет её с подтверждением
 * провайдера. Галочка гостя доказательством оплаты не является, возврат
 * с чужой страницы — тем более.
 *
 * Иконки валюты у заголовка нет намеренно: сумма и так набрана крупно,
 * а знак шекеля рядом с «Предоплата» читается как ценник, а не как шаг.
 */
function PrepayScreen({
  lang, rule, guests, date, time, todayStr, zoneName, step, stepTotal, busy,
  error, onPay,
}: {
  lang: Lang
  rule: ReservePrepayRule
  guests: number
  date: string
  time: string
  todayStr: string
  zoneName: string | null
  step: number
  stepTotal: number
  busy: boolean
  error: string | null
  onPay: () => void
}) {
  const [agreed, setAgreed] = useState(false)
  const total = rule.amount_per_guest * guests

  return (
    <div className="public-reserve-step-page">
      <ReserveProgress lang={lang} step={step} total={stepTotal} />
      <h2 className="public-reserve-route-focus public-reserve-step-title" tabIndex={-1}>
        {t(lang, 'rsvPrepayTitle')}
      </h2>
      <p className="public-reserve-step-hint">{t(lang, 'rsvPrepayHint')}</p>

      <div className="public-reserve-summary">
        <div>
          <strong>
            {dayOptionLabel(date, todayStr, lang)} · <span className="tabular-nums">{time}</span>
          </strong>
          <small>
            {guests} {t(lang, 'resGuestsShort')}
            {zoneName && <> · {zoneName}</>}
          </small>
        </div>
      </div>

      {/* Списание сейчас — главное, что обязан понять гость до оплаты */}
      <p className="public-reserve-prepay-alert">{t(lang, 'rsvPrepayAlert')}</p>

      <div className="public-reserve-prepay-amount">
        <div>
          <span>{t(lang, 'rsvPrepayPerGuest')}</span>
          <strong>{formatMinor(rule.amount_per_guest, rule.currency, lang)}</strong>
        </div>
        <div>
          <span>
            {guests} {t(lang, 'rsvPrepayForParty')}{' '}
            {formatMinor(rule.amount_per_guest, rule.currency, lang)}
          </span>
          <strong>{formatMinor(total, rule.currency, lang)}</strong>
        </div>
        <div data-total="true">
          <span>{t(lang, 'rsvPrepayNow')}</span>
          <strong>{formatMinor(total, rule.currency, lang)}</strong>
        </div>
      </div>

      <ul className="public-reserve-rules">
        <li data-level="normal">
          <span aria-hidden="true" />
          <p>
            {t(lang, 'rsvPrepayRefund')} {rule.refund_cutoff_hours}{' '}
            {t(lang, 'rsvPrepayRefundTail')}
          </p>
        </li>
        {/* Потеря денег — единственный пункт, который красный */}
        <li data-level="important">
          <span aria-hidden="true" />
          <p>{t(lang, 'rsvPrepayForfeit')}</p>
        </li>
      </ul>

      <p className="public-reserve-secure-note">
        <span aria-hidden="true"><LockIcon /></span>
        {t(lang, 'rsvPrepaySecure')}
      </p>

      <div className="public-reserve-rules-acks">
        <label>
          <input
            type="checkbox"
            checked={agreed}
            onChange={() => setAgreed((v) => !v)}
          />
          <span>{t(lang, 'rsvPrepayConsent')}</span>
        </label>
      </div>

      {error && (
        <div className="mt-4 rounded-2xl bg-red-50 text-red-700 text-sm font-semibold px-4 py-3" role="alert">
          {error}
        </div>
      )}

      <div className="public-reserve-bottom">
        {!agreed && (
          <p className="public-reserve-cta-note" id="reserve-prepay-need" role="status">
            {t(lang, 'rsvPrepayConsentNeed')}
          </p>
        )}
        <button
          type="button"
          disabled={!agreed || busy}
          aria-describedby={!agreed ? 'reserve-prepay-need' : undefined}
          onClick={onPay}
          className="public-reserve-cta"
        >
          {busy ? t(lang, 'pubSubmitting') : t(lang, 'rsvPrepayCta')}
        </button>
      </div>
    </div>
  )
}

/** Замок — знак защищённой оплаты; не эмодзи (шрифт системы рисует иначе) */
function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 7V5.4a3.5 3.5 0 0 1 7 0V7M3.7 7h8.6c.7 0 1.2.5 1.2 1.2v5.1c0 .7-.5 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2V8.2C2.5 7.5 3 7 3.7 7Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
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
function BookingScreen({ lang, locId, info, bookingKey, tz, onNew }: {
  lang: Lang
  locId: string
  /** Фото и логотип точки для шапки подтверждения; может ещё грузиться */
  info?: ReserveInfo
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

  const confirmed = view.status === 'confirmed' || view.status === 'completed'
  const visitDate = new Date(view.reserved_at)

  /* Билет визита: дата, время и компания тремя колонками — то, ради чего
     гость открывает эту страницу второй раз. */
  const ticket = (
    <div className="public-reserve-ticket">
      <div className="public-reserve-ticket-grid">
        <div>
          <small>{t(lang, 'rsvTicketDate')}</small>
          <strong>
            {visitDate.toLocaleDateString(lang === 'he' ? 'he-IL' : 'ru-RU', {
              day: 'numeric', month: 'short', timeZone: tz,
            })}
          </strong>
        </div>
        <div>
          <small>{t(lang, 'rsvTicketTime')}</small>
          <strong className="tabular-nums">{localTimeOf(visitDate.getTime(), tz)}</strong>
        </div>
        <div>
          <small>{t(lang, 'rsvTicketGuests')}</small>
          <strong className="tabular-nums">{view.party_size}</strong>
        </div>
      </div>

      <div className="public-reserve-ticket-actions">
        {confirmed && (
          <button
            type="button"
            onClick={() => downloadIcs({
              uid: view.public_token,
              start: visitDate,
              durationMin: view.duration_min,
              summary: `${t(lang, 'rsvPageLabel')} · ${loc.name}`,
              location: loc.address,
              description: `${view.customer_name} · ${view.party_size} ${t(lang, 'resGuestsShort')}`,
            })}
          >
            <CalendarIcon />
            {t(lang, 'rsvAddToCalendar')}
          </button>
        )}
        {googleMapsUrl && (
          <button type="button" onClick={() => setNavOpen(true)}>
            <RouteIcon />
            {t(lang, 'rsvNavigateBtn')}
          </button>
        )}
        {loc.phone && (
          <a href={`tel:${loc.phone}`}>
            <PhoneIcon />
            {t(lang, 'rsvPhoneBtn')}
          </a>
        )}
      </div>

      <div className="public-reserve-ticket-meta">
        <span>
          {view.customer_name}
          {view.zone_name && <> · {view.zone_name}</>}
          {view.table_label && <> · {t(lang, 'tableLabel')} {view.table_label}</>}
        </span>
        {/* Оплата показывается ТОЛЬКО подтверждённая сервером (164):
            «требуется» и «ждём» подтверждением платежа не являются. */}
        {view.deposit_status === 'paid' && (
          <span className="public-reserve-paid">{t(lang, 'rsvPaidLabel')}</span>
        )}
        {loc.address && <span>{loc.address}</span>}
      </div>
    </div>
  )

  return (
    <div className="public-reserve-done">
      <div className="public-reserve-done-hero">
        {info?.location.header_url && <img src={info.location.header_url} alt="" />}
        {info?.location.logo_url && (
          <img src={info.location.logo_url} alt="" className="public-reserve-done-logo" />
        )}
        <div className="public-reserve-done-copy">
          {confirmed ? (
            <span className="public-reserve-done-check" aria-hidden="true"><CheckIcon /></span>
          ) : (
            <span className="public-reserve-status-spinner public-reserve-done-spinner" aria-hidden="true" />
          )}
          {/* Заявка и подтверждённая бронь — РАЗНЫЕ слова: пока касса не
              ответила, называть стол закреплённым нельзя. */}
          <strong className="font-display public-reserve-route-focus" tabIndex={-1}>
            {confirmed ? t(lang, 'rsvConfirmedTitle') : t(lang, 'rsvPendingTitle')}
          </strong>
          <small>
            {confirmed
              ? `${t(lang, 'rsvDoneWaiting')} · ${loc.name}`
              : t(lang, 'rsvPendingHint')}
          </small>
        </div>
      </div>

      <div className="public-reserve-done-body">
        {ticket}
        {actions}
        <a href={`/order/${locId}`} className="public-reserve-link-action">
          {t(lang, 'rsvViewMenu')}
        </a>
        {sheets}
      </div>
    </div>
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
  draft: DetailsDraft
  onDraft: (d: DetailsDraft) => void
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
  // Листу ожидания хватает имени и телефона: это ещё не бронь, а согласие
  // подождать — фамилию и почту здесь не спрашиваем.
  const guestName = `${draft.firstName} ${draft.lastName}`.trim()
  const valid = guestName.length > 0 && phoneDigits.length >= 9 && to > from

  async function submit() {
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    try {
      await joinWaitlist({
        loc: locId,
        client_uuid: clientUuid,
        name: guestName,
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
                <span>{t(lang, 'rsvFirstName')}</span>
                <input
                  autoComplete="given-name" value={draft.firstName}
                  onChange={(e) => onDraft({ ...draft, firstName: e.target.value })}
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


function PhoneIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
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

/** Шеврон «вперёд по направлению чтения»; в RTL зеркалится классом */
function ChevronStart() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Обведённая «i» — ярлык экрана условий визита, как в референсе */
function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 10.5v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="7" r="1.2" fill="currentColor" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Маршрут — пин со стрелкой навигации, как в утверждённом референсе.
 * Не эмодзи и не знак валюты: иконка обязана читаться и в 24px, и в RTL,
 * а эмодзи рисуется шрифтом системы и на Android 7.1 выглядит иначе.
 */
function RouteIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 21s6-5.5 6-11a6 6 0 1 0-12 0c0 5.5 6 11 6 11Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m9.15 10.25 5.7-2.4-2.4 5.7-.8-2.5-2.5-.8Z" fill="currentColor" />
    </svg>
  )
}

function InstagramIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

function FacebookIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  )
}

/** Google-отзыв: звезда — понятнее буквы G, речь именно об оценке */
function GoogleGIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
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

