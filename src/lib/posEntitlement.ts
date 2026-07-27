import { supabase } from './supabase'

/**
 * Гейт активации ANGLE POS (Phase 5 product separation → Phase 7 биллинг):
 * касса — потребитель capability `pos_operate`, а не неявный владелец всех
 * продуктов.
 *
 * Состояния вместо булева (108/109):
 *   ok        — оплачено, показывать нечего;
 *   trial     — идёт пробный период;
 *   grace     — оплаченный период кончился, но касса ЖИВА до конца grace:
 *               кофейня не встаёт в утренний пик из-за забытого счёта;
 *   missing   — доступа нет (не активирован / приостановлен) → экран-гейт;
 *   unknown   — офлайн, сбой сети, база до 105/109. НЕ блокирует: POS живёт
 *               по локальному кэшу, настоящая граница — серверные RPC-гейты.
 *
 * trial и grace доступ НЕ блокируют — они только повод показать плашку.
 */
export type PosEntitlementState = 'ok' | 'trial' | 'grace' | 'missing' | 'unknown'

export interface PosEntitlement {
  state: PosEntitlementState
  /** Дней до конца доступа (триал или grace). null — бессрочно/неизвестно */
  daysLeft: number | null
  /** Номер и сумма открытого счёта — чтобы владелец знал, что оплачивать */
  invoiceNumber: string | null
  invoiceTotalAgorot: number | null
}

export const UNKNOWN_ENTITLEMENT: PosEntitlement = {
  state: 'unknown',
  daysLeft: null,
  invoiceNumber: null,
  invoiceTotalAgorot: null,
}

/** За сколько дней до конца доступа показывать плашку в горячем потоке */
export const BILLING_WARN_DAYS = 7

interface BillingProduct {
  product?: string
  state?: string
  access_until?: string | null
}

interface BillingStatePayload {
  products?: BillingProduct[]
  open_invoice?: { number?: string; total_agorot?: number } | null
  min_days_left?: number | null
}

/**
 * Чистая классификация ответа org_billing_state — вынесена из fetch ради
 * юнит-тестов. Смотрим на продукт `pos`: касса не должна блокироваться из-за
 * неоплаченного QR-меню, и наоборот.
 */
export function interpretBillingState(
  data: unknown,
  error: { code?: string } | null,
): PosEntitlement {
  if (error || data === null || typeof data !== 'object') return UNKNOWN_ENTITLEMENT

  const payload = data as BillingStatePayload
  const products = Array.isArray(payload.products) ? payload.products : []
  const pos = products.find((p) => p?.product === 'pos')

  // Подписки на POS нет вовсе — это может быть и «ещё не активировали», и
  // старая база без 108. Решение оставляем серверному гейту: 'unknown' не
  // блокирует, а org_has_capability всё равно не пустит к мутациям.
  if (!pos || typeof pos.state !== 'string') return UNKNOWN_ENTITLEMENT

  const invoice = payload.open_invoice ?? null
  const base = {
    daysLeft: daysUntil(pos.access_until),
    invoiceNumber: typeof invoice?.number === 'string' ? invoice.number : null,
    invoiceTotalAgorot:
      typeof invoice?.total_agorot === 'number' ? invoice.total_agorot : null,
  }

  switch (pos.state) {
    case 'active':
      return { ...base, state: 'ok' }
    case 'trial':
      return { ...base, state: 'trial' }
    case 'grace':
      return { ...base, state: 'grace' }
    case 'suspended':
    case 'canceled':
    case 'none':
      return { ...base, state: 'missing' }
    default:
      return UNKNOWN_ENTITLEMENT
  }
}

/** Целых дней до момента; прошедшее время → 0, отсутствие даты → null */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return null
  return Math.max(0, Math.floor((target - Date.now()) / 86_400_000))
}

/** Показывать ли плашку: только когда до конца доступа осталось мало */
export function shouldWarn(e: PosEntitlement): boolean {
  if (e.state === 'grace') return true
  if (e.state !== 'trial') return false
  return e.daysLeft !== null && e.daysLeft <= BILLING_WARN_DAYS
}

export async function fetchPosEntitlement(): Promise<PosEntitlement> {
  try {
    const { data: sess } = await supabase.auth.getSession()
    if (!sess.session) return UNKNOWN_ENTITLEMENT

    // Ленивая переоценка просрочки (крона нет — 109). Сбой не критичен:
    // гейты 108 сравнивают время сами, поэтому ошибку глотаем молча.
    // rpc() возвращает thenable-builder без .catch — оборачиваем await.
    try {
      await supabase.rpc('refresh_org_subscriptions')
    } catch {
      // база до 109 или офлайн — состояние всё равно читаем ниже
    }

    const { data, error } = await supabase.rpc('org_billing_state', {
      p_location: null,
    })
    return interpretBillingState(data, error)
  } catch {
    return UNKNOWN_ENTITLEMENT
  }
}
