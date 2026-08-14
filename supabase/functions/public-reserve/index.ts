/**
 * public-reserve — бронирование стола с сайта (053).
 *
 * GET ?loc=<location_id>
 *   → { location: { id, name, business_name, logo_url, accepting,
 *       address, phone, header_url, hours, links, zones, rules } }
 *   Инфо точки для формы брони. accepting — тумблер
 *   settings->reservations->enabled (отсутствие = выключено).
 *   header_url — своя шапка брони, иначе fallback на шапку онлайн-заказа;
 *   hours (часы работы) и links (соцсети) — подвал страницы (066);
 *   zones — живые зоны зала с активными столами (072), гость выбирает
 *   зону, когда их две и больше;
 *   rules — правила брони (145) в нормализованном БД виде; пункты с
 *   ack:true гость обязан отметить, иначе заявку отклонит сервер.
 *
 * GET ?b=<public_token|client_uuid>
 *   → карточка брони для постоянной ссылки (118): статус, детали визита,
 *   контакты точки и серверный вердикт can_cancel / can_reschedule.
 *
 * GET ?id=<client_uuid>
 *   → { status, reject_reason, reserved_at, party_size, table_label, zone_name }
 *   client_uuid знает только гость — он же и ключ доступа к статусу.
 *
 * POST { action:'submit', loc, client_uuid, name, phone, party_size, reserved_at, note?, zone_id?, rules_ack?, first_name?, last_name?, email? }
 *   → { reservation_id, duplicate } | { error }
 *   first_name/last_name/email (163) — структурное имя и почта гостя.
 *   Необязательны: без них имя берётся из name, и клиент, выложенный до
 *   163, работает как раньше. Наружу почта и телефон не отдаются.
 * POST { action:'cancel', client_uuid }
 *   → { status } | { error }   client_uuid = public_token или client_uuid
 * POST { action:'reschedule', client_uuid, reserved_at, zone_id? }
 *   → { status, reserved_at, public_token } | { error }
 * POST { action:'waitlist', loc, client_uuid, name, phone, party_size,
 *        date, time_from, time_to, zone_ids?, note? }
 *   → { waitlist_id, duplicate, status } | { error }   лист ожидания (122)
 * POST { action:'accept_offer', offer_token }
 *   → { reservation_id, public_token, status } | { error }
 * POST { action:'confirm_attendance', client_uuid }
 *   → { confirmed } | { error }
 * POST { action:'prepay_begin', loc, client_uuid, attempt_key, phone,
 *        party_size, reserved_at, note?, zone_id?, rules_ack?,
 *        first_name?, last_name?, email? }
 *   → { attempt_key, reservation_id, amount_minor, currency, status,
 *       expires_at, duplicate } | { error }   предоплата (164)
 *   Успех НЕ означает оплату: бронь лишь встаёт в удержание. Оплаченной
 *   она становится только из проверенного вебхука провайдера. Пока у
 *   точки нет провайдера со статусом healthy — prepay_unavailable.
 * POST { action:'track', loc, session_id, step, src?, utm?, party_size?,
 *        wanted_date?, wanted_time?, zone_id?, reservation_id? }
 *   → { ok: true }   воронка и атрибуция (124)
 *   Всегда 200 и всегда ok: телеметрия не имеет права влиять на бронь,
 *   а гостю нечего сообщать про её отказ. Отсев и лимиты — в БД.
 *
 * Вся валидация, анти-спам и идемпотентность — в БД
 * (submit_reservation и др., SECURITY DEFINER, только service_role).
 *
 * Деплой: supabase functions deploy public-reserve
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra },
  })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Ошибки, которые БД кидает осознанно — отдаём гостю как код, не 500
const KNOWN_ERRORS = [
  'disabled', 'rate_limited', 'busy', 'invalid_location', 'invalid_name',
  'invalid_phone', 'invalid_party', 'invalid_time', 'outside_hours', 'not_found',
  'full_slot', // 063: instant-режим, на слот не осталось свободного стола
  'invalid_zone', // 072: зона не существует / выключена / чужой точки
  'module_disabled', // 105: продукт не подключён организации
  // 118, самообслуживание гостя:
  'too_late', // отмена/перенос позже правила отсечки
  'reschedule_limit', // исчерпан лимит переносов
  'pos_mode', // гостя уже посадили за стол на кассе
  'not_active', // бронь отклонена/завершена — трогать нечего
  // 122, лист ожидания:
  'waitlist_disabled', // владелец не включил лист ожидания
  'offer_expired', // предложение просрочено или уже использовано
  'not_confirmed',
  'rules_not_accepted', // 145: обязательное правило точки не отмечено
  'invalid_email', // 163: почта пришла, но по формату это не адрес
  // 164, предоплата:
  'prepay_unavailable', // предоплата не настроена или провайдер не здоров
  'hold_expired',       // удержание стола истекло, пока гость платил
  'amount_mismatch',    // подтверждена не та сумма, которую посчитал сервер
]

// Сначала САМЫЕ ДЛИННЫЕ коды: сопоставление идёт по подстроке, а
// 'waitlist_disabled' и 'module_disabled' содержат внутри себя 'disabled'.
// Без сортировки специфичная причина подменялась общей, и гость видел
// «бронирование выключено» вместо «лист ожидания не ведётся» —
// поймано живой проверкой на проде.
const ERROR_CODES_BY_SPECIFICITY = [...KNOWN_ERRORS].sort((a, b) => b.length - a.length)

function errorCode(message: string): string {
  for (const code of ERROR_CODES_BY_SPECIFICITY) if (message.includes(code)) return code
  return 'unknown'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  if (req.method === 'GET') {
    const params = new URL(req.url).searchParams

    // Live-доступность слотов (063): ?loc=&date=YYYY-MM-DD&party=N[&zone=<uuid>].
    // Требует instant-режима у точки (RPC сама вернёт 'disabled', если приём выкл).
    // zone (072) сужает подбор столов до зоны зала.
    const availDate = params.get('date')
    const availParty = params.get('party')
    if (availDate !== null && availParty !== null) {
      const aLoc = params.get('loc') ?? ''
      if (!UUID_RE.test(aLoc)) return json({ error: 'invalid_location' }, 400)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(availDate)) return json({ error: 'bad_request' }, 400)
      const party = Math.floor(Number(availParty))
      if (!Number.isFinite(party) || party < 1 || party > 200) {
        return json({ error: 'invalid_party' }, 400)
      }
      const zone = params.get('zone')
      if (zone !== null && !UUID_RE.test(zone)) return json({ error: 'invalid_zone' }, 400)
      const { data, error } = await supabase.rpc('reservation_availability', {
        p_location_id: aLoc,
        p_date: availDate,
        p_party: party,
        p_zone_id: zone,
      })
      if (error) {
        const code = errorCode(error.message)
        return json({ error: code }, code === 'unknown' ? 500 : 400)
      }
      return json(data, 200, { 'Cache-Control': 'no-store' })
    }

    // Карточка брони по постоянной ссылке (118). Ключ — public_token,
    // но принимается и старый client_uuid: ссылки, выданные до 118, и
    // localStorage прежних гостей должны продолжать работать.
    const bookingKey = params.get('b')
    if (bookingKey !== null) {
      if (!UUID_RE.test(bookingKey)) return json({ error: 'not_found' }, 404)
      const { data, error } = await supabase.rpc('reservation_public_view', {
        p_key: bookingKey,
      })
      if (error) {
        const code = errorCode(error.message)
        return json({ error: code }, code === 'not_found' ? 404 : 500)
      }
      return json(data, 200, { 'Cache-Control': 'no-store' })
    }

    // Инфо точки для формы брони
    const loc = params.get('loc')
    if (loc !== null) {
      if (!UUID_RE.test(loc)) return json({ error: 'invalid_location' }, 400)
      // Предпросмотр владельца (126): по секретной ссылке страница
      // открывается даже при ВЫКЛЮЧЕННОМ приёме — иначе увидеть её до
      // публикации нельзя, а публикация вслепую и есть та ошибка,
      // которую чеклист запуска пытается предотвратить.
      const previewToken = params.get('preview')
      let preview = false
      if (previewToken) {
        const { data: ok } = await supabase.rpc('reserve_preview_valid', {
          p_location_id: loc,
          p_token: previewToken,
        })
        preview = ok === true
      }
      // Наружу — только флаг брони и баннер, НЕ весь settings (там права ролей)
      const { data, error } = await supabase
        .from('locations')
        .select('id, name, timezone, receipt_business_name, receipt_address, receipt_phone, logo_url, display_name:settings->>display_name, rsv:settings->reservations, oo_header_url:settings->online_orders->>header_url')
        .eq('id', loc)
        .maybeSingle()
      if (error || !data) return json({ error: 'invalid_location' }, 404)
      const rsv = (data as { rsv?: {
        enabled?: boolean; instant?: boolean; open?: string | null; close?: string | null
        slot_min?: number | null; max_party?: number | null
        display_name?: string | null
        address?: string | null; lat?: number | null; lng?: number | null
        header_url?: string | null; hours?: string | null
        schedule?: {
          weekly?: Record<string, [string, string][]>
          exceptions?: Record<string, [string, string][]>
          lead_min?: number
          horizon_days?: number
        } | null
        waitlist?: boolean
        instagram?: string | null; facebook?: string | null; google_review?: string | null
      } }).rsv
      // Соцссылки подвала (066): показываем только заполненные (пусто → нет кнопки)
      const links = {
        instagram: rsv?.instagram || null,
        facebook: rsv?.facebook || null,
        google_review: rsv?.google_review || null,
      }
      // Зоны зала (072): наружу — только живые зоны, в которых есть активные
      // столы (пустая зона гостю бесполезна). Гость видит выбор от двух зон.
      let zones: { id: string; name: string }[] = []
      if (rsv?.enabled === true || preview) {
        const [zoneRes, tableRes] = await Promise.all([
          supabase.from('table_zones').select('id, name')
            .eq('location_id', loc).eq('is_active', true).order('sort_order'),
          supabase.from('tables').select('zone_id')
            .eq('location_id', loc).eq('is_active', true).not('zone_id', 'is', null),
        ])
        const used = new Set((tableRes.data ?? []).map((t) => t.zone_id as string))
        zones = (zoneRes.data ?? [])
          .filter((z) => used.has(z.id))
          .map((z) => ({ id: z.id, name: z.name }))
      }
      // Правила брони (145). Нормализует их БД — та же функция, которой
      // submit_reservation проверяет согласие. Второй нормализатор здесь
      // означал бы, что показанный гостю пункт и проверяемый сервером
      // могут разойтись, а именно на этом расхождении держится отказ
      // rules_not_accepted.
      const { data: rulesData } = await supabase.rpc('reservation_rules', {
        p_settings: { reservations: rsv ?? {} },
      })
      const rules = Array.isArray(rulesData) ? rulesData : []
      // Правило предоплаты (164). Считает СЕРВЕР и отдаёт только там, где
      // платёж действительно можно принять: без провайдера со статусом
      // healthy вернётся null, и страница про предоплату не узнает.
      // Сумма здесь предварительная (с человека) — обязывающую называет
      // begin_reservation_prepayment в момент оплаты.
      const { data: prepayData } = await supabase.rpc('reservation_prepay_rule', {
        p_location_id: loc,
      })
      return json(
        {
          location: {
            id: data.id,
            name: data.name,
            // Имя в шапке: своё имя страницы брони → публичное имя точки →
            // название из чека → имя точки
            business_name:
              rsv?.display_name ||
              (data as { display_name?: string | null }).display_name ||
              data.receipt_business_name ||
              data.name,
            logo_url: data.logo_url ?? null,
            // Тумблер 053: отсутствие ключа = бронирование ВЫКЛЮЧЕНО.
            // В предпросмотре страница ведёт себя как открытая, но
            // помечена: `preview` ниже включает баннер и запрещает
            // отправку — гость такой ссылки не получает.
            accepting: rsv?.enabled === true || preview,
            preview,
            // Настоящее состояние тумблера. В предпросмотре невыложенной
            // точки live-доступность спрашивать бесполезно (RPC отдаст
            // 'disabled'), и страница показывает сетку расписания —
            // владелец проверяет часы, зоны и вид, а не занятость.
            published: rsv?.enabled === true,
            // instant-режим (063): гость видит live-доступность, бронь сразу confirmed
            instant: rsv?.instant === true,
            // Часы приёма (059): устаревшая пара на все семь дней. Оставлена
            // для клиентов, выложенных до 117, и как фолбэк, пока точке не
            // заполнили schedule. Новый клиент читает schedule.
            open: rsv?.open ?? null,
            close: rsv?.close ?? null,
            slot_min: rsv?.slot_min ?? null,
            // Расписание (117) — ЕДИНЫЙ источник и показанных часов, и сетки
            // слотов. Гостевая страница строит слоты по нему в часовом поясе
            // ТОЧКИ, а не устройства, поэтому tz уходит наружу вместе с ним.
            schedule: rsv?.schedule ?? null,
            timezone: (data as { timezone?: string | null }).timezone || 'Asia/Jerusalem',
            // Лимит гостей на бронь (061): гостевой селект ограничен этим числом
            max_party: rsv?.max_party ?? null,
            // Адрес брони (062): точный адрес из настроек приоритетнее адреса
            // из реквизитов чека. Телефон — из реквизитов чека.
            address: rsv?.address || data.receipt_address || null,
            // Координаты пина (062): заданы → «Навигация» открывает точную точку
            lat: rsv?.lat ?? null,
            lng: rsv?.lng ?? null,
            phone: data.receipt_phone ?? null,
            // Фото-шапка страницы брони (066): своя (settings.reservations.header_url),
            // иначе fallback на шапку онлайн-заказа (Настройки → Онлайн-заказы)
            header_url: rsv?.header_url || (data as { oo_header_url?: string | null }).oo_header_url || null,
            // Часы работы — свободный текст в подвале (066); пусто = не показывать
            hours: rsv?.hours || null,
            // Соцссылки подвала (066)
            links,
            // Зоны зала (072): гость выбирает зону, когда их две и больше
            zones,
            // Лист ожидания (122): владелец включает отдельно — заведение,
            // которое не собирается перезванивать, не должно копить обещания
            waitlist: rsv?.waitlist === true,
            // Правила брони (145): гость читает их ДО отправки заявки, а
            // пункты с ack:true отмечает явно
            rules,
            // Предоплата (164): null = шага оплаты нет. Ключей провайдера
            // здесь нет и быть не может — только то, что видит гость.
            prepay: prepayData ?? null,
          },
        },
        200,
        // Предпросмотр не кэшируем: владелец правит настройки и тут же
        // перезагружает страницу, чтобы увидеть результат.
        { 'Cache-Control': preview ? 'no-store' : 'public, max-age=30' }
      )
    }

    // Поллинг статуса гостем
    const id = params.get('id') ?? ''
    if (!UUID_RE.test(id)) return json({ error: 'not_found' }, 404)
    const { data, error } = await supabase.rpc('get_reservation_status', { p_client_uuid: id })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'not_found' ? 404 : 500)
    }
    return json(data)
  }

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  // Грубая защита от мусорных payload до похода в БД
  const raw = await req.text()
  if (raw.length > 2_000) return json({ error: 'bad_request' }, 400)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  const action = body.action

  if (action === 'cancel') {
    const clientUuid = body.client_uuid
    if (typeof clientUuid !== 'string' || !UUID_RE.test(clientUuid)) {
      return json({ error: 'not_found' }, 404)
    }
    const { data, error } = await supabase.rpc('cancel_reservation', { p_client_uuid: clientUuid })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'not_found' ? 404 : 500)
    }
    return json(data)
  }

  // Перенос брони гостем (118). Доступность, расписание и правило отсечки
  // целиком проверяет БД: клиент присылает только новое время.
  if (action === 'reschedule') {
    const { client_uuid: key, reserved_at, zone_id } = body as {
      client_uuid?: string; reserved_at?: string; zone_id?: string | null
    }
    if (typeof key !== 'string' || !UUID_RE.test(key)) {
      return json({ error: 'not_found' }, 404)
    }
    if (typeof reserved_at !== 'string') return json({ error: 'bad_request' }, 400)
    if (zone_id != null && (typeof zone_id !== 'string' || !UUID_RE.test(zone_id))) {
      return json({ error: 'invalid_zone' }, 400)
    }
    const { data, error } = await supabase.rpc('reschedule_reservation', {
      p_key: key,
      p_at: reserved_at,
      p_zone_id: zone_id ?? null,
    })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'unknown' ? 500 : 400)
    }
    return json(data)
  }

  // Гость встаёт в лист ожидания (122): слота нет, но он готов ждать.
  if (action === 'waitlist') {
    const {
      loc, client_uuid, name, phone, party_size, date, time_from, time_to,
      zone_ids, note,
    } = body as {
      loc?: string; client_uuid?: string; name?: string; phone?: string
      party_size?: number; date?: string; time_from?: string; time_to?: string
      zone_ids?: string[] | null; note?: string | null
    }
    if (!UUID_RE.test(loc ?? '') || !UUID_RE.test(client_uuid ?? '')) {
      return json({ error: 'bad_request' }, 400)
    }
    if (typeof name !== 'string' || typeof phone !== 'string'
        || typeof party_size !== 'number'
        || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
        || !/^\d{2}:\d{2}$/.test(time_from ?? '')
        || !/^\d{2}:\d{2}$/.test(time_to ?? '')) {
      return json({ error: 'bad_request' }, 400)
    }
    const zones = Array.isArray(zone_ids) ? zone_ids.filter((z) => UUID_RE.test(z)) : []
    const { data, error } = await supabase.rpc('submit_waitlist', {
      p_location_id: loc,
      p_client_uuid: client_uuid,
      p_name: name,
      p_phone: phone,
      p_party_size: Math.floor(party_size),
      p_date: date,
      p_from: time_from,
      p_to: time_to,
      p_zone_ids: zones,
      p_note: note ?? null,
    })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'unknown' ? 500 : 400)
    }
    return json(data)
  }

  // Гость соглашается на предложенное время из листа ожидания.
  if (action === 'accept_offer') {
    const token = (body as { offer_token?: string }).offer_token
    if (typeof token !== 'string' || !UUID_RE.test(token)) {
      return json({ error: 'not_found' }, 404)
    }
    const { data, error } = await supabase.rpc('accept_waitlist_offer', { p_token: token })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'unknown' ? 500 : 400)
    }
    return json(data)
  }

  // Шаг воронки (124). Отдельная ветка ДО остальных проверок формата:
  // ответ здесь всегда один и тот же, а решение принимает БД.
  if (action === 'track') {
    const {
      loc, session_id, step, src, utm, party_size,
      wanted_date, wanted_time, zone_id, reservation_id,
    } = body as {
      loc?: string; session_id?: string; step?: string; src?: string
      utm?: Record<string, unknown>; party_size?: number
      wanted_date?: string; wanted_time?: string
      zone_id?: string; reservation_id?: string
    }
    if (UUID_RE.test(loc ?? '') && UUID_RE.test(session_id ?? '') && typeof step === 'string') {
      // Метки чистим до пяти известных ключей и коротких строк: utm
      // приходит из адреса, то есть от кого угодно.
      const marks: Record<string, string> = {}
      if (utm && typeof utm === 'object') {
        for (const key of ['source', 'medium', 'campaign', 'content', 'term']) {
          const value = (utm as Record<string, unknown>)[key]
          if (typeof value === 'string' && value.trim()) marks[key] = value.trim().slice(0, 64)
        }
      }
      await supabase.rpc('track_reserve_event', {
        p_location_id: loc,
        p_session_id: session_id,
        p_step: step.slice(0, 32),
        p_src: typeof src === 'string' ? src.slice(0, 32) : null,
        p_utm: marks,
        p_party_size: typeof party_size === 'number' ? Math.floor(party_size) : null,
        p_wanted_date: /^\d{4}-\d{2}-\d{2}$/.test(wanted_date ?? '') ? wanted_date : null,
        p_wanted_time: /^\d{2}:\d{2}$/.test(wanted_time ?? '') ? wanted_time : null,
        p_zone_id: UUID_RE.test(zone_id ?? '') ? zone_id : null,
        p_reservation_id: UUID_RE.test(reservation_id ?? '') ? reservation_id : null,
      })
    }
    return json({ ok: true })
  }

  // Начало предоплаты (164). Бронь встаёт в удержание, сумму называет БД.
  //
  // Редирект на провайдера здесь НЕ формируется: адаптера в проекте нет,
  // и придумывать его «на будущее» нельзя — гость ушёл бы в никуда. Пока
  // ни у одной точки нет провайдера со статусом healthy, БД отвечает
  // prepay_unavailable, и этот эндпоинт остаётся недостижимым по делу.
  if (action === 'prepay_begin') {
    const {
      loc, client_uuid, attempt_key, phone, party_size, reserved_at, note,
      zone_id, rules_ack, first_name, last_name, email,
    } = body as {
      loc?: string; client_uuid?: string; attempt_key?: string; phone?: string
      party_size?: number; reserved_at?: string; note?: string | null
      zone_id?: string | null; rules_ack?: unknown
      first_name?: string | null; last_name?: string | null; email?: string | null
    }
    if (!UUID_RE.test(loc ?? '') || !UUID_RE.test(client_uuid ?? '')
        || !UUID_RE.test(attempt_key ?? '')) {
      return json({ error: 'bad_request' }, 400)
    }
    if (typeof phone !== 'string' || typeof party_size !== 'number'
        || typeof reserved_at !== 'string') {
      return json({ error: 'bad_request' }, 400)
    }
    if (zone_id != null && (typeof zone_id !== 'string' || !UUID_RE.test(zone_id))) {
      return json({ error: 'invalid_zone' }, 400)
    }
    const ack = Array.isArray(rules_ack)
      ? rules_ack.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(0, 20)
      : []
    const opt = (value: unknown, limit: number): string | null =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null

    const { data, error } = await supabase.rpc('begin_reservation_prepayment', {
      p_location_id: loc,
      p_client_uuid: client_uuid,
      p_attempt_key: attempt_key,
      p_phone: phone,
      p_party_size: Math.floor(party_size),
      p_reserved_at: reserved_at,
      p_note: note ?? null,
      p_zone_id: zone_id ?? null,
      p_rules_ack: ack,
      p_first_name: opt(first_name, 40),
      p_last_name: opt(last_name, 40),
      p_email: opt(email, 254),
    })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'unknown' ? 500 : 400)
    }
    return json(data, 200, { 'Cache-Control': 'no-store' })
  }

  // Гость подтверждает, что придёт (122).
  if (action === 'confirm_attendance') {
    const key = (body as { client_uuid?: string }).client_uuid
    if (typeof key !== 'string' || !UUID_RE.test(key)) {
      return json({ error: 'not_found' }, 404)
    }
    const { data, error } = await supabase.rpc('confirm_reservation_attendance', { p_key: key })
    if (error) {
      const code = errorCode(error.message)
      return json({ error: code }, code === 'unknown' ? 500 : 400)
    }
    return json(data)
  }

  if (action !== 'submit') return json({ error: 'bad_request' }, 400)

  const {
    loc, client_uuid, name, phone, party_size, reserved_at, note, zone_id, rules_ack,
    first_name, last_name, email,
  } = body as {
    loc?: string; client_uuid?: string; name?: string; phone?: string
    party_size?: number; reserved_at?: string; note?: string | null
    zone_id?: string | null; rules_ack?: unknown
    first_name?: string | null; last_name?: string | null; email?: string | null
  }
  if (!UUID_RE.test(loc ?? '') || !UUID_RE.test(client_uuid ?? '')) {
    return json({ error: 'bad_request' }, 400)
  }
  if (typeof name !== 'string' || typeof phone !== 'string'
      || typeof party_size !== 'number' || typeof reserved_at !== 'string') {
    return json({ error: 'bad_request' }, 400)
  }
  // Структурное имя и почта (163) — необязательные строки. Длину режем
  // здесь только как грубый предел; канонический вид и проверку формата
  // делает БД, чтобы правило жило в одном месте.
  const optText = (value: unknown, limit: number): string | null =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null
  // Зона (072) — опциональное пожелание гостя
  if (zone_id != null && (typeof zone_id !== 'string' || !UUID_RE.test(zone_id))) {
    return json({ error: 'invalid_zone' }, 400)
  }

  // Правила (145): наружу принимаем ТОЛЬКО идентификаторы отмеченных
  // пунктов. Текст правила берётся из настроек точки — снимок согласия
  // не должен зависеть от того, что прислал браузер.
  const acked = Array.isArray(rules_ack)
    ? rules_ack.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(0, 20)
    : []

  const { data, error } = await supabase.rpc('submit_reservation', {
    p_location_id: loc,
    p_client_uuid: client_uuid,
    p_name: name,
    p_phone: phone,
    p_party_size: Math.floor(party_size),
    p_reserved_at: reserved_at,
    p_note: note ?? null,
    p_zone_id: zone_id ?? null,
    p_rules_ack: acked,
    p_first_name: optText(first_name, 40),
    p_last_name: optText(last_name, 40),
    p_email: optText(email, 254),
  })

  if (error) {
    const code = errorCode(error.message)
    return json({ error: code }, code === 'unknown' ? 500 : 400)
  }
  return json(data)
})
