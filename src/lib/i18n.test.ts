import { describe, it, expect } from 'vitest'
import { translations } from './i18n'

/**
 * P11: ru и he должны иметь ОДИНАКОВЫЙ набор ключей. TranslationKey =
 * keyof translations.ru проверяет только вызовы t(), но не то, что перевод
 * есть на обоих языках. Этот тест ловит забытый he/ru ключ (пустой экран
 * иврита на проде).
 */
describe('i18n паритет ключей ru/he', () => {
  const ruKeys = Object.keys(translations.ru).sort()
  const heKeys = Object.keys(translations.he).sort()

  it('в he нет пропущенных ключей относительно ru', () => {
    const missingInHe = ruKeys.filter((k) => !(k in translations.he))
    expect(missingInHe).toEqual([])
  })

  it('в ru нет пропущенных ключей относительно he', () => {
    const missingInRu = heKeys.filter((k) => !(k in translations.ru))
    expect(missingInRu).toEqual([])
  })

  it('количество ключей совпадает', () => {
    expect(ruKeys.length).toBe(heKeys.length)
  })
})
