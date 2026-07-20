/**
 * Чистые сортировки очереди бариста (087). Вынесены из QueuePage,
 * чтобы тестировать без supabase-клиента.
 *
 * Оба порядка стабильны вручную (тай-брейк индексом): Array.sort
 * в старых WebView (Chrome < 70 на T2) нестабилен.
 */

interface QueueOrderLike {
  created_at: string
  is_urgent?: boolean
}

interface StationItemLike {
  station_id: string | null
}

/** Карточки: срочные первыми, внутри групп — FIFO по created_at */
export function sortQueueOrders<T extends QueueOrderLike>(orders: T[]): T[] {
  const indexed = orders.map((order, i) => ({ order, i }))
  indexed.sort(
    (a, b) =>
      Number(b.order.is_urgent ?? false) - Number(a.order.is_urgent ?? false) ||
      a.order.created_at.localeCompare(b.order.created_at) ||
      a.i - b.i
  )
  return indexed.map((x) => x.order)
}

/**
 * Строки карточки в порядке станций (Меню → Станции задаёт очередность
 * позиций для кухни). Позиции без станции — в конец, внутри станции
 * сохраняется порядок добавления в заказ.
 */
export function sortItemsByStation<T extends StationItemLike>(
  items: T[],
  stations: { id: string }[]
): T[] {
  if (stations.length === 0) return items
  const rank = new Map(stations.map((s, i) => [s.id, i]))
  const rankOf = (it: StationItemLike) =>
    it.station_id !== null ? (rank.get(it.station_id) ?? stations.length) : stations.length
  const indexed = items.map((item, i) => ({ item, i }))
  indexed.sort((a, b) => rankOf(a.item) - rankOf(b.item) || a.i - b.i)
  return indexed.map((x) => x.item)
}
