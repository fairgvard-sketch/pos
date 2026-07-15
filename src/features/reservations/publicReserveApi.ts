/**
 * Клиент публичного API брони (053) для страницы гостя /reserve/:locId.
 * Ходит ТОЛЬКО в Edge Function public-reserve с anon-ключом —
 * прямого доступа к таблицам у гостя нет, всё решает сервер.
 */

import { parseError } from '../online/publicApi'

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

const headers = {
  'Content-Type': 'application/json',
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
}

export interface ReserveInfo {
  location: {
    id: string
    name: string
    /** Название заведения (шапка чека); показываем его, не имя точки */
    business_name?: string
    logo_url?: string | null
    /** false = владелец не включил приём броней (тумблер 053, default off) */
    accepting: boolean
    /** instant-режим (063): гость видит live-доступность и бронь
     *  подтверждается сразу. false → прежний флоу заявка→касса. */
    instant?: boolean
    /** Часы приёма (059): обе заданы → слоты ограничены окном. 'HH:MM' */
    open?: string | null
    close?: string | null
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
  }
}

export async function fetchReserveInfo(locId: string): Promise<ReserveInfo> {
  const res = await fetch(`${FN_BASE}/public-reserve?loc=${encodeURIComponent(locId)}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}

export interface ReservePayload {
  loc: string
  client_uuid: string
  name: string
  phone: string
  party_size: number
  reserved_at: string // ISO
  note: string | null
  /** Пожелание зоны зала (072); null = без предпочтений */
  zone_id: string | null
}

export interface ReserveResult {
  reservation_id: string
  duplicate: boolean
  /** instant-режим (063): бронь сразу confirmed; иначе 'new' (заявка) */
  status?: 'new' | 'confirmed'
  deposit_status?: 'none' | 'required' | 'paid' | 'refunded' | 'forfeited'
  deposit_amount?: number
}

/** Слот дня с признаком доступности (063, instant-режим) */
export interface AvailSlot {
  time: string // 'HH:MM'
  free: boolean
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
  const qs = new URLSearchParams({ loc: locId, date, party: String(party) })
  if (zoneId) qs.set('zone', zoneId)
  const res = await fetch(`${FN_BASE}/public-reserve?${qs}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}

export async function submitPublicReservation(payload: ReservePayload): Promise<ReserveResult> {
  const res = await fetch(`${FN_BASE}/public-reserve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'submit', ...payload }),
  })
  if (!res.ok) await parseError(res)
  return res.json()
}

export interface ReserveStatus {
  status: 'new' | 'confirmed' | 'rejected' | 'cancelled'
  reject_reason: string | null
  reserved_at: string
  party_size: number
  customer_name: string
  /** Метка назначенного стола (если касса выбрала) */
  table_label: string | null
  /** Выбранная гостем зона зала (072); null = не выбирал */
  zone_name: string | null
  created_at: string
}

export async function fetchPublicReservationStatus(clientUuid: string): Promise<ReserveStatus> {
  const res = await fetch(`${FN_BASE}/public-reserve?id=${encodeURIComponent(clientUuid)}`, { headers })
  if (!res.ok) await parseError(res)
  return res.json()
}

export async function cancelPublicReservation(clientUuid: string): Promise<{ status: string }> {
  const res = await fetch(`${FN_BASE}/public-reserve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'cancel', client_uuid: clientUuid }),
  })
  if (!res.ok) await parseError(res)
  return res.json()
}
