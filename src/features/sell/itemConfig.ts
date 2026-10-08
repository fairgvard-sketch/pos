import type { MenuItem, ModifierGroup } from '../../types'
import type { CartLine, CartMod } from '../../store/cartStore'
import { normalizeCourse } from './courses'

/** Поля товара, нужные для добавления в заказ (касса и телефон официанта) */
export type SellableItem = Pick<MenuItem, 'id' | 'name' | 'price' | 'course' | 'item_variants' | 'menu_item_modifier_groups'>

/**
 * Курс подачи новой строки (179) — из каталога. Кэш меню до 179 поля не
 * знает: тогда ключа нет, и курс решит сервер, а не «без курса» кассы.
 */
export function courseOf(item: Pick<MenuItem, 'course'>): Pick<CartLine, 'course'> {
  return item.course === undefined ? {} : { course: normalizeCourse(item.course) }
}

/** Группы модификаторов товара в порядке привязки */
export function linkedGroups(item: Pick<MenuItem, 'menu_item_modifier_groups'>, all: ModifierGroup[]): ModifierGroup[] {
  const links = (item.menu_item_modifier_groups ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
  return links
    .map((l) => all.find((g) => g.id === l.group_id))
    .filter((g): g is ModifierGroup => !!g)
}

/** Нужен ли выбор размера/модификаторов перед добавлением */
export function needsPicker(item: Pick<MenuItem, 'ask_modifiers' | 'item_variants'>, groups: ModifierGroup[]): boolean {
  return item.ask_modifiers && (groups.length > 0 || (item.item_variants?.length ?? 0) > 0)
}

/** Дефолтная конфигурация товара — для добавления в 1 тап */
export function defaultConfig(item: SellableItem, groups: ModifierGroup[]) {
  const variants = (item.item_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
  const variant = variants.find((v) => v.is_default) ?? variants[0] ?? null
  const mods: CartMod[] = groups.flatMap((g) =>
    (g.modifiers ?? [])
      .filter((m) => m.is_default && m.is_available)
      .map((m) => ({ id: m.id, name: m.name, priceDelta: m.price_delta }))
  )
  return {
    itemId: item.id,
    name: item.name,
    variantId: variant?.id ?? null,
    variantName: variant?.name ?? null,
    basePrice: variant?.price ?? item.price,
    mods,
    notes: '',
    priceOverride: null,
    ...courseOf(item),
  }
}
