import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'

/** Вид складской позиции: товар меню или расходник (стаканы, упаковка) */
export type StockKind = 'menu' | 'supply'

// ── Единицы измерения (076) ───────────────────────────────
// Ингредиенты ведутся в БАЗОВЫХ единицах (г/мл) целыми числами — как
// деньги в агоротах. Конвенция стоимости: для г/мл supply_items.cost —
// агороты за 1000 базовых единиц (кг/л); для штучных — за единицу.

/** Канонические единицы для select'ов (хранятся как есть) */
export const SUPPLY_UNITS = ['шт', 'г', 'мл'] as const

export function isFractionalUnit(unit: string | null): boolean {
  return unit === 'г' || unit === 'мл'
}

/** Цена за 1000 базовых единиц? (конвенция cost для г/мл) */
export function costDivisor(unit: string | null): number {
  return isFractionalUnit(unit) ? 1000 : 1
}

// ── Расходники (056) ──────────────────────────────────────

export interface SupplyItem {
  id: string
  name: string
  unit: string | null
  stock: number
  cost: number | null
  sku: string | null
  is_active: boolean
}

/** Активные расходники точки, по имени */
export async function fetchSupplyItems(): Promise<SupplyItem[]> {
  const { data, error } = await supabase
    .from('supply_items')
    .select('id, name, unit, stock, cost, sku, is_active')
    .eq('is_active', true)
    .order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as SupplyItem[]
}

/** Завести (p_id=null) или переименовать расходник. Остаток/cost — не здесь. */
export async function upsertSupplyItem(
  id: string | null,
  name: string,
  unit: string | null,
  sku: string | null
): Promise<string> {
  const { data, error } = await supabase.rpc('upsert_supply_item', {
    p_id: id,
    p_name: name,
    p_unit: unit,
    p_sku: sku,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
  return (data as { id: string }).id
}

export async function setSupplyItemActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_supply_item_active', {
    p_id: id,
    p_active: active,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

// ── Журнал движения остатков (055 + 056) ──────────────────

export type MovementType = 'sale' | 'void' | 'split' | 'waste' | 'receive' | 'count'

export interface StockMovement {
  id: string
  type: MovementType
  name: string
  qty_delta: number
  stock_after: number
  unit_cost: number | null
  note: string | null
  batch_id: string | null
  created_at: string
  supply_item_id: string | null
  staff: { name: string } | null
  order: { daily_number: number } | null
}

export const MOVEMENTS_PAGE = 50

/** Страница журнала, свежие сверху. offset — сколько строк уже показано. */
export async function fetchStockMovements(offset: number): Promise<StockMovement[]> {
  const { data, error } = await supabase
    .from('stock_movements')
    .select('id, type, name, qty_delta, stock_after, unit_cost, note, batch_id, created_at, supply_item_id, staff(name), order:orders(daily_number)')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + MOVEMENTS_PAGE - 1)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as StockMovement[]
}

// ── Приход (receive_stock) ────────────────────────────────

export interface ReceiveItem {
  kind: StockKind
  /** menu_item_id при kind='menu', supply_item_id при kind='supply' */
  menu_item_id?: string
  supply_item_id?: string
  qty: number
  /** Закупочная цена/ед, агороты (снапшот в журнал) */
  unit_cost?: number | null
  /** Перенести unit_cost в себестоимость позиции */
  update_cost?: boolean
}

export async function receiveStock(
  staffId: string,
  items: ReceiveItem[],
  note: string
): Promise<void> {
  const { error } = await supabase.rpc('receive_stock', {
    p_staff_id: staffId,
    p_items: items,
    p_note: note.trim() || null,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

// ── Инвентаризация (stock_take) ───────────────────────────

export interface CountItem {
  kind: StockKind
  menu_item_id?: string
  supply_item_id?: string
  counted: number
}

export async function stockTake(
  staffId: string,
  items: CountItem[],
  note: string
): Promise<void> {
  const { error } = await supabase.rpc('stock_take', {
    p_staff_id: staffId,
    p_items: items,
    p_note: note.trim() || null,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

// ── Сводка за период (stock_report) ───────────────────────

export interface StockReportRow {
  menu_item_id: string | null
  supply_item_id: string | null
  kind: StockKind
  name: string
  unit: string | null
  sold: number
  returned: number
  waste: number
  received: number
  count_adj: number
  /** Текущий остаток; null = позиция удалена или учёт выключен */
  stock_now: number | null
}

export async function fetchStockReport(from: Date, to: Date): Promise<StockReportRow[]> {
  const { data, error } = await supabase.rpc('stock_report', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  })
  if (error) throw new Error(error.message)
  return ((data as { items?: StockReportRow[] } | null)?.items ?? [])
}
