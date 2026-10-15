import { describe, expect, it } from 'vitest'
import {
  browserMenuLang,
  localizeMenu,
  localizeMenuName,
  menuLanguages,
  menuNames,
  preferredMenuLang,
  relabelLine,
  resolveMenuLang,
} from './menuLocale'
import type { PublicMenu } from './publicApi'

const menu: PublicMenu = {
  location: {
    id: 'loc', name: 'בולוצ׳קה', currency: 'ILS', is_open: true, languages: ['he', 'en', 'ru'],
  },
  categories: [{
    id: 'hot',
    name: 'משקאות חמים',
    translations: { en: { name: 'Hot drinks' }, ru: { name: 'Горячие напитки' } },
    items: [{
      id: 'cap',
      name: 'קפוצ׳ינו',
      description: 'אספרסו וקצף חלב',
      price: 1400,
      image_url: null,
      translations: { en: { name: 'Cappuccino', description: 'Espresso and milk foam' }, ru: { name: 'Капучино' } },
      variants: [{ id: 'small', name: 'קטן', price: 1400, is_default: true, translations: { en: { name: 'Small' } } }],
      modifier_groups: [{
        id: 'milk', name: 'חלב', min_select: 0, max_select: 1,
        translations: { en: { name: 'Milk' } },
        modifiers: [{ id: 'oat', name: 'שיבולת שועל', price_delta: 200, is_default: false, translations: { en: { name: 'Oat' } } }],
      }],
    }, {
      id: 'tropic',
      name: 'Тропическое',
      description: null,
      price: 1800,
      image_url: null,
      translations: { he: { name: 'הטרופית' } },
      variants: [],
      modifier_groups: [],
    }],
  }],
}

describe('menuLanguages', () => {
  it('иврит всегда, остальные — как включил владелец, в порядке переключателя', () => {
    expect(menuLanguages({ ...menu.location, languages: ['ru', 'en'] })).toEqual(['he', 'en', 'ru'])
    expect(menuLanguages({ ...menu.location, languages: ['ru'] })).toEqual(['he', 'ru'])
  })

  it('старая edge function без поля — только иврит', () => {
    expect(menuLanguages({ ...menu.location, languages: undefined })).toEqual(['he'])
    expect(menuLanguages(undefined)).toEqual(['he'])
  })
})

describe('browserMenuLang', () => {
  it('иврит в списке телефона побеждает английский', () => {
    expect(browserMenuLang(['en-US', 'he-IL'])).toBe('he')
    expect(browserMenuLang(['iw'])).toBe('he')
  })

  it('русский первым — выбор человека, даже если иврит тоже есть', () => {
    expect(browserMenuLang(['ru-RU', 'he-IL'])).toBe('ru')
    expect(browserMenuLang(['de-DE', 'ru'])).toBe('ru')
  })

  it('турист без иврита и русского получает английский', () => {
    expect(browserMenuLang(['en-GB'])).toBe('en')
    expect(browserMenuLang(['fr-FR', 'de'])).toBe('en')
    expect(browserMenuLang(['en', 'ru'])).toBe('en')
  })

  it('пустой список — без догадки', () => {
    expect(browserMenuLang([])).toBeNull()
    expect(browserMenuLang([''])).toBeNull()
  })
})

describe('preferredMenuLang и resolveMenuLang', () => {
  const base = { query: null, kiosk: false, stored: null, browser: ['en-US'] }

  it('ссылка сильнее памяти, память сильнее телефона', () => {
    expect(preferredMenuLang({ ...base, query: 'ru', stored: 'en' })).toEqual({ lang: 'ru', explicit: true })
    expect(preferredMenuLang({ ...base, stored: 'ru' })).toEqual({ lang: 'ru', explicit: true })
    expect(preferredMenuLang(base)).toEqual({ lang: 'en', explicit: false })
  })

  it('киоск не помнит прошлого гостя и не слушает язык планшета', () => {
    expect(preferredMenuLang({ ...base, kiosk: true, stored: 'ru' })).toEqual({ lang: null, explicit: false })
    expect(preferredMenuLang({ ...base, kiosk: true, query: 'en' })).toEqual({ lang: 'en', explicit: true })
  })

  it('язык, который точка не включила, заменяется ивритом', () => {
    expect(resolveMenuLang({ lang: 'ru', explicit: true }, ['he', 'en'])).toBe('he')
    expect(resolveMenuLang({ lang: 'en', explicit: false }, ['he', 'en'])).toBe('en')
    expect(resolveMenuLang({ lang: null, explicit: false }, ['he', 'en'])).toBe('he')
  })

  it('до загрузки меню — только явный выбор, без догадки по телефону', () => {
    expect(resolveMenuLang({ lang: 'en', explicit: true }, null)).toBe('en')
    expect(resolveMenuLang({ lang: 'en', explicit: false }, null)).toBe('he')
  })
})

describe('localizeMenu', () => {
  it('переводит категории, блюда, размеры, группы и добавки', () => {
    const en = localizeMenu(menu, 'en')
    const item = en.categories[0].items[0]
    expect(en.categories[0].name).toBe('Hot drinks')
    expect(item.name).toBe('Cappuccino')
    expect(item.description).toBe('Espresso and milk foam')
    expect(item.variants[0].name).toBe('Small')
    expect(item.modifier_groups[0].name).toBe('Milk')
    expect(item.modifier_groups[0].modifiers[0].name).toBe('Oat')
  })

  it('без перевода название остаётся ивритским, а описание скрывается', () => {
    const item = localizeMenu(menu, 'ru').categories[0].items[0]
    expect(item.name).toBe('Капучино')
    expect(item.description).toBeNull()
    expect(item.variants[0].name).toBe('קטן')
  })

  it('на иврите — базовый каталог и ивритская правка для чужого базового имени', () => {
    const he = localizeMenu(menu, 'he')
    expect(he.categories[0].items[0].description).toBe('אספרסו וקצף חלב')
    expect(he.categories[0].items[1].name).toBe('הטרופית')
  })

  it('цены и id не меняются', () => {
    const item = localizeMenu(menu, 'en').categories[0].items[0]
    expect(item.id).toBe('cap')
    expect(item.price).toBe(1400)
    expect(item.modifier_groups[0].modifiers[0].price_delta).toBe(200)
  })
})

describe('отправленные строки и ошибки', () => {
  it('relabelLine берёт название текущего языка по id и держит сохранённое для исчезнувшего', () => {
    const names = menuNames(localizeMenu(menu, 'en'))
    expect(relabelLine({
      itemId: 'cap', name: 'קפוצ׳ינו', variantId: 'small', variantName: 'קטן',
      modIds: ['oat', 'gone'], modNames: ['שיבולת שועל', 'סירופ'], qty: 1,
    }, names)).toEqual({
      itemId: 'cap', name: 'Cappuccino', variantId: 'small', variantName: 'Small',
      modIds: ['oat', 'gone'], modNames: ['Oat', 'סירופ'], qty: 1,
    })
  })

  it('localizeMenuName переводит базовое имя позиции и группы из ошибки сервера', () => {
    expect(localizeMenuName(menu, 'en', 'קפוצ׳ינו')).toBe('Cappuccino')
    expect(localizeMenuName(menu, 'en', 'חלב')).toBe('Milk')
    expect(localizeMenuName(menu, 'en', 'לא בתפריט')).toBe('לא בתפריט')
    expect(localizeMenuName(menu, 'en', undefined)).toBeUndefined()
  })
})
