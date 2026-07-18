import { supabase } from '../../lib/supabase'
import { currentStaffToken } from '../../store/authStore'

/** org_id из JWT — обязателен при прямом INSERT (RLS WITH CHECK) */
async function orgId(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const meta = data.session?.user.app_metadata as Record<string, string | undefined> | undefined
  if (!meta?.org_id) throw new Error('Device not bootstrapped')
  return meta.org_id
}

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

// ── Поставщики (077) ──────────────────────────────────────

export interface Supplier {
  id: string
  name: string
  phone: string | null
  note: string | null
  is_active: boolean
}

/** Активные поставщики, по имени */
export async function fetchSuppliers(): Promise<Supplier[]> {
  const { data, error } = await supabase
    .from('suppliers')
    .select('id, name, phone, note, is_active')
    .eq('is_active', true)
    .order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as Supplier[]
}

/** Завести (id=null) или отредактировать поставщика */
export async function upsertSupplier(
  id: string | null,
  name: string,
  phone: string | null,
  note: string | null = null
): Promise<string> {
  const { data, error } = await supabase.rpc('upsert_supplier', {
    p_id: id,
    p_name: name,
    p_phone: phone,
    p_note: note,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
  return (data as { id: string }).id
}

export async function setSupplierActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_supplier_active', {
    p_id: id,
    p_active: active,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
}

// ── Накладные (077) ───────────────────────────────────────

export interface SupplyDoc {
  id: string
  doc_no: string | null
  note: string | null
  /** Сумма строк, агороты (снапшот на момент проведения) */
  total: number
  created_at: string
  supplier: { name: string } | null
  staff: { name: string } | null
}

export const DOCS_PAGE = 30

/** Страница накладных, свежие сверху */
export async function fetchSupplyDocs(offset: number): Promise<SupplyDoc[]> {
  const { data, error } = await supabase
    .from('supply_docs')
    .select('id, doc_no, note, total, created_at, supplier:suppliers(name), staff(name)')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + DOCS_PAGE - 1)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as SupplyDoc[]
}

export interface DocLine {
  id: string
  name: string
  qty_delta: number
  unit_cost: number | null
  value: number | null
  supply_item_id: string | null
  menu_item_id: string | null
}

/** Строки накладной — строки журнала её batch_id */
export async function fetchDocLines(docId: string): Promise<DocLine[]> {
  const { data, error } = await supabase
    .from('stock_movements')
    .select('id, name, qty_delta, unit_cost, value, supply_item_id, menu_item_id')
    .eq('batch_id', docId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as DocLine[]
}

// ── Фасовки (077) ─────────────────────────────────────────

export interface Packaging {
  id: string
  supply_item_id: string
  /** «Мешок 25 кг» */
  name: string
  /** Базовых единиц в фасовке: 25000 г */
  qty: number
}

export async function fetchPackagings(): Promise<Packaging[]> {
  const { data, error } = await supabase
    .from('supply_packagings')
    .select('id, supply_item_id, name, qty')
    .order('qty')
  if (error) throw new Error(error.message)
  return (data ?? []) as Packaging[]
}

export async function addPackaging(supplyItemId: string, name: string, qty: number): Promise<void> {
  const org_id = await orgId()
  const { error } = await supabase
    .from('supply_packagings')
    .insert({ org_id, supply_item_id: supplyItemId, name, qty })
  if (error) throw new Error(error.message)
}

export async function deletePackaging(id: string): Promise<void> {
  const { error } = await supabase.from('supply_packagings').delete().eq('id', id)
  if (error) throw new Error(error.message)
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
  /** Установить себестоимость ТОЧНО в unit_cost (иначе — средневзвешенная) */
  update_cost?: boolean
}

export async function receiveStock(
  staffId: string,
  items: ReceiveItem[],
  note: string,
  supplierId: string | null = null,
  docNo: string = '',
  /** UUID документа: создаётся до первой попытки, повтор идемпотентен */
  docId: string | null = null
): Promise<void> {
  const { error } = await supabase.rpc('receive_stock', {
    p_staff_id: staffId,
    p_items: items,
    p_note: note.trim() || null,
    p_staff_session: currentStaffToken(),
    p_supplier_id: supplierId,
    p_doc_no: docNo.trim() || null,
    p_doc_id: docId,
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

/** Итог расхождения инвентаризации по себестоимости, агороты (079) */
export interface StockTakeResult {
  shortage_value: number
  surplus_value: number
}

export async function stockTake(
  staffId: string,
  items: CountItem[],
  note: string
): Promise<StockTakeResult> {
  const { data, error } = await supabase.rpc('stock_take', {
    p_staff_id: staffId,
    p_items: items,
    p_note: note.trim() || null,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw new Error(error.message)
  const d = data as { shortage_value?: number; surplus_value?: number } | null
  return { shortage_value: d?.shortage_value ?? 0, surplus_value: d?.surplus_value ?? 0 }
}

// ── Сводка за период (stock_report) ───────────────────────

export interface StockReportRow {
  menu_item_id: string | null
  supply_item_id: string | null
  kind: StockKind
  name: string
  unit: string | null
  /** Остаток на начало периода (якорь по журналу, 078) */
  opening: number
  sold: number
  returned: number
  waste: number
  received: number
  count_adj: number
  /** Число инвентаризационных строк периода (085): 0 = позицию не проверяли */
  counts?: number
  /** Деньги движений за период, агороты (снапшоты value, 077) */
  sold_value: number
  returned_value: number
  waste_value: number
  received_value: number
  count_value: number
  /** Остаток на конец периода */
  closing: number
  /** Конечный остаток × текущая себестоимость; null = cost не задан */
  closing_value: number | null
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
