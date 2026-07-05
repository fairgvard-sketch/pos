import { supabase } from '../../lib/supabase'
import type { MenuCategory, MenuItem } from '../../types'

export async function fetchMenuCategories(): Promise<MenuCategory[]> {
  const { data, error } = await supabase
    .from('menu_categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order')

  if (error) throw error
  return data as MenuCategory[]
}

export async function fetchMenuItems(): Promise<MenuItem[]> {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*, category:menu_categories(*)')
    .eq('is_available', true)
    .order('name')

  if (error) throw error
  return data as MenuItem[]
}

export async function fetchAllMenuItems(): Promise<MenuItem[]> {
  const { data, error } = await supabase
    .from('menu_items')
    .select('*, category:menu_categories(*)')
    .order('name')

  if (error) throw error
  return data as MenuItem[]
}

export async function updateMenuItem(id: string, updates: Partial<MenuItem>) {
  const { error } = await supabase
    .from('menu_items')
    .update(updates)
    .eq('id', id)
  if (error) throw error
}

export async function createMenuItem(item: Omit<MenuItem, 'id' | 'category'>) {
  const { error } = await supabase.from('menu_items').insert(item)
  if (error) throw error
}

export async function deleteMenuItem(id: string) {
  const { error } = await supabase.from('menu_items').delete().eq('id', id)
  if (error) throw error
}

export async function fetchAllMenuCategories(): Promise<MenuCategory[]> {
  const { data, error } = await supabase
    .from('menu_categories')
    .select('*')
    .order('sort_order')
  if (error) throw error
  return data as MenuCategory[]
}

export async function createMenuCategory(name: string, sort_order: number) {
  const { error } = await supabase
    .from('menu_categories')
    .insert({ name, sort_order, is_active: true })
  if (error) throw error
}

export async function updateMenuCategory(id: string, updates: Partial<MenuCategory>) {
  const { error } = await supabase.from('menu_categories').update(updates).eq('id', id)
  if (error) throw error
}

export async function deleteMenuCategory(id: string) {
  const { error } = await supabase.from('menu_categories').delete().eq('id', id)
  if (error) throw error
}
