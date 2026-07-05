import { supabase } from '../../lib/supabase'
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

export async function createCategory(name: string, sortOrder: number): Promise<MenuCategory> {
  const { org_id, location_id } = await ctx()
  const { data, error } = await supabase
    .from('menu_categories')
    .insert({ org_id, location_id, name, sort_order: sortOrder })
    .select()
    .single()
  if (error) throw error
  return data as MenuCategory
}

export async function updateCategory(id: string, patch: Partial<Pick<MenuCategory, 'name' | 'sort_order' | 'is_active'>>) {
  const { error } = await supabase.from('menu_categories').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteCategory(id: string) {
  const { error } = await supabase.from('menu_categories').delete().eq('id', id)
  if (error) throw error
}

// ── Товары ───────────────────────────────────────────────

export async function fetchItems(): Promise<MenuItem[]> {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*, item_variants (*), menu_item_modifier_groups (group_id, sort_order)')
    .order('sort_order')
  if (error) throw error
  return data as MenuItem[]
}

export interface ItemInput {
  name: string
  category_id: string
  station_id: string | null
  price: number
  is_available: boolean
  ask_modifiers: boolean
  variants: { id?: string; name: string; price: number; is_default: boolean }[]
  modifier_group_ids: string[]
}

export async function createItem(input: ItemInput): Promise<string> {
  const { org_id } = await ctx()
  const { data, error } = await supabase
    .from('menu_items')
    .insert({
      org_id,
      name: input.name,
      category_id: input.category_id,
      station_id: input.station_id,
      price: input.price,
      is_available: input.is_available,
      ask_modifiers: input.ask_modifiers,
    })
    .select('id')
    .single()
  if (error) throw error
  await syncItemRelations(data.id, input, org_id)
  return data.id
}

export async function updateItem(id: string, input: ItemInput) {
  const { org_id } = await ctx()
  const { error } = await supabase
    .from('menu_items')
    .update({
      name: input.name,
      category_id: input.category_id,
      station_id: input.station_id,
      price: input.price,
      is_available: input.is_available,
      ask_modifiers: input.ask_modifiers,
    })
    .eq('id', id)
  if (error) throw error
  await syncItemRelations(id, input, org_id)
}

/** Варианты и привязки групп: полная пересинхронизация (каталог — не финансовые данные, тут можно) */
async function syncItemRelations(itemId: string, input: ItemInput, orgId: string) {
  const { error: delVar } = await supabase.from('item_variants').delete().eq('item_id', itemId)
  if (delVar) throw delVar
  if (input.variants.length > 0) {
    const { error } = await supabase.from('item_variants').insert(
      input.variants.map((v, i) => ({
        org_id: orgId,
        item_id: itemId,
        name: v.name,
        price: v.price,
        is_default: v.is_default,
        sort_order: i,
      }))
    )
    if (error) throw error
  }

  const { error: delMg } = await supabase.from('menu_item_modifier_groups').delete().eq('item_id', itemId)
  if (delMg) throw delMg
  if (input.modifier_group_ids.length > 0) {
    const { error } = await supabase.from('menu_item_modifier_groups').insert(
      input.modifier_group_ids.map((group_id, i) => ({
        org_id: orgId,
        item_id: itemId,
        group_id,
        sort_order: i,
      }))
    )
    if (error) throw error
  }
}

export async function toggleItemAvailability(id: string, isAvailable: boolean) {
  const { error } = await supabase.from('menu_items').update({ is_available: isAvailable }).eq('id', id)
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
