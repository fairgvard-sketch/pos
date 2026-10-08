/**
 * Курсы подачи на счёте стола (179). Клиентское зеркало правила
 * удержания из append_to_order_impl: касса считает его сама, чтобы
 * печатать кухне только то, что уходит сейчас, и показывать офлайн-эхо.
 * Источник истины для экрана кухни — сервер.
 */

export const COURSES = [1, 2, 3] as const

type WithCourse = { course?: number | null }

/** Курс из каталога или payload: 1–3, иначе «без курса» */
export function normalizeCourse(c: unknown): number | null {
  return c === 1 || c === 2 || c === 3 ? c : null
}

/** Тап по чипу курса: без курса → 1 → 2 → 3 → без курса */
export function nextCourse(c: number | null | undefined): number | null {
  const n = normalizeCourse(c)
  return n === null ? 1 : n === 3 ? null : n + 1
}

/**
 * Какие строки отправки придержать до Fire. Строка курса c >= 2 ждёт,
 * если в счёте (уже заказанное + эта же отправка) есть строка более
 * раннего курса. Нет закуски — горячее уходит сразу.
 * existing — только активные строки счёта, снятые не передавать.
 */
export function heldLineKeys<T extends WithCourse & { key: string }>(
  existing: WithCourse[],
  lines: T[],
): Set<string> {
  const courses = [...existing, ...lines]
    .map((l) => normalizeCourse(l.course))
    .filter((c): c is number => c !== null)
  const earliest = courses.length > 0 ? Math.min(...courses) : null
  const held = new Set<string>()
  if (earliest === null) return held
  for (const l of lines) {
    const c = normalizeCourse(l.course)
    if (c !== null && c >= 2 && c > earliest) held.add(l.key)
  }
  return held
}

/** Самый ранний курс среди придержанного — его Fire отправит без выделения */
export function nextHeldCourse(lines: (WithCourse & { held: boolean })[]): number | null {
  const courses = lines
    .filter((l) => l.held)
    .map((l) => normalizeCourse(l.course))
    .filter((c): c is number => c !== null)
  return courses.length > 0 ? Math.min(...courses) : null
}

/**
 * Что отправит Fire: выделенные официантом придержанные строки, а без
 * выделения — весь самый ранний придержанный курс (типичный случай:
 * гость доел закуску — подаём горячее одним тапом).
 */
export function fireTargets<T extends WithCourse & { id: string; held: boolean }>(
  lines: T[],
  selected: ReadonlySet<string>,
): T[] {
  const held = lines.filter((l) => l.held)
  const picked = held.filter((l) => selected.has(l.id))
  if (picked.length > 0) return picked
  const course = nextHeldCourse(held)
  return held.filter((l) => normalizeCourse(l.course) === course)
}
