import { supabase } from '../../lib/supabase'

export interface ModifierGroup {
  id: string
  name: string
  required: boolean
  multi: boolean
  modifiers: Modifier[]
}

export interface Modifier {
  id: string
  group_id: string
  name: string
  price_delta: number
}

export async function fetchModifierGroupsForItem(menuItemId: string): Promise<ModifierGroup[]> {
  const { data, error } = await supabase
    .from('menu_item_modifier_groups')
    .select(`
      group_id,
      modifier_groups (
        id, name, required, multi,
        modifiers (id, group_id, name, price_delta)
      )
    `)
    .eq('menu_item_id', menuItemId)

  if (error) throw error

  return (data ?? []).map((row: any) => row.modifier_groups) as ModifierGroup[]
}

// Fetch all modifier groups (for the manager editor)
export async function fetchAllModifierGroups(): Promise<ModifierGroup[]> {
  const { data, error } = await supabase
    .from('modifier_groups')
    .select('id, name, required, multi, modifiers (id, group_id, name, price_delta)')
    .order('name')
  if (error) throw error
  return (data ?? []) as ModifierGroup[]
}

// Create a modifier group and immediately link it to a menu item
export async function createModifierGroup(
  menuItemId: string,
  name: string,
  required: boolean,
  multi: boolean,
): Promise<ModifierGroup> {
  const { data, error } = await supabase
    .from('modifier_groups')
    .insert({ name, required, multi })
    .select()
    .single()
  if (error) throw error
  const group = data as ModifierGroup

  await supabase.from('menu_item_modifier_groups').insert({
    menu_item_id: menuItemId,
    group_id: group.id,
  })

  return { ...group, modifiers: [] }
}

export async function updateModifierGroup(
  groupId: string,
  updates: { name?: string; required?: boolean; multi?: boolean },
) {
  const { error } = await supabase.from('modifier_groups').update(updates).eq('id', groupId)
  if (error) throw error
}

export async function deleteModifierGroup(groupId: string) {
  const { error } = await supabase.from('modifier_groups').delete().eq('id', groupId)
  if (error) throw error
}

// Unlink a group from an item (without deleting the group itself)
export async function unlinkModifierGroup(menuItemId: string, groupId: string) {
  const { error } = await supabase
    .from('menu_item_modifier_groups')
    .delete()
    .eq('menu_item_id', menuItemId)
    .eq('group_id', groupId)
  if (error) throw error
}

export async function createModifier(groupId: string, name: string, price_delta: number): Promise<Modifier> {
  const { data, error } = await supabase
    .from('modifiers')
    .insert({ group_id: groupId, name, price_delta })
    .select()
    .single()
  if (error) throw error
  return data as Modifier
}

export async function updateModifier(modifierId: string, updates: { name?: string; price_delta?: number }) {
  const { error } = await supabase.from('modifiers').update(updates).eq('id', modifierId)
  if (error) throw error
}

export async function deleteModifier(modifierId: string) {
  const { error } = await supabase.from('modifiers').delete().eq('id', modifierId)
  if (error) throw error
}

export async function saveOrderItemModifiers(orderItemId: string, modifierIds: string[]) {
  if (modifierIds.length === 0) return

  const { error } = await supabase.from('order_item_modifiers').insert(
    modifierIds.map((modifier_id) => ({ order_item_id: orderItemId, modifier_id }))
  )
  if (error) throw error
}

// Replace all modifiers for an existing order item
export async function updateOrderItemModifiers(orderItemId: string, modifierIds: string[]) {
  const { error: delErr } = await supabase
    .from('order_item_modifiers')
    .delete()
    .eq('order_item_id', orderItemId)
  if (delErr) throw delErr

  if (modifierIds.length > 0) {
    const { error } = await supabase.from('order_item_modifiers').insert(
      modifierIds.map((modifier_id) => ({ order_item_id: orderItemId, modifier_id }))
    )
    if (error) throw error
  }
}
