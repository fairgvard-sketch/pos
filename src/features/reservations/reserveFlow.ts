/**
 * Путь гостя по публичной брони и черновик его контактов.
 *
 * Вынесено из экрана намеренно: порядок шагов и правила валидации — это
 * логика, а не разметка. Пока они жили внутри компонента, «сколько
 * экранов у этой точки» приходилось проверять глазами через браузер.
 */

/**
 * Шаги гостевого сценария. Экран входа (дата и компания) в счёт не
 * входит: на нём ещё ничего не выбрано.
 */
export type ReserveStep = 'slot' | 'times' | 'rules' | 'details' | 'prepay'

/**
 * Путь гостя по настройкам точки. Один список — один источник правды и
 * для порядка экранов, и для кнопки «назад», и для индикатора прогресса.
 *
 * Линейного «всегда четыре экрана» не бывает: шаг правил (145) есть
 * только у точки, которая их завела, а шаг предоплаты (164) — только
 * там, где она настроена и провайдер здоров.
 *
 * Индикатор обязан считать по этому списку, а не по константе: гость
 * меряет оставшуюся работу делениями, и пустое деление под пропущенный
 * шаг — обещание экрана, которого не будет.
 */
export function reserveFlow({ hasRules, hasPrepay }: {
  hasRules: boolean
  hasPrepay: boolean
}): ReserveStep[] {
  const flow: ReserveStep[] = ['times']
  if (hasRules) flow.push('rules')
  flow.push('details')
  if (hasPrepay) flow.push('prepay')
  return flow
}

/** Номер шага в полосе прогресса (1-based); вне потока — 0 */
export function stepIndex(flow: ReserveStep[], step: ReserveStep): number {
  return flow.indexOf(step) + 1
}

/** Предыдущий экран; для первого шага — экран входа */
export function stepBefore(flow: ReserveStep[], step: ReserveStep): ReserveStep {
  const i = flow.indexOf(step)
  return i <= 0 ? 'slot' : flow[i - 1]
}

/** Следующий экран или null, если дальше отправка */
export function stepAfter(flow: ReserveStep[], step: ReserveStep): ReserveStep | null {
  const i = flow.indexOf(step)
  return i >= 0 && i < flow.length - 1 ? flow[i + 1] : null
}

/**
 * Черновик контактов гостя. Живёт выше экранов: возврат к времени и
 * повторный вход в форму не должны стирать набранное (163 — имя и
 * фамилия раздельно, почта обязательна).
 *
 * `extras` — не свободный текст, а набор отмеченных пожеланий. К заявке
 * они уезжают внутри той же `note`, которую читает хостес: отдельного
 * поля под них в брони нет, и заводить контрол, чьё значение никто
 * никогда не увидит, нельзя.
 */
export interface DetailsDraft {
  firstName: string
  lastName: string
  phone: string
  email: string
  note: string
  extras: string[]
}

export const EMPTY_DRAFT: DetailsDraft = {
  firstName: '', lastName: '', phone: '', email: '', note: '', extras: [],
}

/** Пожелания, которые гость отмечает галочкой вместо набора текста */
export const EXTRA_KEYS = ['birthday', 'high_chair', 'accessibility'] as const

/**
 * Почта: та же консервативная проверка, что и на сервере (163) — одна
 * собака, точка в домене, без пробелов. Полный разбор RFC 5322 здесь не
 * нужен: настоящую валидность адреса показывает только доставленное
 * письмо, а задача проверки — поймать опечатку до отправки формы.
 */
export function isEmailValid(value: string): boolean {
  const email = value.trim()
  return email.length > 0 && email.length <= 254
    && /^[^@\s]+@[^@\s]+\.[^@\s.]+$/.test(email)
}

export interface DraftErrors {
  firstName: boolean
  lastName: boolean
  phone: boolean
  email: boolean
}

export function draftErrors(draft: DetailsDraft): DraftErrors {
  return {
    firstName: draft.firstName.trim().length === 0,
    lastName: draft.lastName.trim().length === 0,
    // Тот же порог, что и у сервера: меньше девяти цифр — не телефон
    phone: draft.phone.replace(/\D/g, '').length < 9,
    email: !isEmailValid(draft.email),
  }
}

export function isDraftValid(draft: DetailsDraft): boolean {
  return !Object.values(draftErrors(draft)).some(Boolean)
}

/** Имя для кассы и выгрузок; сервер соберёт такое же (163) */
export function composeName(draft: DetailsDraft): string {
  return `${draft.firstName.trim()} ${draft.lastName.trim()}`.trim()
}

/**
 * Пожелания + комментарий в одну строку заметки. Порядок постоянный:
 * хостес читает её глазами, и «Детский стул · День рождения» не должно
 * менять вид от того, что гость нажал раньше.
 */
export function composeNote(
  draft: DetailsDraft, labels: Record<string, string>,
): string | null {
  const chosen = EXTRA_KEYS
    .filter((key) => draft.extras.includes(key))
    .map((key) => labels[key])
    .filter(Boolean)
  const text = draft.note.trim()
  const parts = [...chosen, text].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ').slice(0, 200) : null
}
