import type { PublicMenu } from './publicApi'
import type { StoredPublicCartLine } from './publicCart'

/**
 * Сверка восстановленной корзины с текущим меню.
 *
 * Корзина живёт в localStorage до 6 часов и хранит СНАПШОТ цен. За это
 * время товар может подорожать, исчезнуть или изменить доступный состав.
 * Сверяем после получения меню, в том числе при его повторной загрузке.
 * Это UX-проверка, не замена серверной валидации заказа.
 *
 * Что делаем:
 *   • позиции, которых больше нет в меню, — убираем;
 *   • у оставшихся обновляем цену и названия на актуальные;
 *   • сообщаем вызывающему, что именно изменилось, — чтобы показать это
 *     гостю, а не менять корзину молча.
 */

export interface ReconcileResult<T> {
  /** Исходный массив по ссылке, если строки не изменились */
  lines: T[]
  /** Названия убранных позиций — для сообщения гостю */
  removed: string[]
  /** Цена изменилась хотя бы у одной строки */
  repriced: boolean
}

/** Не выбираем новый размер/добавку за гостя, даже при наличии default. */
function currentSelection(
  item: PublicMenu['categories'][number]['items'][number],
  variantId: string | null,
  modIds: string[],
): Pick<StoredPublicCartLine, 'unitPrice' | 'variantName' | 'modNames'> | null {
  let base = item.price
  let variantName: string | null = null
  if (variantId !== null) {
    const variant = item.variants.find((v) => v.id === variantId)
    // Вариант исчез (например, «большой» сняли) — строка невалидна
    if (!variant) return null
    base = variant.price
    variantName = variant.name
  } else if (item.variants.length > 0) {
    // Раньше размеров не было: теперь требуется новый выбор гостя.
    return null
  }
  const selected = new Set(modIds)
  if (selected.size !== modIds.length) return null
  for (const group of item.modifier_groups) {
    const count = group.modifiers.filter((mod) => selected.has(mod.id)).length
    if (count < group.min_select || (group.max_select > 0 && count > group.max_select)) return null
  }
  const mods = item.modifier_groups.flatMap((g) => g.modifiers)
  let delta = 0
  const modNames: string[] = []
  for (const id of modIds) {
    const mod = mods.find((m) => m.id === id)
    // Модификатор исчез — не додумываем состав за гостя
    if (!mod) return null
    delta += mod.price_delta
    modNames.push(mod.name)
  }
  return { unitPrice: base + delta, variantName, modNames }
}

export function reconcileCart<T extends StoredPublicCartLine>(
  lines: T[],
  menu: PublicMenu,
): ReconcileResult<T> {
  const items = new Map(
    menu.categories.flatMap((c) => c.items).map((item) => [item.id, item]),
  )

  const next: T[] = []
  const removed: string[] = []
  let repriced = false

  for (const line of lines) {
    const item = items.get(line.itemId)
    if (!item) {
      removed.push(line.name)
      continue
    }

    const selection = currentSelection(item, line.variantId, line.modIds)
    if (selection === null) {
      removed.push(line.name)
      continue
    }

    if (selection.unitPrice !== line.unitPrice || item.name !== line.name
      || selection.variantName !== line.variantName
      || selection.modNames.length !== line.modNames.length
      || selection.modNames.some((name, index) => name !== line.modNames[index])) {
      if (selection.unitPrice !== line.unitPrice) repriced = true
      next.push({ ...line, name: item.name, ...selection })
      continue
    }

    next.push(line)
  }

  const unchanged = next.length === lines.length && next.every((line, index) => line === lines[index])
  return { lines: unchanged ? lines : next, removed, repriced }
}
