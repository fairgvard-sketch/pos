import type { CartMod } from '../store/cartStore'
import { normalizeCourse } from '../features/sell/courses'

/**
 * Черновик заказа стола на телефоне официанта (180).
 *
 * Отправка без сети не копится в фоне: отправляемые строки «замораживаются»
 * вместе с op_uuid ДО первой попытки. Повтор шлёт ровно их и с тем же
 * op_uuid — сервер (op_log) не задвоит, если первая попытка всё же дошла.
 * Новые блюда тем временем копятся в обычном черновике отдельно.
 * Сервер явно отказал (стоп-лист, смена закрыта) — ничего не записано,
 * замороженное возвращается в черновик для правки.
 */

export interface DraftLine {
  key: string
  itemId: string
  name: string
  variantId: string | null
  variantName: string | null
  basePrice: number
  mods: CartMod[]
  qty: number
  notes: string
  /** Курс подачи 1–3, null — без курса (уходит сразу) */
  course: number | null
}

export interface FrozenLine extends DraftLine {
  /** id строки заказа, выданный телефоном до первой попытки */
  lineId: string
}

export interface PendingSend {
  opUuid: string
  lines: FrozenLine[]
  at: string
}

export interface TableDraft {
  lines: DraftLine[]
  pending: PendingSend | null
}

export const EMPTY_DRAFT: TableDraft = { lines: [], pending: null }

export type NewLine = Omit<DraftLine, 'key' | 'qty'>

export function unitPrice(l: Pick<DraftLine, 'basePrice' | 'mods'>): number {
  return l.basePrice + l.mods.reduce((s, m) => s + m.priceDelta, 0)
}

export function linesTotal(lines: DraftLine[]): number {
  return lines.reduce((s, l) => s + unitPrice(l) * l.qty, 0)
}

export function linesCount(lines: DraftLine[]): number {
  return lines.reduce((s, l) => s + l.qty, 0)
}

function modsKey(mods: CartMod[]): string {
  return mods.map((m) => m.id).sort().join(',')
}

/** Одинаковые конфигурации схлопываются в qty — как в корзине кассы */
export function sameConfig(a: NewLine, b: NewLine): boolean {
  return (
    a.itemId === b.itemId &&
    a.variantId === b.variantId &&
    a.notes.trim() === b.notes.trim() &&
    normalizeCourse(a.course) === normalizeCourse(b.course) &&
    modsKey(a.mods) === modsKey(b.mods)
  )
}

export function addLine(lines: DraftLine[], line: NewLine, key: string): DraftLine[] {
  const existing = lines.find((l) => sameConfig(l, line))
  if (existing) return lines.map((l) => (l.key === existing.key ? { ...l, qty: l.qty + 1 } : l))
  return [...lines, { ...line, course: normalizeCourse(line.course), notes: line.notes.trim(), key, qty: 1 }]
}

export function setQty(lines: DraftLine[], key: string, qty: number): DraftLine[] {
  if (qty <= 0) return lines.filter((l) => l.key !== key)
  return lines.map((l) => (l.key === key ? { ...l, qty: Math.min(qty, 99) } : l))
}

export function patchLine(lines: DraftLine[], key: string, patch: Partial<NewLine>): DraftLine[] {
  // «Без курса» — это null, а не отсутствие ключа: `??` вернул бы старый
  // курс, и чип застревал на 3 вместо круга 1 → 2 → 3 → без курса → 1
  return lines.map((l) => (l.key === key
    ? { ...l, ...patch, course: normalizeCourse('course' in patch ? patch.course : l.course) }
    : l))
}

/** Заморозить черновик к отправке: id строк и ключ операции — до первой попытки */
export function freeze(lines: DraftLine[], uuid: () => string, now = new Date()): PendingSend {
  return {
    opUuid: uuid(),
    lines: lines.map((l) => ({ ...l, lineId: uuid() })),
    at: now.toISOString(),
  }
}

/** Сервер отказал явно — вернуть замороженное в черновик (новые блюда сохраняются) */
export function unfreeze(draft: TableDraft): TableDraft {
  if (!draft.pending) return draft
  let lines = draft.pending.lines.map(({ lineId: _lineId, ...l }) => l as DraftLine)
  for (const l of draft.lines) {
    const same = lines.find((x) => sameConfig(x, l))
    lines = same ? lines.map((x) => (x === same ? { ...x, qty: x.qty + l.qty } : x)) : [...lines, l]
  }
  return { lines, pending: null }
}

/** p_items для waiter_send: только каталог, без цен — цену считает сервер */
export function sendItems(p: PendingSend) {
  return p.lines.map((l) => ({
    id: l.lineId,
    menu_item_id: l.itemId,
    variant_id: l.variantId,
    modifier_ids: l.mods.map((m) => m.id),
    qty: l.qty,
    notes: l.notes,
    course: normalizeCourse(l.course),
  }))
}
