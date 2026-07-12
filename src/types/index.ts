export type Role = 'owner' | 'manager' | 'barista'

export interface Org {
  id: string
  name: string
  created_at: string
}

export type ServiceMode = 'counter' | 'counter_tables' | 'tables'

/** Кто может выполнять действие: все сотрудники или только manager+owner */
export type PermLevel = 'all' | 'manager'

/**
 * Мелкие настройки точки — jsonb locations.settings (миграция 036).
 * Все ключи опциональны: отсутствие = дефолт (см. src/lib/perms.ts).
 */
export interface LocationSettings {
  /**
   * Отображаемое имя заведения (052): карточка в настройках и заголовок
   * гостевой страницы. НЕ влияет на шапку чека — там receipt_business_name.
   */
  display_name?: string | null
  perms?: {
    discount?: PermLevel
    price_edit?: PermLevel
    refund?: PermLevel
    void_order?: PermLevel
    close_shift?: PermLevel
    cash_movement?: PermLevel
    /** Пауза онлайн-заказов и время приготовления (054) */
    online_pause?: PermLevel
    /** Приход товара (055) */
    stock_receive?: PermLevel
    /** Инвентаризация (055) */
    stock_take?: PermLevel
  }
  receipt?: {
    print_modifiers?: boolean
    copies?: 1 | 2
  }
  shift?: {
    /** Стартовая сумма в кассе по умолчанию, агороты (префилл при открытии смены) */
    default_opening_float?: number | null
    /** Напоминание о закрытии смены, 'HH:MM' локального времени */
    close_reminder?: string | null
    /** Порог предупреждения «много наличных в кассе», агороты */
    cash_warn_threshold?: number | null
  }
  /** Онлайн-заказы с сайта (051). Отсутствие ключа = включено. */
  online_orders?: {
    enabled?: boolean
    /** Пауза приёма с кассы (054), ISO; истёкшая/null = паузы нет */
    paused_until?: string | null
    /** Время приготовления, минуты — гость видит при заказе (054) */
    prep_minutes?: number | null
    /**
     * Типы заказа, доступные гостю (058): 'here' | 'takeaway' | 'delivery'.
     * Отсутствие/пусто = ['here','takeaway'] (дефолт, зеркало БД).
     */
    order_types?: ('here' | 'takeaway' | 'delivery')[]
    // Ссылки в подвале гостевой страницы (пусто/null = не показывать)
    instagram?: string | null
    facebook?: string | null
    google_review?: string | null
    // Оформление главного экрана гостевой страницы (фото в Storage)
    /** Баннер-шапка сверху; логотип и название накладываются поверх */
    header_url?: string | null
    /** Фон главного экрана; шапка и плитки — поверх */
    background_url?: string | null
  }
  /** Бронирование столов с сайта (053). Отсутствие ключа = ВЫКЛЮЧЕНО. */
  reservations?: {
    enabled?: boolean
    /** Часы приёма гостей, 'HH:MM' локального времени (059). Обе заданы =
     *  слоты на гостевой странице и submit_reservation ограничены окном. */
    open?: string | null
    close?: string | null
    /** Шаг слота времени на гостевой странице, мин (по умолчанию 15) */
    slot_min?: number | null
  }
}

export interface Location {
  id: string
  org_id: string
  name: string
  currency: string
  vat_rate: number
  timezone: string
  service_mode: ServiceMode
  // Реквизиты для чека (все необязательные)
  receipt_business_name: string | null
  receipt_address: string | null
  receipt_tax_id: string | null
  receipt_phone: string | null
  receipt_footer: string | null
  /** Логотип заведения (052) — аватар в настройках и на странице заказа */
  logo_url: string | null
  // Программа лояльности (031)
  loyalty_mode: 'off' | 'stamps' | 'points'
  loyalty_stamps_goal: number
  loyalty_points_percent: number
  loyalty_points_min_redeem: number
  // Мелкие настройки точки (036): права, опции чека, смена
  settings: LocationSettings
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
  /** Токен серверной сессии (044); optional — сессии до обновления его не имеют */
  session_token?: string | null
}

// ── Каталог ──────────────────────────────────────────────
// Все цены — целые агороты (см. lib/money.ts)

export type TableStatus = 'free' | 'reserved' | 'disabled'
export type TableShape = 'square' | 'circle'

export interface Table {
  id: string
  org_id: string
  location_id: string
  label: string
  zone: string | null
  sort_order: number
  is_active: boolean
  status: TableStatus
  pos_x: number | null   // 0..100, % от ширины холста; null = не размещён
  pos_y: number | null   // 0..100, % от высоты холста
  width: number          // % от ширины холста
  height: number         // % от высоты холста
  shape: TableShape
  created_at: string
}

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
  icon: string | null
  sort_order: number
  is_active: boolean
  loyalty_stamps: boolean
}

export interface MenuItem {
  id: string
  org_id: string
  category_id: string
  station_id: string | null
  name: string
  description: string | null
  price: number
  image_url: string | null
  is_available: boolean
  is_favorite: boolean
  ask_modifiers: boolean
  sort_order: number
  cost: number | null
  sku: string | null
  track_inventory: boolean
  stock: number | null
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
