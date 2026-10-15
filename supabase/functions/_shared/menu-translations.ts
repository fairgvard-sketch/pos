/**
 * Переводы QR-меню (184) в публичном ответе public-menu.
 *
 * База хранит переводы уже нормализованными (триггер 184), но наружу
 * отдаём только то, что гостю положено: известные языки и поля. Пустой
 * объект не отправляем вовсе — у непереведённого каталога ответ не растёт.
 */

export type MenuLang = 'he' | 'en' | 'ru'
export type PublicTranslations = Partial<Record<MenuLang, { name?: string; description?: string }>>

const LANGS: readonly MenuLang[] = ['he', 'en', 'ru']

/** Языки, которые владелец может включить гостю; иврит включён всегда. */
const OPTIONAL_LANGS: readonly MenuLang[] = ['en', 'ru']

export function publicTranslations(
  raw: unknown,
  withDescription = false,
): PublicTranslations | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const out: PublicTranslations = {}
  for (const lang of LANGS) {
    const entry = source[lang]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const fields = entry as Record<string, unknown>
    const clean: { name?: string; description?: string } = {}
    if (typeof fields.name === 'string' && fields.name.trim()) clean.name = fields.name.trim()
    if (withDescription && typeof fields.description === 'string' && fields.description.trim()) {
      clean.description = fields.description.trim()
    }
    if (clean.name || clean.description) out[lang] = clean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Языки гостя: иврит первым, затем включённые владельцем в порядке
 * переключателя. Мусор и повторы в настройке отбрасываются.
 */
export function guestLanguages(setting: unknown): MenuLang[] {
  const enabled = Array.isArray(setting) ? setting : []
  return ['he', ...OPTIONAL_LANGS.filter((lang) => enabled.includes(lang))]
}
