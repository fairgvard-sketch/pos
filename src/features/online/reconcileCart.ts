import type { PublicMenu } from './publicApi'
import type { StoredPublicCartLine } from './publicCart'

/**
 * Сверка восстановленной корзины с текущим меню.
 *
 * Корзина живёт в localStorage до 6 часов и хранит СНАПШОТ цен. За это
 * время товар может подорожать или исчезнуть из меню. Сервер это поймает
 * (submit_online_order пересчитывает сам и вернёт item_unavailable), но
 * гость узнает о проблеме на последнем шаге — уже заполнив контакты.
 * Поэтому сверяем сразу после загрузки меню.
 *
 * Что делаем:
 *   • позиции, которых больше нет в меню, — убираем;
 *   • у оставшихся обновляем цену и названия на актуальные;
 *   • сообщаем вызывающему, что именно изменилось, — чтобы показать это
 *     гостю, а не менять корзину молча.
 */

export interface ReconcileResult<T> {
  lines: T[]
  /** Названия убранных позиций — для сообщения гостю */
  removed: string[]
  /** Цена изменилась хотя бы у одной строки */
  repriced: boolean
}

/** Актуальная цена строки: вариант, если выбран, иначе базовая + модификаторы */
function currentUnitPrice(
  item: PublicMenu['categories'][number]['items'][number],
  variantId: string | null,
  modIds: string[],
): number | null {
  let base = item.price
  if (variantId) {
    const variant = item.variants.find((v) => v.id === variantId)
    // Вариант исчез (например, «большой» сняли) — строка невалидна
    if (!variant) return null
    base = variant.price
  }
  const mods = item.modifier_groups.flatMap((g) => g.modifiers)
  let delta = 0
  for (const id of modIds) {
    const mod = mods.find((m) => m.id === id)
    // Модификатор исчез — не додумываем состав за гостя
    if (!mod) return null
    delta += mod.price_delta
  }
  return base + delta
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

    const price = currentUnitPrice(item, line.variantId, line.modIds)
    if (price === null) {
      removed.push(line.name)
      continue
    }

    if (price !== line.unitPrice || item.name !== line.name) {
      if (price !== line.unitPrice) repriced = true
      next.push({ ...line, name: item.name, unitPrice: price })
      continue
    }

    next.push(line)
  }

  return { lines: next, removed, repriced }
}
