import { LANGS, type Lang } from '../../lib/i18n'
import type { PublicMenu, PublicTranslations } from './publicApi'

/**
 * Языки QR-меню (184).
 *
 * Каталог хранится на языке заведения (иврит), переводы лежат рядом в
 * translations. Меню переводится ОДИН раз после загрузки: дальше карточки,
 * поиск, корзина и её сверка работают с обычными name/description и не
 * знают о языках. Сервер снапшотит заказ из базовых названий, поэтому на
 * кассе, в тикетах и чеках заказ остаётся на иврите.
 */

const STORAGE_KEY = 'kassa-public-lang'

/** Языки меню точки по порядку переключателя; без поля — только иврит. */
export function menuLanguages(location: PublicMenu['location'] | undefined): Lang[] {
  const enabled = location?.languages ?? []
  return LANGS.filter((lang) => lang === 'he' || enabled.includes(lang))
}

/**
 * Язык телефона → язык меню. Иврит в списке языков телефона побеждает
 * английский: многие израильтяне держат телефон на английском, но меню
 * читают в оригинале. Русский первым языком — сознательный выбор
 * человека, его уважаем. Остальные (турист с немецким телефоном) получают
 * английский: он ближе им, чем иврит.
 */
export function browserMenuLang(tags: readonly string[]): Lang | null {
  const primary = tags
    .map((tag) => tag.trim().toLowerCase().split(/[-_]/)[0])
    .filter(Boolean)
  if (primary.length === 0) return null
  if (primary[0] === 'ru') return 'ru'
  if (primary.includes('he') || primary.includes('iw')) return 'he'
  const ru = primary.indexOf('ru')
  const en = primary.indexOf('en')
  if (ru !== -1 && (en === -1 || ru < en)) return 'ru'
  return 'en'
}

export function readStoredMenuLang(): Lang | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'he' || value === 'en' || value === 'ru' ? value : null
  } catch {
    return null
  }
}

export function storeMenuLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // Приватный режим Safari: язык просто не запомнится
  }
}

export interface MenuLangChoice {
  lang: Lang | null
  /** Гость выбрал сам (ссылка, прошлый выбор, переключатель), а не догадка по телефону */
  explicit: boolean
}

/**
 * Начальное предпочтение гостя: ссылка → память браузера → телефон.
 * Киоск — общее устройство: язык прошлого гостя и язык самого планшета
 * следующему гостю ничего не говорят, поэтому там только ссылка.
 */
export function preferredMenuLang(options: {
  query: Lang | null
  kiosk: boolean
  stored: Lang | null
  browser: readonly string[]
}): MenuLangChoice {
  if (options.query) return { lang: options.query, explicit: true }
  if (options.kiosk) return { lang: null, explicit: false }
  if (options.stored) return { lang: options.stored, explicit: true }
  return { lang: browserMenuLang(options.browser), explicit: false }
}

/**
 * Язык, на котором страница говорит сейчас. Язык, который точка не
 * включила, заменяем ивритом. Пока меню не пришло, языки точки неизвестны:
 * явный выбор гостя уважаем сразу (ошибку загрузки он прочтёт на своём),
 * а догадку по телефону — только после загрузки, иначе у заведения без
 * английского скелетон успевал бы мигнуть слева направо.
 */
export function resolveMenuLang(choice: MenuLangChoice, available: readonly Lang[] | null): Lang {
  if (!choice.lang) return 'he'
  if (!available) return choice.explicit ? choice.lang : 'he'
  return available.includes(choice.lang) ? choice.lang : 'he'
}

function translatedName(base: string, translations: PublicTranslations | undefined, lang: Lang): string {
  return translations?.[lang]?.name ?? base
}

/**
 * Меню на языке гостя. Непереведённое название остаётся ивритским — иначе
 * блюдо не выбрать. Непереведённое описание на английском и русском
 * скрывается: ивритский абзац под английским названием туристу только мешает.
 */
export function localizeMenu(menu: PublicMenu, lang: Lang): PublicMenu {
  return {
    ...menu,
    categories: menu.categories.map((category) => ({
      ...category,
      name: translatedName(category.name, category.translations, lang),
      items: category.items.map((item) => ({
        ...item,
        name: translatedName(item.name, item.translations, lang),
        description: item.translations?.[lang]?.description
          ?? (lang === 'he' ? item.description : null),
        variants: item.variants.map((variant) => ({
          ...variant,
          name: translatedName(variant.name, variant.translations, lang),
        })),
        modifier_groups: item.modifier_groups.map((group) => ({
          ...group,
          name: translatedName(group.name, group.translations, lang),
          modifiers: group.modifiers.map((modifier) => ({
            ...modifier,
            name: translatedName(modifier.name, modifier.translations, lang),
          })),
        })),
      })),
    })),
  }
}

export interface MenuNames {
  item: Map<string, string>
  variant: Map<string, string>
  modifier: Map<string, string>
}

/** Названия текущего (уже переведённого) меню по id — для отправленных строк. */
export function menuNames(menu: PublicMenu | undefined): MenuNames {
  const names: MenuNames = { item: new Map(), variant: new Map(), modifier: new Map() }
  for (const category of menu?.categories ?? []) {
    for (const item of category.items) {
      names.item.set(item.id, item.name)
      for (const variant of item.variants) names.variant.set(variant.id, variant.name)
      for (const group of item.modifier_groups) {
        for (const modifier of group.modifiers) names.modifier.set(modifier.id, modifier.name)
      }
    }
  }
  return names
}

interface LabelledLine {
  itemId: string
  name: string
  variantId: string | null
  variantName: string | null
  modIds: string[]
  modNames: string[]
}

/**
 * Уже отправленные строки хранят названия на языке момента отправки (а
 * сервер — на языке заведения). Показываем их на текущем языке; если
 * позиции больше нет в меню, остаётся сохранённое название.
 */
export function relabelLine<T extends LabelledLine>(line: T, names: MenuNames): T {
  return {
    ...line,
    name: names.item.get(line.itemId) ?? line.name,
    variantName: line.variantId
      ? names.variant.get(line.variantId) ?? line.variantName
      : line.variantName,
    modNames: line.modIds.map((id, index) => names.modifier.get(id) ?? line.modNames[index] ?? ''),
  }
}

/**
 * Ошибка заказа называет позицию или группу добавок базовым именем
 * (item_unavailable: <имя>). Переводим его, если узнаём.
 */
export function localizeMenuName(menu: PublicMenu | undefined, lang: Lang, name: string | undefined): string | undefined {
  if (!menu || !name) return name
  for (const category of menu.categories) {
    for (const item of category.items) {
      if (item.name === name) return translatedName(name, item.translations, lang)
      for (const group of item.modifier_groups) {
        if (group.name === name) return translatedName(name, group.translations, lang)
      }
    }
  }
  return name
}
