/**
 * Воронка гостевой брони (124): шаги до отправки заявки и канал привода.
 *
 * Зачем вообще. По `reservations` видно только победы. Сколько человек
 * открыли страницу и ушли, на каком шаге и какого времени им не хватило —
 * не знает никто, и владелец не может ответить, работает ли QR на столах.
 *
 * Три правила, из которых всё остальное следует:
 *   1. Телеметрия НИКОГДА не мешает брони: запрос уходит фоном, ошибки
 *      проглатываются, ответ никто не ждёт.
 *   2. Один шаг = одна запись. Дедупликация есть и на сервере (уникальный
 *      индекс), и здесь — чтобы не делать заведомо лишних запросов.
 *   3. Ничего личного. Сессия — случайный UUID вкладки, имя и телефон
 *      сюда не попадают.
 */

import { resolveLocationId } from '../online/publicApi'

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export type FunnelStep =
  | 'page_view'
  | 'availability'
  | 'no_slots'
  | 'slot_selected'
  | 'form_started'
  | 'submitted'
  | 'waitlisted'

export interface FunnelContext {
  party_size?: number
  /** Дата, которую хотел гость, 'YYYY-MM-DD' */
  wanted_date?: string
  /** Время, которое хотел гость, 'HH:MM' */
  wanted_time?: string
  zone_id?: string | null
  reservation_id?: string
}

interface Attribution {
  src: string | null
  utm: Record<string, string>
}

const SESSION_KEY = 'rsv_funnel_session'
const ATTR_KEY = 'rsv_funnel_attr'
const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const

/** Шаги, уже отправленные этой вкладкой: второй раз не ходим */
const sent = new Set<string>()

function readStore(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null // Private mode / выключенное хранилище — не повод падать
  }
}

function writeStore(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* см. readStore */
  }
}

/** Идентификатор вкладки. Переживает шаги флоу, но не закрытие вкладки. */
function sessionId(): string {
  const saved = readStore(SESSION_KEY)
  if (saved) return saved
  const fresh = crypto.randomUUID()
  writeStore(SESSION_KEY, fresh)
  return fresh
}

/**
 * Канал привода. Читается из адреса ОДИН раз и запоминается: страница
 * переписывает свой URL при получении брони (`writeBookingUrl`, 118), и
 * к моменту отправки исходных меток в адресе уже нет.
 */
export function captureAttribution(search: string): Attribution {
  const saved = readStore(ATTR_KEY)
  if (saved) {
    try {
      return JSON.parse(saved) as Attribution
    } catch {
      /* испорченное значение перезапишем ниже */
    }
  }

  const params = new URLSearchParams(search)
  const utm: Record<string, string> = {}
  for (const key of UTM_KEYS) {
    const value = params.get(`utm_${key}`)
    if (value && value.trim()) utm[key] = value.trim().slice(0, 64)
  }
  // `src` ставим мы сами (QR столов, печать, кнопка на сайте) — он
  // сильнее utm_source, который ставит площадка.
  const src = params.get('src')?.trim().slice(0, 32) || null

  const attribution: Attribution = { src, utm }
  writeStore(ATTR_KEY, JSON.stringify(attribution))
  return attribution
}

/**
 * Отправить шаг. Возврата нет намеренно: вызывающему нечего делать с
 * результатом, а `await` на телеметрии — это задержка гостя ради отчёта.
 */
export function trackReserveStep(
  locId: string,
  step: FunnelStep,
  context: FunnelContext = {},
): void {
  // Ключ дедупликации повторяет серверный: шаг + дата + компания.
  const key = `${step}:${context.wanted_date ?? ''}:${context.party_size ?? ''}`
  if (sent.has(key)) return
  sent.add(key)

  const { src, utm } = captureAttribution(window.location.search)

  void (async () => {
    try {
      const loc = await resolveLocationId(locId)
      await fetch(`${FN_BASE}/public-reserve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
        },
        keepalive: true, // шаг может уходить на самом закрытии вкладки
        body: JSON.stringify({
          action: 'track',
          loc,
          session_id: sessionId(),
          step,
          src,
          utm,
          ...context,
        }),
      })
    } catch {
      // Сеть, офлайн, блокировщик — бронь это не касается.
      sent.delete(key) // следующая попытка того же шага не запрещена
    }
  })()
}

/** Новая заявка после завершённой — новая сессия и чистая воронка. */
export function resetFunnelSession(): void {
  sent.clear()
  writeStore(SESSION_KEY, crypto.randomUUID())
}
