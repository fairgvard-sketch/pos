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
  /**
   * Тумблеры интерфейса POS под конкретную точку/клиента (069). Касса
   * тиражируется как продукт — одни заведения хотят видеть элемент, другие
   * нет, при едином коде. Отсутствие ключа = дефолт (обычно «показывать»).
   */
  interface?: {
    /** Чип-фильтр «Все товары» над витриной на экране продажи.
     *  Отсутствие ключа = показывать (обратная совместимость). */
    show_all_items_tab?: boolean
    /** Учёт остатков: раздел «Склад», списание дня и учёт в карточке товара.
     *  Отсутствие ключа = включено. Тумблер скрывает интерфейс; серверные
     *  триггеры продолжают вести уже учитываемые товары. */
    inventory_enabled?: boolean
  }
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
    /** Граница операционного дня, 'HH:MM'; null/пусто = 04:00 (overdue-смены) */
    day_cutoff?: string | null
  }
  /** Онлайн-заказы с сайта (051). Отсутствие ключа = включено. */
  online_orders?: {
    enabled?: boolean
    /** Пауза приёма с кассы (054), ISO; истёкшая/null = паузы нет */
    paused_until?: string | null
    /** Время приготовления, минуты — гость видит при заказе (054, legacy).
     *  С 061 заменено вилкой prep_min/prep_max; читается как min=max. */
    prep_minutes?: number | null
    /** Время приготовления — нижняя/верхняя граница вилки, минуты (061) */
    prep_min?: number | null
    prep_max?: number | null
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
    /** Название в шапке гостевой страницы (062); пусто/null = имя точки/чека */
    display_name?: string | null
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
    /** Макс. гостей в одной брони (061; по умолчанию 20, потолок 50) */
    max_party?: number | null
    /** Точный адрес заведения для гостя (062): текст, показывается под
     *  названием + кнопка «Навигация». Пусто = берём адрес из реквизитов чека. */
    address?: string | null
    /** Координаты пина (062): заданы → «Навигация» открывает точную точку
     *  (query=lat,lng), а не текстовый поиск. */
    lat?: number | null
    lng?: number | null
    /** Название в шапке страницы брони — своё, не общее с онлайн-заказом.
     *  Пусто/null = display_name точки → имя из чека → имя точки. */
    display_name?: string | null
    /** Фото-шапка страницы брони (066) — своя, не общая с онлайн-заказом.
     *  Пусто = fallback на header_url онлайн-заказа, затем логотип. */
    header_url?: string | null
    /** Часы работы заведения (066): свободный текст в подвале страницы
     *  брони (напр. «Вс–Чт 8:00–22:00, Пт 8:00–14:00»). Пусто = не показывать. */
    hours?: string | null
    /** Соцссылки в подвале страницы брони (066). Пусто/null = кнопки нет. */
    instagram?: string | null
    facebook?: string | null
    google_review?: string | null
    /** Мгновенное подтверждение (063, Ontopo-стиль): гость видит live-
     *  доступность, бронь сразу confirmed с подобранным столом. Иначе —
     *  заявка new→касса подтверждает вручную. Дефолт off. */
    instant?: boolean
    /** Разрешить объединять combinable-столы под большие компании (063). */
    combine?: boolean
    /** Длительность визита по умолчанию, мин (063; дефолт 90) — окно занятости. */
    duration_min?: number
    /** Буфер между бронями на столе, мин (063; дефолт 0) — уборка/подготовка. */
    buffer_min?: number
    /** Требовать депозит (063, ПЛЕЙСХОЛДЕР — без реальной оплаты пока). */
    deposit_required?: boolean
    /** Сумма депозита, агороты (063, плейсхолдер). */
    deposit_amount?: number
    /** Депозит требуется от N гостей (063; дефолт 1 = со всех). */
    deposit_from_party?: number
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
  device_uuid: string | null
  auth_user_id: string | null
  settings: Record<string, unknown>
  app_version: string | null
  webview_version: string | null
  printer_capabilities: Record<string, unknown> | null
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

export interface TableZone {
  id: string
  org_id: string
  location_id: string
  name: string
  sort_order: number
  is_active: boolean
  created_at: string
}

export interface Table {
  id: string
  org_id: string
  location_id: string
  label: string
  zone: string | null
  /** Нормализованная зона плана; zone остаётся текстовым снимком для совместимости */
  zone_id: string | null
  sort_order: number
  is_active: boolean
  /** Вместимость стола, гостей (063; дефолт 2) — движок брони */
  seats: number
  /** Можно ли складывать с соседними (063; дефолт false) */
  combinable: boolean
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
  /** Обложка плитки категории в онлайн-меню (080). NULL = фото первого товара. */
  cover_url: string | null
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
  variant_supplies?: VariantSupply[]
}

/** Упаковка (075): расходник, который продажа списывает вместе с товаром */
export interface VariantSupply {
  id: string
  /** null = любой вариант товара */
  variant_id: string | null
  supply_item_id: string
  qty: number
  /** true = списывать только для заказов с собой/доставки */
  takeaway_only: boolean
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
