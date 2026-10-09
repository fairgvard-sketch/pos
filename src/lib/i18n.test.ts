import { describe, it, expect } from 'vitest'
import { translations, localeOf, formatTime, formatElapsedHm, LANGS, t } from './i18n'
import { formatMoney } from './money'

/**
 * P11: все языки интерфейса должны иметь ОДИНАКОВЫЙ набор ключей.
 * TranslationKey = keyof translations.ru проверяет только вызовы t(), но не
 * то, что перевод есть на каждом языке. Этот тест ловит забытый ключ
 * (пустой экран на проде).
 */
describe('i18n паритет ключей ru/he/en', () => {
  const ruKeys = Object.keys(translations.ru).sort()

  for (const lang of ['he', 'en'] as const) {
    it(`в ${lang} нет пропущенных и лишних ключей относительно ru`, () => {
      const keys = Object.keys(translations[lang]).sort()
      expect(ruKeys.filter((k) => !(k in translations[lang]))).toEqual([])
      expect(keys.filter((k) => !(k in translations.ru))).toEqual([])
    })
  }

  it('подстановки {n}, {days} и т.п. совпадают во всех языках', () => {
    const slots = (s: string) => (s.match(/\{[a-z]+\}/gi) ?? []).sort().join(',')
    const broken: string[] = []
    for (const k of ruKeys) {
      const ru = slots(translations.ru[k as keyof typeof translations.ru])
      for (const lang of ['he', 'en'] as const) {
        if (slots(translations[lang][k as keyof typeof translations.en]) !== ru) broken.push(`${lang}.${k}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('в английском нет кириллицы и пустых строк', () => {
    const bad = Object.entries(translations.en)
      .filter(([, v]) => /[А-Яа-яЁё]/.test(v) || v.trim() === '')
      .map(([k]) => k)
    expect(bad).toEqual([])
  })

  it('нижняя кнопка меню ведёт к заказу, а не описывает состав корзины', () => {
    expect(translations.ru.pubShowItems).toBe('Перейти к заказу')
    expect(translations.he.pubShowItems).toBe('המשך להזמנה')
    expect(translations.en.pubShowItems).toBe('Go to order')
  })
})

describe('язык интерфейса', () => {
  it('порядок переключателя: иврит, английский, русский', () => {
    expect(LANGS).toEqual(['he', 'en', 'ru'])
  })

  it('английский — день/месяц и 24 часа, как в Израиле', () => {
    expect(localeOf('en')).toBe('en-GB')
    expect(localeOf('he')).toBe('he-IL')
    expect(formatTime('2026-10-09T18:05:00Z', 'en')).toMatch(/^\d{2}:\d{2}$/)
  })

  it('сумма по-английски — точка в дробной части', () => {
    expect(formatMoney(125050, 'en')).toContain('1,250.50')
  })

  it('время за столом — чч:мм', () => {
    const now = Date.parse('2026-10-09T12:00:00Z')
    expect(formatElapsedHm('2026-10-09T11:48:00Z', now)).toBe('00:12')
    expect(formatElapsedHm('2026-10-09T10:40:00Z', now)).toBe('01:20')
    expect(formatElapsedHm('2026-10-09T12:05:00Z', now)).toBe('00:00')
  })

  it('t отдаёт перевод выбранного языка', () => {
    expect(t('en', 'save')).toBe('Save')
    expect(t('he', 'save')).toBe(translations.he.save)
  })
})
