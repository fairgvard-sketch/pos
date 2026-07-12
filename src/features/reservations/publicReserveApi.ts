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
    /** Часы приёма (059): обе заданы → слоты ограничены окном. 'HH:MM' */
    open?: string | null
    close?: string | null
    /** Шаг слота времени, мин (по умолчанию 15) */
    slot_min?: number | null
    /** Адрес и телефон из реквизитов чека — кнопки «Навигация»/«Телефон» */
    address?: string | null
    phone?: string | null
    /** Фото-шапка (общая с гостевой страницей заказа) */
    header_url?: string | null
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
}

export interface ReserveResult {
  reservation_id: string
  duplicate: boolean
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
