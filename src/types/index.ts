export type Role = 'owner' | 'manager' | 'barista'

export interface Org {
  id: string
  name: string
  created_at: string
}

export interface Location {
  id: string
  org_id: string
  name: string
  currency: string
  vat_rate: number
  timezone: string
  created_at: string
}

export interface Device {
  id: string
  org_id: string
  location_id: string
  name: string
  registered_at: string
  last_seen_at: string | null
}

/** Сотрудник — pin_hash никогда не приходит на клиент (колоночные гранты) */
export interface Staff {
  id: string
  org_id: string
  location_id: string | null
  name: string
  role: Role
  is_active: boolean
  created_at: string
}

/** Результат verify_staff_pin() */
export interface StaffSession {
  id: string
  name: string
  role: Role
  location_id: string | null
}

// ── Каталог ──────────────────────────────────────────────
// Все цены — целые агороты (см. lib/money.ts)

export interface Station {
  id: string
  org_id: string
  location_id: string
  name: string
  sort_order: number
}

export interface MenuCategory {
  id: string
  org_id: string
  location_id: string
  name: string
  sort_order: number
  is_active: boolean
}

export interface MenuItem {
  id: string
  org_id: string
  category_id: string
  station_id: string | null
  name: string
  price: number
  image_url: string | null
  is_available: boolean
  ask_modifiers: boolean
  sort_order: number
  item_variants?: ItemVariant[]
  menu_item_modifier_groups?: { group_id: string; sort_order: number }[]
}

export interface ItemVariant {
  id: string
  org_id: string
  item_id: string
  name: string
  price: number
  is_default: boolean
  sort_order: number
}

export interface ModifierGroup {
  id: string
  org_id: string
  name: string
  min_select: number
  max_select: number
  sort_order: number
  modifiers?: Modifier[]
}

export interface Modifier {
  id: string
  org_id: string
  group_id: string
  name: string
  price_delta: number
  is_default: boolean
  is_available: boolean
  sort_order: number
}
