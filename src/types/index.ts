export type TableStatus = 'free' | 'occupied' | 'reserved' | 'waiting_bill'

export type OrderStatus = 'new' | 'cooking' | 'ready' | 'paid'

export type OrderItemStatus = 'pending' | 'cooking' | 'ready' | 'served'

export type PaymentMethod = 'cash' | 'card' | 'split'

export type StaffRole = 'waiter' | 'manager' | 'kitchen'

export interface Table {
  id: string
  number: number
  capacity: number
  status: TableStatus
  zone: string | null
  active_order?: {
    id: string
    created_at: string
    status: string
    total: number
    order_items?: { qty: number; menu_item?: { name: string } }[]
  } | null
}

export interface MenuCategory {
  id: string
  name: string
  sort_order: number
  is_active: boolean
}

export interface MenuItem {
  id: string
  category_id: string
  name: string
  price: number
  description: string | null
  image_url: string | null
  is_available: boolean
  ask_modifiers: boolean
  prep_time_min: number
  category?: MenuCategory
}

export interface Order {
  id: string
  table_id: string
  waiter_id: string
  status: OrderStatus
  created_at: string
  total: number
  customer_name: string | null
  table?: Table
  waiter?: Staff
  order_items?: OrderItem[]
  payments?: Payment[]
}

export interface OrderItemModifier {
  modifier: {
    id: string
    name: string
    price_delta: number
  }
}

export interface OrderItem {
  id: string
  order_id: string
  menu_item_id: string
  qty: number
  price: number
  notes: string | null
  status: OrderItemStatus
  menu_item?: MenuItem
  order_item_modifiers?: OrderItemModifier[]
}

export interface Payment {
  id: string
  order_id: string
  method: PaymentMethod
  amount: number
  created_at: string
}

export interface Staff {
  id: string
  name: string
  role: StaffRole
  pin_code: string
}

export interface Shift {
  id: string
  staff_id: string
  opened_at: string
  closed_at: string | null
  total_revenue: number
  staff?: Staff
}
