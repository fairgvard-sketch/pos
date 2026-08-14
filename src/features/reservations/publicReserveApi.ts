/**
 * Клиент публичного API брони (053) для страницы гостя /reserve/:locId.
 * Ходит ТОЛЬКО в Edge Function public-reserve с anon-ключом —
 * прямого доступа к таблицам у гостя нет, всё решает сервер.
 */

import { parseError, resolveLocationId } from '../online/publicApi'

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

const headers = {
  'Content-Type': 'application/json',
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
}

/**
 * Правило брони (145). Нормализует его БД (`reservation_rules`), клиент
 * только показывает: обязательный пункт без отметки отклонит сервер,
 * и решать «обязателен ли он» на клиенте нельзя.
 */
export interface ReserveRule {
  id: string
  text: string
  /** important — выделенный пункт (красный маркер) */
  level: 'normal' | 'important'
  /** true — гость обязан отметить пункт галочкой */
  ack: boolean
  /** Ссылка на документ (условия использования); null — обычный текст */
  url: string | null
}

export interface ReserveInfo {
  location: {
    id: string
    name: string
    /** Название в шапке: своё имя страницы брони (settings.reservations.
     *  display_name) → публичное имя точки → шапка чека → имя точки */
    business_name?: string
    logo_url?: string | null
    /** false = владелец не включил приём броней (тумблер 053, default off) */
    accepting: boolean
    /** Предпросмотр владельца (126): страница открыта по секретной ссылке.
     *  Гость её не получает; отправка заявки запрещена. */
    preview?: boolean
    /** Настоящее состояние тумблера приёма. В предпросмотре невыложенной
     *  точки live-доступности нет — показываем сетку расписания. */
    published?: boolean
    /** instant-режим (063): гость видит live-доступность и бронь
     *  подтверждается сразу. false → прежний флоу заявка→касса. */
    instant?: boolean
    /** Часы приёма (059) — устаревшая пара на все семь дней. Оставлена как
     *  фолбэк, пока точке не заполнили schedule. 'HH:MM' */
    open?: string | null
    close?: string | null
    /** Недельное расписание (117) — ЕДИНЫЙ источник и показанных часов, и
     *  сетки слотов: окна по дням недели, исключения по датам, минимальный
     *  запас до визита и горизонт записи. null = точка ещё на legacy-паре */
    schedule?: {
      weekly?: Record<string, [string, string][]>
      exceptions?: Record<string, [string, string][]>
      lead_min?: number
      horizon_days?: number
    } | null
    /** Часовой пояс точки (117): сетка считается в нём, а не в зоне гостя */
    timezone?: string | null
    /** Шаг слота времени, мин (по умолчанию 15) */
    slot_min?: number | null
    /** Макс. гостей в одной брони (061; по умолчанию 20) */
    max_party?: number | null
    /** Адрес заведения — кнопка «Навигация» + текст под названием (062:
     *  точный адрес из настроек брони, иначе адрес из реквизитов чека) */
    address?: string | null
    /** Координаты пина (062): заданы → «Навигация» ведёт точно к точке */
    lat?: number | null
    lng?: number | null
    phone?: string | null
    /** Фото-шапка страницы брони (066): своя, иначе шапка онлайн-заказа */
    header_url?: string | null
    /** Часы работы — свободный текст в подвале (066); пусто = не показывать */
    hours?: string | null
    /** Соцссылки подвала (066); пустые поля = кнопки нет */
    links?: {
      instagram?: string | null
      facebook?: string | null
      google_review?: string | null
    }
    /** Зоны зала с активными столами (072); выбор показываем от двух зон */
    zones?: { id: string; name: string }[]
    /** Лист ожидания включён владельцем (122): гость может оставить
     *  пожелание, когда свободного слота нет */
    waitlist?: boolean
    /** Правила брони (145): показываются отдельным шагом перед формой.
     *  Пустой массив = шага нет, поток остаётся в три экрана. */
    rules?: ReserveRule[]
    /** Правило предоплаты (164). Присылается ТОЛЬКО когда предоплата
     *  включена И платёжный провайдер настроен и здоров: отсутствие поля
     *  означает «шага оплаты нет», и клиент не имеет права решить иначе.
     *  Здесь только то, что можно показать гостю — никаких секретов. */
    prepay?: ReservePrepayRule | null
  }
}

/**
 * Правило предоплаты точки (164) — без ключей провайдера.
 *
 * Суммы здесь ПРЕДВАРИТЕЛЬНЫЕ: их можно показать, но нельзя считать
 * обязательством. Обязывающую сумму называет сервер в ответ на начало
 * оплаты, он же сверяет её с тем, что подтвердил провайдер.
 */
export interface ReservePrepayRule {
  /** Сумма с гостя в минорных единицах (агороты) — считает сервер */
  amount_per_guest: number
  /** С какого размера компании предоплата обязательна */
  from_party: number
  /** Валюта точки, ISO-4217 */
  currency: string
  /** За сколько часов до визита отмена возвращает деньги полностью */
  refund_cutoff_hours: number
}

export async function fetchReserveInfo(
  locId: string, previewToken?: string | null,
): Promise<ReserveInfo> {
  const loc = await resolveLocationId(locId)
  const qs = new URLSearchParams({ loc })
  // Секрет предпросмотра (126) уходит на сервер: решение «показывать ли
  // невыложенную страницу» принимает он, а не клиент.
  if (previewToken) qs.set('preview', previewToken)
  const res = await fetch(`${FN_BASE}/public-reserve?${qs}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}

export interface ReservePayload {
  loc: string
  client_uuid: string
  /** Собранное имя. Остаётся в контракте: по нему живут касса, карточка
   *  гостя и выгрузки, а старый сервер других полей не знает (163) */
  name: string
  phone: string
  party_size: number
  reserved_at: string // ISO
  note: string | null
  /** Пожелание зоны зала (072); null = без предпочтений */
  zone_id: string | null
  /** Отмеченные правила (145) — только идентификаторы: текст в снимок
   *  согласия сервер берёт из настроек точки, не из этого запроса */
  rules_ack?: string[]
  /** Структурное имя (163). Сервер сам соберёт из них `customer_name` —
   *  разбирать одну строку обратно на части нельзя достоверно */
  first_name?: string
  last_name?: string
  /** Почта гостя (163). Нормализует и проверяет формат сервер */
  email?: string
}

export interface ReserveResult {
  reservation_id: string
  duplicate: boolean
  /** instant-режим (063): бронь сразу confirmed; иначе 'new' (заявка) */
  status?: 'new' | 'confirmed'
  /** Секрет постоянной ссылки на бронь (118) — выдаёт сервер */
  public_token?: string
  deposit_status?: 'none' | 'required' | 'paid' | 'refunded' | 'forfeited'
  deposit_amount?: number
}

/** Слот дня с признаком доступности (063, instant-режим) */
export interface AvailSlot {
  time: string // 'HH:MM'
  free: boolean
  /** Абсолютный момент слота (117). Нужен ночным сменам: метка «01:00»
   *  относится к следующим суткам, и по одной метке момент не восстановить */
  at?: string
}

export interface AvailabilityResult {
  date: string
  slot_min: number
  slots: AvailSlot[]
}

/**
 * Live-доступность слотов на дату под размер компании (063).
 * Возвращается только если у точки включён instant-режим — иначе
 * гостевая страница показывает слоты как раньше (все «свободны»).
 * zoneId (072) сужает подбор столов до выбранной зоны зала.
 */
export async function fetchAvailability(
  locId: string, date: string, party: number, zoneId?: string | null,
): Promise<AvailabilityResult> {
  const qs = new URLSearchParams({ loc: await resolveLocationId(locId), date, party: String(party) })
  if (zoneId) qs.set('zone', zoneId)
  const res = await fetch(`${FN_BASE}/public-reserve?${qs}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}

export async function submitPublicReservation(payload: ReservePayload): Promise<ReserveResult> {
  // loc из URL может быть слагом (106); create_reservation принимает UUID.
  const loc = await resolveLocationId(payload.loc)
  const res = await fetch(`${FN_BASE}/public-reserve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'submit', ...payload, loc }),
  })
  if (!res.ok) await parseError(res)
  return res.json()
}

/**
 * Статус брони по client_uuid — путь до 118. Заменён на
 * `fetchReservationView` (постоянная ссылка + вердикт сервера
 * can_cancel/can_reschedule), поэтому клиентской обёртки больше нет.
 * Эндпоинт `?id=` в Edge Function оставлен ради страниц, открытых до
 * выкладки нового фронта.
 */

export async function cancelPublicReservation(clientUuid: string): Promise<{ status: string }> {
  const res = await fetch(`${FN_BASE}/public-reserve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'cancel', client_uuid: clientUuid }),
  })
  if (!res.ok) await parseError(res)
  return res.json()
}

// ── Постоянная ссылка на бронь (118) ─────────────────────────

/** Почему действие гостя недоступно; null = доступно */
export type GuestBlock =
  | 'not_active'   // бронь отклонена, отменена или завершена
  | 'pos_mode'     // гостя уже посадили за стол на кассе
  | 'too_late'     // позже правила отсечки заведения
  | 'reschedule_limit'
  | null

export interface ReservationView {
  status: 'new' | 'confirmed' | 'rejected' | 'cancelled' | 'completed' | 'no_show'
  reject_reason: string | null
  reserved_at: string
  party_size: number
  customer_name: string
  note: string | null
  table_label: string | null
  zone_name: string | null
  zone_id: string | null
  created_at: string
  duration_min: number
  /** Секрет постоянной ссылки: гость может сохранить её или открыть с другого устройства */
  public_token: string
  rescheduled: boolean
  /** Состояние предоплаты (164). Показывать «оплачено» можно ТОЛЬКО по
   *  значению 'paid': оно ставится из проверенного ответа провайдера */
  deposit_status?: 'none' | 'required' | 'awaiting' | 'paid'
    | 'failed' | 'cancelled' | 'expired' | 'refunded' | 'forfeited'
  /** Заведение попросило подтвердить приход (122) */
  confirm_requested_at?: string | null
  /** Гость подтвердил, что придёт */
  guest_confirmed_at?: string | null
  /** Вердикт СЕРВЕРА. Клиент его только показывает: правила отсечки живут
   *  в одном месте, иначе они разойдутся — урок часов из 117. */
  can_cancel: boolean
  cancel_block: GuestBlock
  can_reschedule: boolean
  reschedule_block: GuestBlock
  location: {
    id: string
    name: string
    address: string | null
    phone: string | null
    lat: number | null
    lng: number | null
    timezone: string
    /** Правила отмены своими словами — показываем рядом с кнопкой */
    policy: string | null
  }
}

/** Карточка брони по постоянной ссылке; ключ — public_token или client_uuid */
export async function fetchReservationView(key: string): Promise<ReservationView> {
  const res = await fetch(`${FN_BASE}/public-reserve?b=${encodeURIComponent(key)}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}

export interface RescheduleResult {
  status: 'new' | 'confirmed'
  reserved_at: string
  public_token: string
}

/**
 * Перенос брони. Доступность, расписание и правило отсечки перепроверяет
 * сервер; неудача (`full_slot`, `outside_hours`, `too_late`) НЕ трогает
 * уже существующее время — гость не теряет бронь, пытаясь её подвинуть.
 */
export async function reschedulePublicReservation(
  key: string, reservedAt: string, zoneId?: string | null,
): Promise<RescheduleResult> {
  const res = await fetch(`${FN_BASE}/public-reserve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'reschedule',
      client_uuid: key,
      reserved_at: reservedAt,
      zone_id: zoneId ?? null,
    }),
  })
  if (!res.ok) await parseError(res)
  return res.json()
}

// ── Лист ожидания (122) ──────────────────────────────────────

export interface WaitlistPayload {
  loc: string
  client_uuid: string
  name: string
  phone: string
  party_size: number
  /** Дата в зоне точки, 'YYYY-MM-DD' */
  date: string
  /** Приемлемый диапазон времени, 'HH:MM' */
  time_from: string
  time_to: string
  zone_ids?: string[]
  note?: string | null
}

/**
 * Встать в лист ожидания. Вызывается там, где обычная бронь невозможна:
 * день занят целиком или выбранное время увели. Обещание перезвонить —
 * ответственность заведения, поэтому лист включается отдельным тумблером.
 */
export async function joinWaitlist(payload: WaitlistPayload): Promise<{
  waitlist_id: string; duplicate: boolean; status: string
}> {
  const loc = await resolveLocationId(payload.loc)
  const res = await fetch(`${FN_BASE}/public-reserve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'waitlist', ...payload, loc }),
  })
  if (!res.ok) await parseError(res)
  return res.json()
}

// ── Предоплата брони (164) ───────────────────────────────────

export interface PrepayBeginPayload extends ReservePayload {
  /** Ключ попытки оплаты. Создаётся ДО первой попытки и переиспользуется
   *  при повторе: повторный тап не должен создавать вторую бронь */
  attempt_key: string
}

export interface PrepayBeginResult {
  attempt_key: string
  reservation_id: string
  /** Обязывающая сумма в минорных единицах — считает СЕРВЕР */
  amount_minor: number
  currency: string
  status: 'pending' | 'paid'
  /** До какого момента стол удерживается неоплаченным */
  expires_at: string
  duplicate: boolean
  /** Куда отправить гостя платить. Формирует сервер, не клиент */
  redirect_url?: string | null
}

/**
 * Начать предоплату: сервер держит стол бронью и называет сумму.
 *
 * Успех этого вызова НЕ означает оплату. Оплаченной бронь становится
 * только после проверенного подтверждения провайдера на сервере —
 * возврат гостя на страницу успеха доказательством не является.
 */
export async function beginReservationPrepayment(
  payload: PrepayBeginPayload,
): Promise<PrepayBeginResult> {
  const loc = await resolveLocationId(payload.loc)
  const res = await fetch(`${FN_BASE}/public-reserve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'prepay_begin', ...payload, loc }),
  })
  if (!res.ok) await parseError(res)
  return res.json()
}

/** Гость подтверждает, что придёт (122) */
export async function confirmAttendance(key: string): Promise<{ confirmed: boolean }> {
  const res = await fetch(`${FN_BASE}/public-reserve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'confirm_attendance', client_uuid: key }),
  })
  if (!res.ok) await parseError(res)
  return res.json()
}
