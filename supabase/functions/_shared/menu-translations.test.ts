import { describe, expect, it } from 'vitest'
import { guestLanguages, publicTranslations } from './menu-translations'

describe('publicTranslations', () => {
  it('отдаёт только известные языки и поля', () => {
    expect(publicTranslations({
      en: { name: 'Cappuccino', description: 'Espresso and milk', extra: 'x' },
      ru: { name: 'Капучино' },
      fr: { name: 'Cappuccino' },
    }, true)).toEqual({
      en: { name: 'Cappuccino', description: 'Espresso and milk' },
      ru: { name: 'Капучино' },
    })
  })

  it('описание — только у блюда', () => {
    expect(publicTranslations({ en: { name: 'Milk', description: 'Fresh' } })).toEqual({
      en: { name: 'Milk' },
    })
  })

  it('пустой или битый перевод не попадает в ответ', () => {
    expect(publicTranslations({})).toBeUndefined()
    expect(publicTranslations(null)).toBeUndefined()
    expect(publicTranslations(['en'])).toBeUndefined()
    expect(publicTranslations({ en: { name: '  ' }, ru: 'Капучино' })).toBeUndefined()
  })
})

describe('guestLanguages', () => {
  it('иврит всегда первым, затем включённые в порядке переключателя', () => {
    expect(guestLanguages(['ru', 'en'])).toEqual(['he', 'en', 'ru'])
    expect(guestLanguages(['ru'])).toEqual(['he', 'ru'])
  })

  it('без настройки и с мусором — только иврит', () => {
    expect(guestLanguages(undefined)).toEqual(['he'])
    expect(guestLanguages('en')).toEqual(['he'])
    expect(guestLanguages(['he', 'fr', 'en', 'en'])).toEqual(['he', 'en'])
  })
})
