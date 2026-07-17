import { supabase } from '../../lib/supabase'
import { compressImage } from '../../lib/imageCompress'
import { currentStaffToken } from '../../store/authStore'
import type { MenuCategory, MenuItem, ModifierGroup, Modifier, Station } from '../../types'

/** org_id/location_id из JWT — обязательны при INSERT (RLS WITH CHECK) */
async function ctx(): Promise<{ org_id: string; location_id: string }> {
  const { data } = await supabase.auth.getSession()
  const meta = data.session?.user.app_metadata as Record<string, string | undefined> | undefined
  if (!meta?.org_id || !meta?.location_id) throw new Error('Device not bootstrapped')
  return { org_id: meta.org_id, location_id: meta.location_id }
}

// ── Категории ────────────────────────────────────────────

export async function fetchCategories(): Promise<MenuCategory[]> {
  const { data, error } = await supabase
    .from('menu_categories')
    .select('*')
    .order('sort_order')
  if (error) throw error
  return data as MenuCategory[]
}

export async function createCategory(name: string, sortOrder: number, icon: string | null = null): Promise<MenuCategory> {
  const { org_id, location_id } = await ctx()
  const { data, error } = await supabase
    .from('menu_categories')
    .insert({ org_id, location_id, name, icon, sort_order: sortOrder })
    .select()
    .single()
  if (error) throw error
  return data as MenuCategory
}

export async function updateCategory(id: string, patch: Partial<Pick<MenuCategory, 'name' | 'icon' | 'cover_url' | 'sort_order' | 'is_active' | 'loyalty_stamps'>>) {
  const { error } = await supabase.from('menu_categories').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteCategory(id: string) {
  const { error } = await supabase.from('menu_categories').delete().eq('id', id)
  if (error) throw error
}

/**
 * Новый порядок категорий одним атомарным RPC (064, P8): раньше серия
 * независимых UPDATE (Promise.all) — частичный сбой оставлял смешанный
 * порядок. Теперь reorder_menu переставляет всё в одной транзакции.
 */
export async function reorderCategories(orderedIds: string[]) {
  const { error } = await supabase.rpc('reorder_menu', {
    p_kind: 'category',
    p_ids: orderedIds,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw error
}

// ── Товары ───────────────────────────────────────────────

export async function fetchItems(): Promise<MenuItem[]> {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*, item_variants (*), menu_item_modifier_groups (group_id, sort_order), variant_supplies (id, variant_id, supply_item_id, qty, takeaway_only)')
    .order('sort_order')
  if (error) throw error
  return data as MenuItem[]
}

export interface ItemInput {
  name: string
  description: string | null
  category_id: string
  station_id: string | null
  price: number
  image_url: string | null
  is_available: boolean
  is_favorite: boolean
  ask_modifiers: boolean
  cost: number | null
  sku: string | null
  track_inventory: boolean
  stock: number | null
  variants: { id?: string; name: string; price: number; is_default: boolean }[]
  modifier_group_ids: string[]
  /** Упаковка (075): variant_index — позиция в variants, null = весь товар */
  supplies: { variant_index: number | null; supply_item_id: string; qty: number; takeaway_only: boolean }[]
}

/** Загрузка фото товара в Storage → публичный URL. Сжимаем на клиенте
 *  (тяжёлые фото с телефона тормозят слабый WebView T2). Имя файла
 *  уникально → кэшируем на год (иммутабельно). */
export async function uploadItemImage(file: File): Promise<string> {
  const { org_id } = await ctx()
  const compressed = await compressImage(file)
  const ext = compressed.type === 'image/jpeg'
    ? 'jpg'
    : compressed.name.split('.').pop()?.toLowerCase() || 'jpg'
  const path = `${org_id}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('menu-images').upload(path, compressed, {
    cacheControl: '31536000',
    contentType: compressed.type,
    upsert: false,
  })
  if (error) throw new Error(error.message)
  return supabase.storage.from('menu-images').getPublicUrl(path).data.publicUrl
}

/** Поля товара для RPC save_menu_item (064). Пустые числа/строки — как есть. */
function itemPayload(input: ItemInput): Record<string, unknown> {
  return {
    name: input.name,
    description: input.description,
    category_id: input.category_id,
    station_id: input.station_id,
    price: input.price,
    image_url: input.image_url,
    is_available: input.is_available,
    is_favorite: input.is_favorite,
    ask_modifiers: input.ask_modifiers,
    cost: input.cost,
    sku: input.sku,
    track_inventory: input.track_inventory,
    stock: input.stock,
  }
}

/**
 * Создать товар транзакционно (064, P8): товар + варианты + привязки групп
 * одной RPC — частичный сбой откатывает целиком (раньше INSERT товара и
 * DELETE/INSERT связей были разными запросами → риск битого товара).
 */
export async function createItem(input: ItemInput): Promise<string> {
  const { data, error } = await supabase.rpc('save_menu_item', {
    p_item: itemPayload(input),
    p_variants: input.variants.map((v) => ({ name: v.name, price: v.price, is_default: v.is_default })),
    p_group_ids: input.modifier_group_ids,
    p_item_id: null,
    p_staff_session: currentStaffToken(),
    p_supplies: input.supplies,
  })
  if (error) throw error
  return data as string
}

/** Обновить товар транзакционно (064, P8) — см. createItem */
export async function updateItem(id: string, input: ItemInput) {
  const { error } = await supabase.rpc('save_menu_item', {
    p_item: itemPayload(input),
    p_variants: input.variants.map((v) => ({ name: v.name, price: v.price, is_default: v.is_default })),
    p_group_ids: input.modifier_group_ids,
    p_item_id: id,
    p_staff_session: currentStaffToken(),
    p_supplies: input.supplies,
  })
  if (error) throw error
}

/**
 * Новый порядок товаров одним атомарным RPC (064, P8) — см. reorderCategories.
 */
export async function reorderItems(orderedIds: string[]) {
  const { error } = await supabase.rpc('reorder_menu', {
    p_kind: 'item',
    p_ids: orderedIds,
    p_staff_session: currentStaffToken(),
  })
  if (error) throw error
}

export async function toggleItemAvailability(id: string, isAvailable: boolean) {
  const { error } = await supabase.from('menu_items').update({ is_available: isAvailable }).eq('id', id)
  if (error) throw error
}

export async function toggleItemFavorite(id: string, isFavorite: boolean) {
  const { error } = await supabase.from('menu_items').update({ is_favorite: isFavorite }).eq('id', id)
  if (error) throw error
}

export async function deleteItem(id: string) {
  const { error } = await supabase.from('menu_items').delete().eq('id', id)
  if (error) throw error
}

// ── Модификаторы ─────────────────────────────────────────

export async function fetchModifierGroups(): Promise<ModifierGroup[]> {
  const { data, error } = await supabase
    .from('modifier_groups')
    .select('*, modifiers (*)')
    .order('sort_order')
  if (error) throw error
  const groups = data as ModifierGroup[]
  groups.forEach((g) => g.modifiers?.sort((a, b) => a.sort_order - b.sort_order))
  return groups
}

export async function createModifierGroup(name: string, minSelect: number, maxSelect: number): Promise<ModifierGroup> {
  const { org_id } = await ctx()
  const { data, error } = await supabase
    .from('modifier_groups')
    .insert({ org_id, name, min_select: minSelect, max_select: maxSelect })
    .select()
    .single()
  if (error) throw error
  return data as ModifierGroup
}

export async function updateModifierGroup(id: string, patch: Partial<Pick<ModifierGroup, 'name' | 'min_select' | 'max_select'>>) {
  const { error } = await supabase.from('modifier_groups').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteModifierGroup(id: string) {
  const { error } = await supabase.from('modifier_groups').delete().eq('id', id)
  if (error) throw error
}

export async function createModifier(groupId: string, name: string, priceDelta: number, isDefault: boolean): Promise<Modifier> {
  const { org_id } = await ctx()
  const { data, error } = await supabase
    .from('modifiers')
    .insert({ org_id, group_id: groupId, name, price_delta: priceDelta, is_default: isDefault })
    .select()
    .single()
  if (error) throw error
  return data as Modifier
}

export async function updateModifier(id: string, patch: Partial<Pick<Modifier, 'name' | 'price_delta' | 'is_default' | 'is_available'>>) {
  const { error } = await supabase.from('modifiers').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteModifier(id: string) {
  const { error } = await supabase.from('modifiers').delete().eq('id', id)
  if (error) throw error
}

// ── Расход модификаторов (076) ───────────────────────────
// Сироп 20 мл, доп. шот 9 г зерна, овсяное молоко 180 мл. Дефолтные
// модификаторы попадают в заказ автоматически, поэтому замена молока —
// это расход на модификаторах группы «Молоко», не в рецепте товара.

export interface ModifierSupply {
  id: string
  modifier_id: string
  supply_item_id: string
  /** В базовых единицах расходника (шт/г/мл) за единицу товара */
  qty: number
}

export async function fetchModifierSupplies(): Promise<ModifierSupply[]> {
  const { data, error } = await supabase
    .from('modifier_supplies')
    .select('id, modifier_id, supply_item_id, qty')
  if (error) throw error
  return data as ModifierSupply[]
}

/** Полная пересинхронизация расхода одного модификатора (каталог — не финансы) */
export async function replaceModifierSupplies(
  modifierId: string,
  links: { supply_item_id: string; qty: number }[]
): Promise<void> {
  const { org_id } = await ctx()
  const del = await supabase.from('modifier_supplies').delete().eq('modifier_id', modifierId)
  if (del.error) throw del.error
  if (links.length === 0) return
  const { error } = await supabase.from('modifier_supplies').insert(
    links.map((l) => ({ org_id, modifier_id: modifierId, supply_item_id: l.supply_item_id, qty: l.qty }))
  )
  if (error) throw error
}

/** Сколько товаров использует каждую группу: { group_id: count } */
export async function fetchModifierGroupUsage(): Promise<Record<string, number>> {
  const { data, error } = await supabase.from('menu_item_modifier_groups').select('group_id')
  if (error) throw error
  const usage: Record<string, number> = {}
  for (const row of data as { group_id: string }[]) {
    usage[row.group_id] = (usage[row.group_id] ?? 0) + 1
  }
  return usage
}

// ── Станции ──────────────────────────────────────────────

export async function fetchStations(): Promise<Station[]> {
  const { data, error } = await supabase.from('stations').select('*').order('sort_order')
  if (error) throw error
  return data as Station[]
}

export async function createStation(name: string): Promise<Station> {
  const { org_id, location_id } = await ctx()
  const { data, error } = await supabase
    .from('stations')
    .insert({ org_id, location_id, name })
    .select()
    .single()
  if (error) throw error
  return data as Station
}

export async function updateStation(id: string, name: string) {
  const { error } = await supabase.from('stations').update({ name }).eq('id', id)
  if (error) throw error
}

export async function deleteStation(id: string) {
  const { error } = await supabase.from('stations').delete().eq('id', id)
  if (error) throw error
}
